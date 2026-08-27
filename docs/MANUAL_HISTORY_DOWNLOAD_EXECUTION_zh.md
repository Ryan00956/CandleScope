# 数据工作台手动连续历史下载执行文档

状态：设计冻结，尚未实现。

目标：在“设置 → 数据工作台”中交付一个可恢复、可审计的手动历史数据下载功能。用户只选择交易所/市场、多个商品、多个周期和一个开始时间；系统自动补全到任务封口时的最后一根已收盘 K 线。大范围历史优先使用交易所官方 ZIP 归档，小范围、归档尾部和失败区间使用 REST。自定义周期由可精确平铺的交易所原生基础周期合成。只有经过精确连续性验证的目标才能标记完成并获得持久化 GC 保护。

本文是执行合同，不是方向性建议。每个 Phase 都有明确修改范围、测试、退出门禁和回滚要求。后续实施不得跳过 Phase 2 的 GC 所有权基础直接开放下载入口。

---

## 1. 不可变产品合同

### 1.1 用户输入

公开表单和创建任务 API 只接受：

```text
exchange
market_type
symbols[]
intervals[]
start_ms
```

约束：

- `symbols` 多选、去重、规范为交易所标准 symbol。
- `intervals` 多选、按语义去重；服务端是周期合法性和路由的最终权威。
- 只允许一个 `start_ms`，公开请求中不得出现由用户控制的 `end_ms`。
- 原生周期直接下载；非原生周期只有在 `IntervalResolver` 能找到可精确平铺的历史基础周期时才接受。
- 表单可以显示本机保存的自定义周期，但不能只依赖前端判断它是否可合成。

### 1.2 起点语义

用户输入的是 `requested_start_ms`。每个目标周期分别计算 `effective_start_ms`：

- 使用目标交易日历选择第一个 `open_time >= requested_start_ms` 的完整目标 K 线。
- 不生成“从用户时间中途开始”的部分 K 线。
- 多周期的 `effective_start_ms` 可能不同，计划预览必须逐目标展示或明确汇总差异。
- 自定义周期为完成第一个目标桶而额外读取的基础周期 padding 属于内部工作范围，不改变用户看到的目标起点。

如果用户起点早于商品真实上市边界：

- 已有已确认的上市/历史左边界时，计划直接把有效起点推进到该边界，并显示 `boundary_adjustment`。
- 下载过程中才发现边界时，只有权威来源和现有 HistoryAvailability 合同确认后才能推进起点。
- 单次空响应、限流或临时网络失败不得被当作上市边界；这种情况必须失败或等待重试。

### 1.3 “到当前”的语义

“当前”不是正在形成的 K 线，也不是无限追逐的墙钟时间：

1. 计划时记录 `plan_captured_at_ms`，并为每个目标计算 `initial_end_open_ms`。
2. 主体历史导入完成后进入 `SEALING`。
3. 封口时重新读取时间，为每个目标计算 `sealed_end_open_ms`。
4. 用 REST/现有归档能力补齐主体结束位置到封口边界的尾部。
5. 对 `[effective_start_ms, sealed_end_open_ms]` 做精确连续性验证。
6. 成功结果显示明确的 `sealed_end_open_ms`，不得只显示含糊的“已到当前”。

封口完成后新闭合的 K 线不属于本次任务的成功声明。后续实时写入可以继续增加数据库尾部，但 `continuous_end_ms` 只有再次验证后才能前移。

### 1.4 成功语义

一个任务展开为 `symbols × intervals` 个目标。目标成功的唯一条件是：

```text
storage.verify_contiguous_range(
  exchange,
  market_type,
  symbol,
  canonical_interval,
  effective_start_ms,
  sealed_end_open_ms,
).verified_contiguous is True
```

不得使用以下条件代替：

- HTTP/ZIP 请求成功；
- 写入行数大于零；
- SQLite 中存在最早和最晚行；
- `COUNT(*)` 与粗略估计相同；
- Gap scan 被截断后没有看到 gap；
- Backfill Report 没有抛异常。

父任务状态：

- 所有目标 `READY`：`SUCCEEDED`。
- 部分目标 `READY`、部分目标失败：`PARTIAL`。
- 没有目标 `READY` 且无法继续：`FAILED`。
- 因存储空间不足停止但可恢复：`BLOCKED_STORAGE`。
- 用户取消且物理任务已停止：`CANCELLED`。

`PARTIAL` 不能被前端渲染成绿色“下载完成”。成功目标可以保留，失败目标不获得持久化用户所有权。

### 1.5 GC 合同

手动下载是用户创建的数据所有权，不是普通冷热缓存：

- 创建任务返回成功前，目标及其必要基础依赖必须先获得持久化 `transient` 保护。
- 目标连续性验证通过后，在一个事务中把目标保护升级为 `durable`，再释放对应 transient 保护。
- 自动 GC、启动清理、手动 GC 和高级行数限制都不得删除 `protected_start_ms` 及之后的行。
- 同一序列有多个 owner 时，最早的 `protected_start_ms` 是有效硬下限。
- GC 可以删除严格早于有效保护下限、且不受其他 owner 保护的旧行。
- 预算无法通过删除无保护数据满足时，报告 `unable_to_reach_budget` 和阻塞 owner；不得越过保护线。
- `unconfigured` SQLite 预算继续保持自动 GC no-op。
- “移除保护”和“立即删除数据”是两个不同操作。第一版只交付移除保护，不提供一键物理删除。

---

## 2. 当前仓库基线与必须复用的能力

实施前先阅读并以当前源码为准：

| 能力 | 当前入口 | 本功能的处理 |
|---|---|---|
| 数据工作台 | `frontend/src/features/data-workbench/DataWorkbenchModal.tsx` | 保留库存查询只读语义，新增独立写入区 |
| 只读库存 API | `backend/app/api/v1/settings.py` 的 `/settings/storage/inventory` | 扩展用户所有权摘要，但接口本身仍不写入 |
| K 线主键/Upsert | `backend/app/data_engine/storage/klines_repo.py` | 复用 `(exchange, market_type, symbol, interval, open_time)` 幂等写入 |
| 精确连续性验证 | `KlinesRepoAdapter.verify_contiguous_range()` | 作为唯一封口门禁 |
| 回填调度 | `BackfillCoordinator` / `RepairRequest` | 复用分块、优先级、限流、等待、取消和 gap ledger |
| Backfill 流水线 | `BackfillEngine.run()` | 复用 Detect → Plan → Fetch → Reconcile → Publish |
| 官方归档 | `HistoricalSourceRouter` | 自动选择 ZIP，失败回退 REST，不在 UI 提供 ZIP 开关 |
| Binance ZIP | `backend/app/exchanges/plugins/binance/archive.py` | 支持 spot/futures 和已声明原生周期的月包/日包 |
| OKX ZIP | `backend/app/exchanges/plugins/okx/archive.py` | 当前仅 `1m`，且 `OKX_HISTORY_ARCHIVE_ENABLED` 默认关闭 |
| 周期路由 | `IntervalResolver` | 服务端决定 native/derived/source interval |
| 自定义聚合 | `backend/app/data_engine/backfill/reconciler.py`、`backend/app/data_engine/interval_policy.py` | 抽取共享 materializer，禁止复制一套不同算法 |
| GC 计划/执行 | `backend/app/data_engine/data_manager/retention.py`、`backend/app/data_engine/data_manager/auto_gc.py`、`backend/app/data_engine/data_manager/maintenance.py` | 增加时间保护下限，并在每个删除 batch 前重验 |
| 临时 StorageIntent | `backend/app/data_engine/data_manager/storage_intents.py` | 继续服务运行时工作流，但不能承担用户持久所有权 |

当前已知阻塞：

1. `StorageIntentRegistry` 只在内存中，进程重启后丢失。
2. `RetentionService.run_startup_db_cleanup()` 直接调用 `delete_oldest()`，绕过 StorageIntent、活跃序列和未来的用户所有权。
3. GC 只理解 `keep_rows`，不能准确表达用户选择的时间起点。
4. `BackfillCoordinator` 的持久 outcome 不是长期 Job Store，不能单独承担跨进程任务恢复。
5. 多个自定义目标分别提交时可能重复发起相同基础周期网络抓取，需要显式源需求合并。

在这些阻塞关闭前，`MANUAL_HISTORY_DOWNLOAD_ENABLED` 必须保持关闭。

---

## 3. 目标架构

```text
DataWorkbench ManualHistoryDownloadPanel
  -> plan API（只读、可重复）
  -> create API（幂等）
  -> ManualHistoryService
       -> ManualHistoryRepository / DurableProtectionRegistry
       -> BackfillCoordinator
            -> BackfillEngine
                 -> HistoricalSourceRouter
                      -> official ZIP cache/import
                      -> REST fallback + current tail
                 -> Reconciler / shared custom materializer
                 -> SQLite upsert
       -> exact contiguous verification
       -> transactional seal + durable protection
  -> job/collection polling

RetentionService / startup cleanup / manual GC / auto GC
  -> same DurableProtectionRegistry snapshot
  -> plan is clamped before protected_start_ms
  -> execution revalidates protection epoch and time floor per batch
```

这里有两条必须同时成立的流水线：

```text
数据流水线：下载/合成/写入/验证
所有权流水线：transient 保护/持久化/升级 durable/GC 重验

汇合点：目标 seal 事务
```

没有所有权流水线的数据写入不能对用户宣称“已保存”；没有连续性验证的所有权升级也不能发生。

---

## 4. 持久化模型

新增目录：

```text
backend/app/data_engine/manual_history/
  __init__.py
  models.py
  repository.py
  planner.py
  materializer.py
  service.py
```

所有表与 `klines` 位于同一个 `KLINES_DB_PATH`，由 `init_klines_storage()` 调用新的 `init_manual_history_storage()`。不得另建一个可能与 K 线写入失去恢复一致性的任务数据库。

### 4.1 建议 DDL

```sql
CREATE TABLE IF NOT EXISTS manual_history_collections (
    collection_id TEXT PRIMARY KEY,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    requested_start_ms INTEGER NOT NULL CHECK (requested_start_ms >= 0),
    status TEXT NOT NULL CHECK (
        status IN ('BUILDING', 'ACTIVE', 'PARTIAL', 'RELEASED')
    ),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manual_history_collection_targets (
    collection_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    requested_interval TEXT NOT NULL,
    canonical_interval TEXT NOT NULL,
    route_kind TEXT NOT NULL CHECK (route_kind IN ('NATIVE', 'DERIVED')),
    source_interval TEXT NOT NULL,
    effective_start_ms INTEGER NOT NULL,
    continuous_end_ms INTEGER,
    status TEXT NOT NULL CHECK (
        status IN ('PENDING', 'BUILDING', 'READY', 'FAILED', 'RELEASED')
    ),
    expected_rows INTEGER,
    verified_rows INTEGER,
    verified_at_ms INTEGER,
    boundary_reason TEXT,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (collection_id, symbol, canonical_interval),
    FOREIGN KEY (collection_id)
        REFERENCES manual_history_collections(collection_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_history_jobs (
    job_id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN (
            'QUEUED', 'RUNNING', 'SEALING', 'SUCCEEDED', 'PARTIAL',
            'FAILED', 'BLOCKED_STORAGE', 'CANCELLING', 'CANCELLED'
        )
    ),
    stage TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    total_targets INTEGER NOT NULL,
    ready_targets INTEGER NOT NULL DEFAULT 0,
    failed_targets INTEGER NOT NULL DEFAULT 0,
    estimated_db_bytes INTEGER,
    estimated_temp_bytes INTEGER,
    reserved_bytes INTEGER,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    last_error TEXT,
    FOREIGN KEY (collection_id)
        REFERENCES manual_history_collections(collection_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_history_job_targets (
    job_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    canonical_interval TEXT NOT NULL,
    source_interval TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN (
            'QUEUED', 'FETCHING', 'MATERIALIZING', 'VERIFYING',
            'READY', 'FAILED', 'BLOCKED_STORAGE', 'CANCELLED'
        )
    ),
    initial_end_open_ms INTEGER NOT NULL,
    sealed_end_open_ms INTEGER,
    backfill_request_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    estimated_rows INTEGER,
    written_rows INTEGER NOT NULL DEFAULT 0,
    verified_rows INTEGER,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (job_id, symbol, canonical_interval),
    FOREIGN KEY (job_id) REFERENCES manual_history_jobs(job_id) ON DELETE RESTRICT,
    FOREIGN KEY (collection_id, symbol, canonical_interval)
        REFERENCES manual_history_collection_targets(
            collection_id, symbol, canonical_interval
        ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_history_protections (
    protection_id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('JOB', 'COLLECTION')),
    owner_id TEXT NOT NULL,
    protection_kind TEXT NOT NULL CHECK (
        protection_kind IN ('TRANSIENT', 'DURABLE')
    ),
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    protected_start_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    UNIQUE (owner_kind, owner_id, exchange, market_type, symbol, interval)
);

CREATE INDEX IF NOT EXISTS idx_manual_history_jobs_state
ON manual_history_jobs(state, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_manual_history_targets_series
ON manual_history_collection_targets(
    exchange, market_type, symbol, canonical_interval, status
);

CREATE INDEX IF NOT EXISTS idx_manual_history_active_protection
ON manual_history_protections(
    state, exchange, market_type, symbol, interval, protected_start_ms
);
```

### 4.2 保护快照

`DurableProtectionRegistry` 在内存中维护从持久表恢复的只读镜像：

```python
StorageProtectionFloor(
    key=SeriesKey(...),
    protected_start_ms=...,
    owner_count=...,
    transient_owner_count=...,
    durable_owner_count=...,
    owner_ids=(...),
)
```

同一 `SeriesKey` 的有效保护下限：

```text
MIN(protected_start_ms WHERE state = 'ACTIVE')
```

更新顺序必须防止 GC 竞态。保护变更由 DataManager 暴露的短事务方法统一执行；该方法在 `_storage_gc_guard` 下完成 repository transaction、镜像更新和 protection epoch 增加，然后才释放 guard。物理 GC batch 使用同一 guard，因此看不到“数据库已提交但内存尚未保护”的中间状态。保护事务只能写少量 metadata，不得在 guard 内做 gap scan、K 线查询或网络 I/O。

- 新增保护：metadata transaction 和镜像更新全部成功后才允许开始写 K 线。
- 升级保护：同一事务先建立 durable，再释放 transient；任一失败都宁可多保护，不可出现无保护窗口。
- 释放保护：同一 guard 下在数据库标记 `RELEASED` 并更新镜像；如果进程在 commit 后崩溃，重启会从数据库恢复正确状态。
- 启动恢复：即使 `MANUAL_HISTORY_DOWNLOAD_ENABLED=0`，也必须在任何启动清理或自动 GC 之前加载镜像；关闭下载功能不能关闭既有数据保护。

---

## 5. API 合同

新增 `backend/app/api/v1/manual_history.py`：

```python
router = APIRouter(
    prefix="/settings/storage/manual-downloads",
    tags=["settings", "manual-history"],
)
```

由 `backend/app/main.py` 在 LIVE runtime 下注册。API 通过 `request.app.state.data_engine_runtime.manual_history_service` 获取服务，不直接构造 BackfillEngine 或 SQLite connection。

### 5.1 能力

```http
GET /api/v1/settings/storage/manual-downloads/capabilities
```

返回：

```json
{
  "status": "ok",
  "enabled": false,
  "reason": "feature_flag_disabled",
  "job_runner_available": true,
  "archive": {
    "enabled": true,
    "okx_enabled": false
  },
  "limits": {
    "max_targets": 64,
    "active_job_concurrency": 1,
    "target_concurrency": 2
  }
}
```

`max_targets` 是防止多选笛卡尔积误操作和队列/内存放大的事故边界，不应成为未经测量的永久产品门槛。Phase 0 先以 64 作为默认关闭状态下的保守值，Phase 11 根据容量证据调整并记录理由。

### 5.2 计划

```http
POST /api/v1/settings/storage/manual-downloads/plan
```

请求：

```json
{
  "exchange": "binance",
  "market_type": "spot",
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "intervals": ["1m", "1h", "89m"],
  "start_ms": 1735689600000
}
```

响应至少包含：

```json
{
  "status": "ok",
  "can_start": true,
  "plan_hash": "sha256:...",
  "captured_at_ms": 1787835600000,
  "expires_at_ms": 1787835900000,
  "selection": {
    "exchange": "binance",
    "market_type": "spot",
    "symbols": ["BTCUSDT", "ETHUSDT"],
    "intervals": ["1m", "1h", "89m"],
    "requested_start_ms": 1735689600000,
    "target_count": 6
  },
  "targets": [
    {
      "symbol": "BTCUSDT",
      "requested_interval": "89m",
      "canonical_interval": "89m",
      "route_kind": "DERIVED",
      "source_interval": "1m",
      "effective_start_ms": 1735689660000,
      "initial_end_open_ms": 1787830260000,
      "source_strategy": "ARCHIVE_PREFERRED_WITH_REST_TAIL",
      "estimated_target_rows": 5810,
      "estimated_source_rows": 517090,
      "existing_coverage": "PARTIAL"
    }
  ],
  "storage": {
    "sqlite_budget_bytes": 10737418240,
    "physical_size_bytes": 2147483648,
    "estimated_db_growth_bytes": 123456789,
    "estimated_temp_bytes": 98765432,
    "estimate_confidence": "MEDIUM",
    "disk_free_bytes": 53687091200,
    "blocking_reasons": [],
    "warnings": []
  }
}
```

计划 API 必须保持只读：

- 不创建 collection/job/protection。
- 不触发 ZIP 下载、REST 回填、修复、VACUUM 或 GC。
- 可以读取 provider capability 和本地 ZIP cache metadata；不要为了预览下载正文。
- `source_strategy` 是能力/阈值计划，不是对远程对象可用性的虚假保证。
- 无法可靠估算时返回 `estimate_confidence=LOW`，不得把未知值伪装成 0 B。

`plan_hash` 使用规范 JSON 的 SHA-256，覆盖 normalized selection、周期 route、服务端计划版本和相关配置 revision；不把每秒变化的磁盘剩余量直接纳入 hash。

### 5.3 创建任务

```http
POST /api/v1/settings/storage/manual-downloads
```

请求：

```json
{
  "exchange": "binance",
  "market_type": "spot",
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "intervals": ["1m", "1h", "89m"],
  "start_ms": 1735689600000,
  "plan_hash": "sha256:...",
  "idempotency_key": "frontend-generated-uuid"
}
```

处理顺序：

1. 重算 normalized plan。
2. `plan_hash` 不匹配返回 `409 plan_stale` 和新计划摘要。
3. 重验 SQLite 预算、活动 reservation 和磁盘安全余量。
4. 空间冲突返回 `409 storage_conflict`，不得提供 `force=true` 绕过用户数据保护。
5. 通过 DataManager 的受保护 metadata mutation，在同一个 GC guard 内创建 collection、targets、job、job targets、transient protections，并更新内存保护镜像。
6. 确认 protection epoch 已增加。
7. 将 job 入队。
8. 返回 `202 Accepted`。

相同 `idempotency_key` 和相同 request hash 返回原 job；相同 key 不同 request hash 返回 `409 idempotency_conflict`。

### 5.4 查询与取消

```http
GET  /api/v1/settings/storage/manual-downloads?limit=50&cursor=...
GET  /api/v1/settings/storage/manual-downloads/{job_id}
POST /api/v1/settings/storage/manual-downloads/{job_id}/cancel
GET  /api/v1/settings/storage/manual-downloads/collections
POST /api/v1/settings/storage/manual-downloads/collections/{collection_id}/release
```

取消语义：

- API 先持久化 `cancel_requested=1` 和 `CANCELLING`。
- 对每个活动 Backfill request 调用 `release_demand(..., cancel_if_unobserved=True)`。
- 已运行 chunk 可以安全结束；禁止强杀正在持有 SQLite 写锁的线程。
- 所有物理工作 inert 后，把未 READY target 标为 `CANCELLED`，再释放 transient protections。
- 已经 seal 成 durable 的目标仍保留，父 job 最终可以是 `PARTIAL`；不能因取消其它目标而撤销成功目标所有权。

`release collection` 只释放 durable protection，并把 collection/targets 标记 `RELEASED`。它不执行 K 线 DELETE。

---

## 6. Job 状态机与执行算法

### 6.1 父 Job 状态机

```text
QUEUED
  -> RUNNING
  -> SEALING
  -> SUCCEEDED | PARTIAL | FAILED

RUNNING | SEALING
  -> BLOCKED_STORAGE
  -> QUEUED（空间恢复后显式重试/自动恢复）

QUEUED | RUNNING | SEALING | BLOCKED_STORAGE
  -> CANCELLING
  -> CANCELLED | PARTIAL
```

只允许 repository 中的 compare-and-set 状态转换。每次更新增加 `revision`，前端只接受不小于当前 revision 的快照。

### 6.2 目标执行分组

对每个 symbol：

1. 使用 `DataManager.interval_resolver.resolve(..., purpose=HISTORY)` 解析所有选择周期。
2. 原生目标按自己的 interval 形成 source demand。
3. 派生目标按 `source_interval` 分组。
4. 同一个 `(exchange, market_type, symbol, source_interval)` 只建立一次基础历史需求，其范围是所有依赖目标投影后的并集。
5. 如果基础周期本身也被用户选择，它既是最终目标，也是派生目标的 source；下载一次，成功后拥有 durable collection protection。
6. 如果基础周期仅为内部依赖，任务期间使用 transient protection；所有派生目标 seal 或终止后才释放。

网络抓取去重是硬要求；第一版可以为每个派生目标分别扫描同一份本地基础数据，但不得分别重新下载它。

### 6.3 Backfill 请求 metadata

```python
RepairRequest(
    ...,
    reason="manual_history_download",
    priority=120,
    requester="manual_history_download",
    metadata={
        "origin": "data_workbench",
        "manual_job_id": job_id,
        "manual_collection_id": collection_id,
        "demand_owner_id": f"manual-history:{job_id}:{source_key}",
        "demand_scope": f"manual-history:{job_id}",
        "archive_explicit_demand": True,
        "requires_trusted_finality": True,
    },
)
```

修改 `backfill_coordinator.py`：

- `BACKFILL_REASON_PRIORITIES["manual_history_download"] = 120`。
- 把它加入 maintenance 语义，但不加入可抢占主图 reserve 的 interactive 集合。
- 主图 visible request 在单通道配置下仍可使用现有 foreground reserve，长任务不能形成永久队头阻塞。

修改 `source_router.py`：

- `archive_explicit_demand=True` 属于真实用户归档需求，可以启动 deferred archive objects。
- 不要把计划预览、后台 warmup 或无 owner 的 speculative request 误当作 explicit demand。
- 保留 `HISTORY_ARCHIVE_MIN_REST_PAGES`：小范围和局部旧月份继续 REST。
- 保留 ZIP cache singleflight、checksum/schema 校验和 REST fallback。

### 6.4 自定义周期物化

新增共享 `CustomHistoryMaterializer`，并让现有 Reconciler 与手动任务共同使用同一个聚合核心：

1. 先为当前 Reconciler 的 native/custom golden cases 建 parity 测试。
2. 抽取 bucket 边界、完整 component coverage、authoritative finality 和 OHLCV 聚合逻辑。
3. Reconciler 改用共享核心，确保既有测试先通过。
4. Manual materializer 按页读取基础 K 线；跨页保留未闭合 bucket carry。
5. 只写 component 完整且目标 bucket 已闭合的 target bar。
6. 每个目标写入后调用精确连续性验证。

不得：

- 用前端合成后再上传数据库；
- 为 45m、89m 等目标分别下载同一份 1m；
- 用正在形成的 source bar 合成“历史完成”目标；
- 为通过连续性门禁而合成零成交假 K 线；
- 复制一套与实时 BarAggregator 不一致的 bucket alignment。

### 6.5 封口

每个目标的封口步骤：

1. 读取新的 `seal_now_ms`。
2. 使用目标交易日历计算 `sealed_end_open_ms`。
3. 如果 native：补齐到该目标 open。
4. 如果 derived：把目标 `[effective_start, sealed_end]` 精确投影为 source open range，补齐 source，再物化缺失目标 buckets。
5. 执行 `verify_contiguous_range()`。
6. 验证为 `True` 时，在同一 SQLite transaction 中：
   - 更新 job target 为 `READY`；
   - 更新 collection target 的 `continuous_end_ms`、verified rows/time；
   - 写入 durable protection；
   - 释放该目标 transient protection；
   - 增加 job/collection revision。
7. transaction 成功后更新 DurableProtectionRegistry 镜像。

若验证返回 `False`，记录首个 expected/actual open，回到有界 repair；超过重试策略后 target `FAILED`。若返回 `None`，按“验证不可用”失败关闭，不能标记 READY。

### 6.6 重启恢复

`ManualHistoryService.start()`：

1. 保护镜像必须已在 DataManager 启动/GC 之前恢复。
2. 扫描 `QUEUED/RUNNING/SEALING/BLOCKED_STORAGE/CANCELLING` jobs。
3. `RUNNING/SEALING` 增加 `recovery_count` 并重新入队；旧 `backfill_request_id` 只作为审计信息，不尝试复用进程内 Future。
4. 从 SQLite 现状重新检测缺口，依靠主键/upsert 幂等继续；不依赖旧内存 cursor。
5. `CANCELLING` 在确认没有本进程物理任务后完成取消并释放 transient。
6. 已经 READY/durable 的目标只重验 metadata 一致性，不重新下载。

关闭顺序：先停止接收新任务，持久化 runner 状态，撤销/等待当前 demand owners，再 shutdown BackfillCoordinator。禁止先销毁 coordinator 再写 job 状态。

---

## 7. GC 改造合同

### 7.1 Planner 输入

为 `RetentionService.plan_storage_gc()` 增加：

```python
protection_floors: Mapping[SeriesKey, StorageProtectionFloor]
```

每个候选序列计算：

```text
rows_before_floor = COUNT(
  rows WHERE open_time < protected_start_ms
)

floor_keep_rows = current_rows - rows_before_floor
effective_keep_rows = MAX(
  ordinary row-limit keep,
  storage-intent keep,
  floor_keep_rows,
)
```

计划输出新增：

```json
{
  "protected_start_ms": 1735689600000,
  "protected_owner_count": 2,
  "protected_owner_kinds": ["COLLECTION", "JOB"],
  "protection_clamped": true,
  "rows_before_protected_floor": 1200,
  "blocked_delete_rows": 8800
}
```

自动 GC 可以删除 `rows_before_protected_floor` 中的安全前缀，但计划必须被保护线 clamp。不能简单给整个序列加一个 risk flag 后永远跳过，也不能为了提高回收率越过 floor。

### 7.2 Repository 删除合同

扩展 `delete_oldest_klines_batch()` / adapter / StorageBackend protocol：

```python
delete_oldest_batch(
    ...,
    keep: int,
    batch_size: int,
    delete_before_ms: int | None,
)
```

SQL 子查询必须同时满足：

```sql
open_time < :delete_before_ms
```

当存在用户保护时，`delete_before_ms` 必须为当前有效 `protected_start_ms`；不存在保护时才允许 `NULL`。

每个 batch 执行前：

1. 在 `_storage_gc_guard` 下读取当前 protection epoch/floor。
2. 如果新增 owner、floor 从无变有，或 floor 变得更早，当前计划作废并重新规划。
3. 把当前 floor 传给物理 DELETE；不能只相信计划时的 `keep_rows`。
4. 保留现有 1,000 rows/50ms 有界删除和 SQLite busy fail-closed 合同。

### 7.3 启动清理

禁止继续调用当前不带保护信息的 `RetentionService.run_startup_db_cleanup()` 直接删除。

改造选择：

- 首选：删除直接启动清理调用，启动后通过统一 GC planner 生成 row-limit plan，并走 `MaintenanceService` 的同一执行/重验路径。
- 如果保留函数名，它也必须只是统一 planner/executor 的薄包装，不得调用 `storage.delete_oldest()`。

测试必须证明：应用重启、`storage_row_limits_enabled=true`、用户数据量超过行数限制时，protected floor 之后仍为精确连续。

### 7.4 预算和磁盘冲突

计划大小分三类：

```text
estimated_db_growth_bytes
estimated_archive_cache_growth_bytes
estimated_wal_and_materialization_bytes
```

Phase 0 新增临时数据库 benchmark，测量真实 K 线 schema/index/WAL 的每行物理增长。不要复用内存 GC 的 `BAR_ESTIMATED_BYTES=96` 作为未经验证的 SQLite 精确值。

创建任务时：

- SQLite budget 已配置，且预计 durable protected floor 本身会突破预算：`storage_conflict`。
- SQLite budget 未配置：不因预算阻止，但仍检查磁盘安全余量。
- 活动 jobs 的 `reserved_bytes` 必须从可用空间中扣除，防止两个计划各自认为空间足够。
- 运行中每个 source group 和 materialization chunk 前重验磁盘。
- 进入 critical free-space 时暂停为 `BLOCKED_STORAGE`；不要立即 DELETE，因为 SQLite DELETE 可能先扩大 WAL。
- 普通 cache 清完仍无法达标时返回 blocking collections/jobs，不删除用户范围。

官方 ZIP cache 是可重建的独立缓存，不是 durable collection。它遵守 `HISTORY_ARCHIVE_CACHE_MAX_BYTES`，可以在自身安全策略下淘汰；淘汰 ZIP 不影响已经写入并验证的 K 线所有权。

---

## 8. 前端交互与文件拆分

不要继续把所有逻辑堆进 `DataWorkbenchModal.tsx`。建议：

```text
frontend/src/services/manualHistoryApi.ts
frontend/src/services/__tests__/manualHistoryApi.test.ts

frontend/src/features/data-workbench/
  DataWorkbenchModal.tsx
  ManualHistoryDownloadPanel.tsx
  ManualHistoryPlanSummary.tsx
  ManualHistoryJobList.tsx
  manualHistoryModel.ts
  workbenchInventory.ts
  __tests__/
    manualHistoryModel.test.ts
    manualHistoryDownloadPanel.test.tsx
```

### 8.1 页面结构

工作台从上到下：

1. “手动下载”区域，默认展开。
2. 活动/最近任务。
3. 原有库存筛选卡，标题明确为“数据库存 · 只读”。
4. 物理文件、序列、gap ledger 等原有折叠区。

不要删除库存接口的 `LIVE / 只读` 表达；把 badge 限定到库存区域即可。

### 8.2 表单

- 交易所：单选，默认当前图表 exchange。
- 市场：单选，默认当前图表 market type。
- 商品：可搜索多选，复用 `/symbols/exchange-info` 的缓存；当前图表 symbol 提供快捷添加。
- 周期：多选，来源是 exchange history capabilities + 本机保存 custom records；同时允许输入一个新 custom token。
- 开始时间：唯一时间选择器。
- 右边界：只读文案“任务完成时最后一根已收盘 K 线”。
- 主按钮第一步是“计算计划”，不是直接下载。

前端可先做基础格式校验，但服务端返回的 canonical interval、source interval、实际起点和拒绝原因必须覆盖前端推断。

### 8.3 计划摘要

必须显示：

- `商品数 × 周期数 = 目标序列数`。
- 用户起点和目标实际起点差异。
- native/derived 路由，例如 `89m ← 1m`。
- `ZIP 批量 + REST 尾部`、`REST` 或 `归档能力不可用`。
- 预计最终 DB 增量、归档缓存/临时空间、estimate confidence。
- 当前 SQLite 预算、预计保护后使用量和磁盘冲突。
- 明确文案：“下载成功的数据将加入用户数据集，并受 GC 保护。”

当 `can_start=false` 时禁用“开始下载”，直接显示可执行原因：调整开始时间、调整存储预算、释放其他数据集或释放磁盘。不要增加一个无意义的“我知道风险仍然强制”复选框。

### 8.4 Job 展示

父任务显示：

- 总体状态和 stage；
- ready/total targets；
- 当前 source group/目标；
- ZIP/REST/materialize/verify 阶段；
- bars/bytes 是估算进度时标注“约”；
- 明确的封口时间；
- `PARTIAL` 的失败目标及错误；
- 取消按钮只在可取消状态出现。

轮询策略：运行中 1 秒，连续无 revision 变化后退避到 2–5 秒；终态停止。组件关闭时 AbortController 取消请求，重新打开从服务端恢复，不把 React state 当作任务真相。

### 8.5 库存所有权

扩展只读库存响应，为每个 series 增加：

```json
{
  "protected_start_ms": 1735689600000,
  "manual_owner_count": 1,
  "manual_protection": "DURABLE",
  "continuous_end_ms": 1787830200000,
  "collection_ids": ["..."]
}
```

UI 显示“手动数据集”“保护起点”“已验证连续至”。`collection_ids` 数量大时后端有界返回并提供 `owners_truncated`，不要把无限 owner 列表塞入库存接口。

---

## 9. 分阶段执行步骤

### Phase 0：冻结基线、容量与开关

目标：在不改变生产行为的前提下建立可测量基线。

执行：

1. 检查工作树：

   ```powershell
   Set-Location H:\program\CandleScope
   git status --short
   git diff -- frontend/src/features/data-workbench/DataWorkbenchModal.tsx
   ```

   当前 DataWorkbench 文件可能已有用户未提交修改。禁止 `git reset --hard`、`git checkout --` 或用模板覆盖；先确定这些改动的归属，再在其上集成。

2. 在 `backend/app/core/config.py` 增加默认关闭的：

   ```text
   MANUAL_HISTORY_DOWNLOAD_ENABLED=0
   MANUAL_HISTORY_PLAN_TTL_SECONDS=300
   MANUAL_HISTORY_MAX_TARGETS=64
   MANUAL_HISTORY_ACTIVE_JOB_CONCURRENCY=1
   MANUAL_HISTORY_TARGET_CONCURRENCY=2
   ```

3. 新增 `backend/scripts/benchmark_manual_history_storage.py`，只使用临时目录/临时 KLINES_DB_PATH，测量：

   - 10k/100k/1m native rows 的 DB、WAL、index 物理增长；
   - Upsert 重放后的增量；
   - 1m → 89m materialization 的时间、峰值临时空间；
   - 有界 delete/checkpoint 的空间行为。

4. 把结果写入 `docs/perf-baselines/manual-history/phase0-storage-<date>.json`，记录硬件、Python、SQLite、文件系统和提交号。
5. 添加 capabilities endpoint 的 disabled 响应，但前端先不显示表单。

测试：

```powershell
Set-Location H:\program\CandleScope\backend
.\.venv\Scripts\python.exe -m pytest tests\test_settings_api.py -q
```

退出门禁：

- 默认行为与当前版本一致。
- feature flag 关闭时不能创建任务。
- benchmark 不接触真实 `data/candlescope.db`。
- 容量 evidence 生成成功，后续空间估算有来源。

建议提交：`manual-history phase0: freeze contract and storage baseline`

### Phase 1：持久化模型与恢复仓库

目标：先建立跨重启的 collection/job/protection 真相源。

执行：

1. 新增 `manual_history/models.py` 的 Enum/dataclass，集中定义状态，不在 API/service 中散落字符串。
2. 新增 `repository.py` 和上述 DDL。
3. `init_klines_storage()` 创建 `klines/history_archive_imports` 后调用新 schema init。
4. Repository 实现：
   - create plan transaction；
   - idempotency lookup；
   - compare-and-set job/target transition；
   - active protection snapshot；
   - seal target transaction；
   - release collection transaction；
   - recoverable jobs query。
5. 所有方法使用参数化 SQL；JSON 字段如后续增加，读时严格校验，坏记录 fail closed。
6. 新增 `backend/tests/test_manual_history_repository.py`，使用 temp DB 覆盖 fresh init、重复 init、事务回滚、idempotency、非法 transition、restart reload。

测试：

```powershell
Set-Location H:\program\CandleScope\backend
.\.venv\Scripts\python.exe -m pytest tests\test_manual_history_repository.py -q
```

退出门禁：

- 任务/保护可跨 repository 重建恢复。
- create transaction 任一步失败时没有孤儿 collection/job/protection。
- schema 初始化幂等。
- 不改现有 K 线查询/写入结果。

建议提交：`manual-history phase1: add durable collection and job repository`

### Phase 2：GC 时间保护下限

目标：在任何下载入口开放之前，使所有 GC 路径理解 durable/transient time floor。

执行：

1. 新增 `DurableProtectionRegistry`，启动时从 Phase 1 表加载。
2. DataManager planning snapshot 同时返回：active keys、StorageIntent clone、durable protection floors、epoch。
3. 扩展 `RetentionService.plan_storage_gc()`，按第 7 节 clamp delete rows。
4. 扩展 Klines repository 的 `count_rows_before()` 和带 `delete_before_ms` 的 bounded delete。
5. 扩展 `MaintenanceService` replan/intersection/execution payload。
6. `_storage_gc_protection_reason()` 比较当前与计划 protection floor；更早的 floor 是更强保护。
7. 自动 GC 允许删除保护线之前的安全前缀，但不能跨线。
8. 替换直接 startup cleanup，使其走统一 planner/executor。
9. inventory/dry-run 输出 owner 和 blocked rows，方便验收。

新增/扩展测试：

```text
backend/tests/test_manual_history_gc_protection.py
backend/tests/test_storage_retention_gc.py
backend/tests/test_gc_execution_safety.py
backend/tests/test_settings_api.py
```

必须覆盖：

1. 无 floor：行为与当前 GC 相同。
2. floor 之前有旧行：只删旧行。
3. row limit 要求越过 floor：被 clamp。
4. budget overrun 仍不能越过 floor。
5. 计划后新增 owner：执行时 blocked/replan。
6. 计划后 floor 提前：执行时 blocked/replan。
7. 计划后 owner 释放：旧计划不能扩大删除范围，必须重算。
8. startup row cleanup 不能越过 floor。
9. transient 与 durable 都是硬保护。
10. `unconfigured` 仍不自动删除。

测试：

```powershell
Set-Location H:\program\CandleScope\backend
.\.venv\Scripts\python.exe -m pytest `
  tests\test_manual_history_gc_protection.py `
  tests\test_storage_retention_gc.py `
  tests\test_gc_execution_safety.py `
  tests\test_settings_api.py -q
```

退出门禁：

- 所有删除入口共享同一时间保护合同。
- 重启 + 高级行数限制场景通过。
- 可生成 `unable_to_reach_budget`，而不是越权删除。
- 形成一个“保护感知回滚基线”提交；后续不能回滚到它之前的 binary。

建议提交：`manual-history phase2: make all sqlite GC protection-aware`

### Phase 3：只读计划器与空间预检

目标：在不创建任务的情况下准确展开目标和风险。

执行：

1. 新增 `manual_history/planner.py`。
2. 规范化 exchange/market/symbol/interval，按语义去重。
3. 用 `IntervalResolver` 解析 route；任何 interval 失败则逐目标返回 typed error，整体 `can_start=false`。
4. 用交易日历计算 effective start 和 initial closed end。
5. 按 symbol/source interval 合并 source demand。
6. 读取现有 series bounds/rows 和 ZIP cache metadata，生成 upper-bound 工作量；不能用截断 gap scan 证明完整。
7. 使用 Phase 0 evidence + 实际数据库 bytes/row 生成带 confidence 的空间估算。
8. 读取 SQLite budget、disk pressure 和活动 job reservations。
9. 生成稳定 `plan_hash`。
10. 实现 capabilities/plan API 和 Pydantic 响应校验。

新增测试：

```text
backend/tests/test_manual_history_planner.py
backend/tests/test_manual_history_api.py
```

重点：

- 2 symbols × 3 intervals = 6 targets。
- `60m` 与 `1h` 语义去重。
- native/derived route 正确。
- 无 exact base fail closed。
- future start、start after last closed 被拒绝。
- calendar month/session 边界正确。
- plan 不创建 DB job/protection，不调用 fetcher。
- unknown estimate 不伪装为 0。
- budget/disk conflict 正确阻止创建。

退出门禁：计划 API 完全只读，响应足够驱动 UI，无网络正文下载。

建议提交：`manual-history phase3: add read-only target and storage planner`

### Phase 4：原生周期 Job Runner

目标：先跑通单商品/单原生周期到精确封口，不涉及 UI 和自定义周期。

执行：

1. 新增 `ManualHistoryService`，由 DataEngineRuntime 持有。
2. Runtime 构造顺序：repository/protection registry load → DataManager protection injection → coordinator → service construct → `DataManager.start()` → `ManualHistoryService.start()`。Service runner 只能在 DataManager 和 coordinator 可用后启动，但 protection registry 必须更早可用。
3. 实现 create transaction、queue、单 active job runner、target worker semaphore。
4. Native target 通过 BackfillCoordinator `request_and_wait()` 执行。
5. 设置 manual reason/priority/demand owner metadata。
6. 每个 chunk/target 前检查 `cancel_requested` 和 storage pressure。
7. 实现第一版 seal、精确 verify、durable upgrade。
8. `DataEngineRuntime.shutdown()` 先停止 ManualHistoryService，再 shutdown BackfillCoordinator；具体顺序按第 6.6 节执行。

新增测试：

```text
backend/tests/test_manual_history_service.py
backend/tests/test_manual_history_runtime.py
```

重点：空库、已有完整范围、已有头部/内部/尾部 gap、重复 create、部分 provider 失败、DB busy、cancel-after-chunk、seal 时间推进。

退出门禁：单 native target 在 temp DB 上完成，重放同一任务不重复写坏数据，成功后 GC floor 可见。

建议提交：`manual-history phase4: run durable native history jobs`

### Phase 5：官方 ZIP 批量通道

目标：大量历史通过现有官方归档自动加速，并保持 REST 正确性兜底。

执行：

1. 将 manual explicit demand 接入 `HistoricalSourceRouter`。
2. 保持 provider capability 决策：Binance 多周期；OKX 当前 1m 且受现有 flag 控制。
3. 保持 monthly/daily 选择和 `HISTORY_ARCHIVE_MIN_REST_PAGES`。
4. 归档对象 checksum/schema/period 校验失败时由现有路径回退 REST。
5. 当前日、未发布日包、局部边缘和 seal tail 使用 REST。
6. Job progress 区分 `ARCHIVE_DOWNLOAD/ARCHIVE_IMPORT/REST_TAIL`，但不把缓存预取当作已写入进度。
7. 大量对象必须复用 singleflight 和 parent range，不能每个 coordinator chunk 重复下载。

扩展测试：

```text
backend/tests/test_history_archive_routing.py
backend/tests/test_history_archive_storage.py
backend/tests/test_manual_history_service.py
```

必须覆盖：monthly 优先、daily 补局部、current tail REST、checksum 失败 fallback、ZIP 已缓存重用、同 object 多 target singleflight、OKX flag off。

退出门禁：归档只是加速器；把 `HISTORY_ARCHIVE_ENABLED=0` 后相同目标仍能经 REST 达到同一连续性结果。

建议提交：`manual-history phase5: enable explicit official archive acceleration`

### Phase 6：多选与自定义周期合成

目标：支持多商品、多周期和 source demand 去重。

执行：

1. 实现 target/source grouping。
2. 为 derived target 精确投影 source time range，包括 bucket 边界和必要 padding。
3. 抽取共享 custom materializer，并先保持 Reconciler parity。
4. 一次补齐 source，依次/有界并发物化共享该 source 的目标。
5. source 仅为依赖时持有 transient protection；所有 consumer 完成后释放。
6. 目标分别 seal；一个失败不回滚其它已 READY 目标。
7. 父 job 汇总为 SUCCEEDED/PARTIAL/FAILED。

测试矩阵：

```text
symbols: 1 / 3
intervals: native only / derived only / mixed
custom: 17m / 45m / 89m / calendar month compatible case
storage: empty / base present / target partially present
```

必须断言：共享 1m source 只触发一次网络需求；最终每个 custom target 与现有聚合合同一致；不完整 source bucket 不生成 target。

退出门禁：`3 symbols × (1m, 1h, 45m, 89m)` 在受控 fixture 上全部精确连续，且网络调用数按 source groups 而不是 target 数增长。

建议提交：`manual-history phase6: dedupe source work and materialize custom intervals`

### Phase 7：恢复、取消、阻塞与审计

目标：让长任务真正可运行，而不是只能在一个进程生命周期内成功。

执行：

1. 完成 startup recovery。
2. 完成 cancellation 与 coordinator demand owner 联动。
3. 完成 BLOCKED_STORAGE 和恢复。
4. Job/target 每次持久更新增加 revision。
5. 日志统一带 `manual_job_id/collection_id/series_key/stage`。
6. Snapshot 增加 runner queue、active workers、reservations、recoveries、blocked jobs。
7. 对 job 历史设置 metadata 保留策略；不得让审计表无限增长，但 metadata GC 不能删除活动/最近失败记录。

故障注入：

- ZIP 下载中重启；
- REST tail 中重启；
- materialization 中重启；
- seal transaction 前/后重启；
- cancel queued/active/sealing；
- disk pressure 从 normal → critical → normal；
- SQLite locked；
- provider rate limit。

退出门禁：所有故障都得到 SUCCEEDED/PARTIAL/FAILED/BLOCKED/CANCELLED 中的诚实状态；无 READY 误报；无保护窗口。

建议提交：`manual-history phase7: recover and cancel long-running jobs safely`

### Phase 8：完整 API 与库存所有权

目标：稳定公开 plan/create/get/list/cancel/collection release，并保持库存只读。

执行：

1. 完成第 5 节全部 endpoint。
2. 严格 Pydantic request/response model；symbol/interval list 和字符串长度有界。
3. 错误码稳定：`feature_disabled`、`plan_stale`、`storage_conflict`、`interval_unroutable`、`calendar_unknown`、`job_not_found`、`job_not_cancellable`。
4. 扩展 inventory ownership summary，查询仍 read-only。
5. OpenAPI/API_zh.md 记录没有公开 end time 和 release-not-delete 语义。

退出门禁：API contract tests 全部通过；计划/库存 GET/plan POST 不产生写入副作用；create/cancel/release 有审计状态。

建议提交：`manual-history phase8: publish stable workbench API contracts`

### Phase 9：数据工作台 UI

目标：把已验证后端能力接入用户操作，不在前端复制业务真相。

执行：

1. 新增 `manualHistoryApi.ts` 和严格 payload parser。
2. 拆出 ManualHistoryDownloadPanel/PlanSummary/JobList。
3. 接入商品搜索、周期多选、自定义 token、单开始时间。
4. 默认填入当前图表 exchange/market/symbol，但不自动开始。
5. 计划成功后显示空间和路由；计划变更使旧 plan_hash 失效并重新计划。
6. create 返回 job 后切到任务卡；轮询 revision。
7. 支持 cancel；release protection 放在 collection/库存明细中，不和下载主按钮混合。
8. 更新 `zh-CN.ts` 和 `en.ts`，运行 i18n 检查。
9. 现有库存卡标为“只读”，写入区有明确“写入数据库”说明。

前端测试：

```powershell
Set-Location H:\program\CandleScope\frontend
npx tsx --test `
  src\services\__tests__\manualHistoryApi.test.ts `
  src\features\data-workbench\__tests__\manualHistoryModel.test.ts `
  src\features\data-workbench\__tests__\manualHistoryDownloadPanel.test.tsx `
  src\features\data-workbench\__tests__\workbenchInventory.test.ts
npm run check:i18n
npm run typecheck
npm run build
```

退出门禁：无结束时间输入；多选和计划摘要可用；刷新/关闭弹窗不丢任务；PARTIAL/FAILED/BLOCKED 不被渲染为成功。

建议提交：`manual-history phase9: add the data workbench download flow`

### Phase 10：端到端验收与容量门禁

目标：用隔离数据和真实来源证明合同，而不是只跑 mock 单测。

受控矩阵：

1. Binance spot：BTCUSDT，1m，较短 REST-only 范围。
2. Binance spot：BTCUSDT，1m，大范围 archive + REST tail。
3. Binance spot：BTCUSDT，1h + 45m + 89m，source 去重和 materialization。
4. 多商品：BTCUSDT/ETHUSDT/SOLUSDT，多周期混合。
5. ZIP checksum/404 注入，确认 REST fallback。
6. 运行中启用超小 row limit 并触发统一 GC，确认 protected floor。
7. 完成后重启，再触发 GC，确认 floor 仍有效。
8. 取消、磁盘阻塞、恢复。

必须使用临时 KLINES_DB_PATH 或生产库副本；禁止为了验收在真实生产 DB 上执行 delete/VACUUM。

证据输出：

```text
docs/perf-baselines/manual-history/
  phase10-contract-<date>.json
  phase10-capacity-<date>.json
  phase10-gc-restart-<date>.json
  phase10-archive-rest-parity-<date>.json
```

证据至少记录：commit、feature flags、DB path 是否临时、目标矩阵、每个目标 effective/sealed range、verified result、source route、网络请求数、写入行数、物理字节、GC before/after、重启结果。

全量检查：

```powershell
Set-Location H:\program\CandleScope\backend
.\.venv\Scripts\python.exe -m pytest -q

Set-Location H:\program\CandleScope\frontend
npm run check
```

如果仓库已有与本功能无关的已知失败，必须分别记录 baseline 与新增回归；不能把失败静默忽略，也不能修改无关测试来伪造全绿。

退出门禁：所有不可变合同均有自动测试和至少一次受控真实链路证据。

建议提交：`manual-history phase10: add release evidence and acceptance gates`

### Phase 11：默认关闭发布与回滚演练

目标：先发布保护感知代码，再开放写入功能。

发布顺序：

1. 发布 Phase 2 保护感知 GC，manual feature 仍关闭。
2. 验证现有 inventory/GC/backfill 无回归。
3. 发布完整后端和前端，manual feature 仍关闭。
4. 在受控环境设置 `MANUAL_HISTORY_DOWNLOAD_ENABLED=1` 做 Phase 10。
5. 通过后才在正式本地配置启用。

回滚合同：

- 关闭 `MANUAL_HISTORY_DOWNLOAD_ENABLED`：停止创建新任务，隐藏/禁用写入入口；已有 durable protections 必须继续生效。
- 关闭 `HISTORY_ARCHIVE_ENABLED`：只禁用 ZIP 加速，REST 正确性路径继续可用。
- 回滚前端：库存只读工作台仍可用。
- 后端只能回滚到 Phase 2 之后的“保护感知基线”。一旦存在 manual collection，回滚到不认识 protection floor、仍直接 startup delete 的旧 binary 是禁止操作。
- schema 只向前兼容；回滚不 DROP 新表、不删除 collection/protection。
- release manifest 必须记录 protection-aware rollback commit 和 flag 操作。

回滚演练：

1. 创建并完成一个受保护 collection。
2. 关闭 manual feature，重启。
3. 运行 GC dry-run 和受控执行。
4. 验证 collection range 仍精确连续。
5. 重新启用，确认历史 job/collection 可读取。

退出门禁：默认关闭包、启用包和回滚演练都有证据；不存在“回滚后 GC 不认识用户数据”的路径。

建议提交：`manual-history phase11: freeze guarded release and rollback baseline`

---

## 10. 测试总表

| 层级 | 必须验证 |
|---|---|
| 模型/Repository | schema 幂等、CAS、事务、idempotency、跨重启 |
| Planner | 多选展开、语义去重、native/derived、日历、空间、plan hash |
| Backfill | 分块、优先级、取消、限流、trusted finality |
| Archive | monthly/daily、cache singleflight、checksum、REST fallback/tail |
| Materializer | 多 custom 共用 base、分页 carry、闭合性、聚合 parity |
| Seal | 精确连续、尾部刷新、false/unknown fail closed |
| GC | floor clamp、执行重验、startup、row limit、budget conflict |
| Runtime | 启动顺序、任务恢复、shutdown、reservation |
| API | 严格 payload、只读 plan、幂等 create、cancel、release-not-delete |
| Frontend | 多选、唯一 start、计划失效、状态渲染、轮询恢复、i18n |
| E2E | 真实 ZIP + REST、自定义、重启、GC 并发、回滚 |

特别禁止的伪验收：

- 只检查 status code 200；
- 只看进度到 100%；
- 只比较行数；
- 只在 feature flag 关闭时跑测试；
- 只验证空数据库，不验证已有断片和重复数据；
- 为了让 GC 测试通过而关闭 row limits/auto GC；
- 用生产数据库直接演练破坏性删除。

---

## 11. 观测与诊断

`DataEngineRuntime` snapshot 增加：

```json
{
  "manual_history": {
    "enabled": true,
    "queued_jobs": 1,
    "active_jobs": 1,
    "active_targets": 2,
    "blocked_storage_jobs": 0,
    "active_reservation_bytes": 123456,
    "recoveries": 0,
    "last_error": null
  }
}
```

建议 metrics：

```text
manual_history_jobs_created_total
manual_history_jobs_succeeded_total
manual_history_jobs_partial_total
manual_history_jobs_failed_total
manual_history_jobs_blocked_storage_total
manual_history_targets_ready_total
manual_history_archive_objects_imported_total
manual_history_rest_fallbacks_total
manual_history_rows_written_total
manual_history_verification_failures_total
manual_history_recoveries_total
manual_history_gc_blocked_bytes
```

日志不得记录代理凭据、API key 或完整远程签名 URL。日志需要的身份只有 exchange/market/symbol/interval/job/collection/object key 和有界错误信息。

---

## 12. 完成定义（Definition of Done）

只有同时满足以下条件才可把文档状态改为“已实现”：

- [ ] 用户可多选商品和周期，只输入开始时间。
- [ ] 公开 API 不接受用户结束时间。
- [ ] 每个目标显示 effective start 和明确 sealed end。
- [ ] 原生周期、可精确合成的自定义周期均可完成。
- [ ] 多个自定义目标共享基础周期网络下载。
- [ ] 大范围 Binance 历史使用官方 ZIP；小范围/尾部/失败回退 REST。
- [ ] ZIP 与 REST 路径最终使用相同精确连续性门禁。
- [ ] Job 可取消、可跨进程恢复、状态诚实。
- [ ] READY 只在 `verify_contiguous_range is True` 后出现。
- [ ] transient protection 在数据写入前生效并持久化。
- [ ] durable protection 跨重启有效。
- [ ] startup cleanup、auto GC、manual GC、row limits 均不能越过 protected floor。
- [ ] 预算无法满足时报告 blocking owners，不删除用户数据。
- [ ] release protection 不等于物理删除。
- [ ] 数据工作台库存仍保持只读查询语义。
- [ ] targeted backend/frontend tests、全量回归、真实 archive/REST、GC restart、rollback drill 都有证据。
- [ ] 正式回滚目标不早于 protection-aware baseline。

---

## 13. 推荐提交序列

```text
1. phase0 contract/config/baseline
2. phase1 repository/schema
3. phase2 durable protection + GC floor
4. phase3 read-only planner/API
5. phase4 native job runner
6. phase5 archive explicit demand
7. phase6 custom materialization/source dedupe
8. phase7 recovery/cancel/storage blocking
9. phase8 stable API/inventory ownership
10. phase9 frontend workbench flow
11. phase10 tests/evidence
12. phase11 release/rollback contract
```

每个提交都应能独立通过该 Phase 的退出门禁。不要把 GC 基础、下载器、UI 和发布开关压成一个无法安全回滚的大提交。
