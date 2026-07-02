# Cache GC 与存储清理实施计划

> 目标：把 CandleScope 的前端内存缓存、后端 DataManager 内存缓存、指标运行时缓存和 SQLite K 线存储清理，逐步升级成可观测、可预估、可分层执行的 GC 系统。本文是实施计划，不代表当前行为已经全部具备。

## 核心结论

GC 不应该做成一个横跨前后端的单体模块。

正确形态是：

```text
执行模块分开：
  frontend cache GC
  backend memory GC
  backend storage GC

策略语言统一：
  active / subscribed / warm / cold
  budget / dry-run / diagnostics / report
```

原因：

- 前端 GC 管浏览器内存、当前图表数组、watchlist 预热数组、指标结果数组和页面交互流畅度。
- 后端内存 GC 管 DataManager `BarCache`、ephemeral interval cache、stream lease、subscriber 和指标/Pyne runtime cache。
- 后端存储 GC 管 SQLite 行数、DB 文件、WAL、checkpoint/VACUUM、数据保留策略和 backfill 后的可恢复性。
- 前端不应该删除数据库；后端也不应该替前端决定哪个 UI 缓存数组最该保留。

## 实施状态

| 阶段 | 状态 | 当前结果 |
|---|---|---|
| Phase 1：诊断先行 | 已完成 | 设置页已有只读缓存与存储诊断；前端主图、watchlist full、指标结果缓存可生成 snapshot；后端 `/settings/cache-diagnostics` 返回 DataManager cache、SQLite 文件/series 和 Pyne cache 诊断。 |
| Phase 2：前端 GC dry-run | 已完成 | `features/cache-gc/cachePolicy.js` 提供 `planFrontendGc()`；设置页可预估前端缓存清理，输出 victims、预计释放 bars/points/bytes，并默认保护 active/subscribed 条目。 |
| Phase 3：前端真实 trim | 已完成基础版 | 设置页可手动执行前端 warm/cold 缓存清理；主图 cache、watchlist full cache、indicator result cache 各自拥有 trim primitive；active chart 和 live/subscribed watchlist 条目默认受保护。自动 idle/visibility 触发尚未启用。 |
| Phase 4：后端内存 GC | 已完成基础版 | `data_manager/gc.py` 可对 DataManager BarCache 生成 dry-run/execute report；active stream、event bus subscriber、stream lease 默认受保护；非 ephemeral 冷缓存整条删除，ephemeral 只裁旧 bars；设置页和 `/settings/cache-gc/backend-memory/*` 可预估/执行。 |
| Phase 5：数据库 GC dry-run | 已完成基础版 | `RetentionService.plan_storage_gc()` 按当前 DB retention limits 只读计算 would-delete rows、估算释放空间、checkpoint/VACUUM 建议和风险标记；设置页和 `/settings/cache-gc/storage/dry-run` 只能预估，不提供真实删除入口。 |
| Phase 6：数据库真实 GC | 已完成基础版 | `/settings/cache-gc/storage/run` 需要 `confirm=true`，在 maintenance lock 下按 dry-run plan 分批删除 oldest rows，删除后 invalidate 受影响 DataManager cache，并执行 WAL truncate checkpoint；`/settings/cache-gc/storage/vacuum` 是单独手动入口。 |
| Phase 7：统一设置面板 | 已完成基础版 | 设置页“缓存与存储 GC”以三类 scope 展示前端内存、后端内存、SQLite 的状态；dry-run、执行、VACUUM 动作分区呈现，执行后旧计划不再保持可执行状态。 |
| Phase 8：后端存储意图注册 | 已完成基础版 | 新增 `StorageIntentRegistry`，把 watchlist、full、price-only、none、active stream、indicator、alert、自定义周期等行为注册为 SQLite retention intent；storage GC 会按 exact/wildcard intent 提高 `keep_rows` 并标记 `storage-intent` 风险。 |
| Phase 9：智能 GC dry-run v2 | 已完成基础版 | 新增前端浏览器 heap/storage 压力探测、后端进程/磁盘压力探测、SQLite 行为热度学习表和 GC 价值评分；dry-run victims 输出 `scores`、`restoreCostReason`、`reuseReason`、`matchedIntents`，指标缓存支持 line-only range trim。 |
| Phase 10：保守自动 GC | 已完成基础版 | 新增前端 `autoGcPolicy` 与后端 `AutoGcPolicy`/`run_auto_gc_once()`；系统默认开启保守自动 GC，仍先生成 smart plan，再只执行高置信 victim，保护 active/subscribed、近期访问、storage intent、自定义周期和低分候选；后端写入 `cache_gc_audit.jsonl` 审计。 |

## 当前基线

### 前端活动 K 线缓存

当前主图 K 线缓存位于：

```text
frontend/src/features/market-data/useChartDataRuntime.js
```

形态：

- `chartDataCacheRef = new Map()`。
- key 由 exchange、marketType、symbol、interval 组成。
- 会 merge 历史数据和 patch 实时 tick。
- symbol change 时会整体清空 cache。

不足：

- 没有每个 series 的 bars 上限。
- 没有 TTL、LRU、lastAccess、内存估算。
- 没有区分 active chart、warm prefetch、cold cache。

### 前端 watchlist full cache

当前后台全量自选 K 线缓存位于：

```text
frontend/src/features/watchlist-full-cache/
```

形态：

- `watchlistFullCacheStore.js` 使用全局 `Map`。
- `useWatchlistFullCacheRuntime.js` 固定预加载最近 500 根。
- 预加载最多 16 个 job，并发 2。
- WebSocket patch 会持续更新缓存行。

不足：

- 没有总 bars/bytes 预算。
- 没有对不再 full tier 的 symbol 做主动淘汰。
- 没有按可见性、最近访问、当前主图优先级调整保留策略。

### 前端指标结果缓存

当前指标结果缓存位于：

```text
frontend/src/features/indicators/indicatorResultCacheStore.js
```

形态：

- 最多保留 80 个 entry。
- LRU 由 `Map` 删除重插实现。
- key 包含交易所、市场、symbol、interval、脚本/参数/颜色上下文。

不足：

- 限制的是 entry 数，不是 points 或 bytes。
- 单个 entry 可能包含大量 lines、markers、fills、hlines、bgcolors、barcolors、signals。
- 对底层 K 线 range 被替换后的局部失效能力还不够明确。

### 后端 DataManager 内存缓存

当前后端 K 线内存缓存位于：

```text
backend/app/data_engine/data_manager/cache.py
backend/app/data_engine/data_manager/config.py
```

形态：

- 每个 series 有固定 bars 容量。
- series 数量超过 `max_series` 后 LRU 淘汰。
- ephemeral interval 有单独 bars 上限。
- TTL 逻辑存在，但默认 `ttl_seconds = 0`，即不启用。

不足：

- GC 不看进程内存压力。
- series LRU 不知道 stream lease 和业务优先级。
- ephemeral trim 周期固定，且只处理 ephemeral series。
- 对活跃订阅和冷缓存的保护/淘汰规则还不够显式。

### 后端 SQLite 存储清理

当前 retention 位于：

```text
backend/app/data_engine/data_manager/retention.py
backend/app/data_engine/storage/klines_repo.py
backend/app/api/v1/settings.py
```

形态：

- DB retention 按 tier 固定保留条数。
- minutes 默认保留 200000 根。
- hours 默认保留 50000 根。
- daily 默认不限。
- 启动时执行一次 `run_startup_db_cleanup()`。
- 设置接口可更新 limits，但 DB limits 主要在下次启动清理时生效。

不足：

- 没有运行中 DB GC daemon。
- 没有 dry-run。
- 没有磁盘高水位/低水位。
- 没有 DB/WAL size 诊断。
- 删除行后没有统一 checkpoint/VACUUM 策略。
- 前端数据库管理面板仍是 mock inventory，不代表真实 DB 状态。

## 统一术语

所有 GC 诊断、计划和报告使用同一套 tier 语言：

| Tier | 含义 | 默认处理 |
|---|---|---|
| `active` | 当前主图正在使用的 symbol/interval/indicator | 强保护，默认不删 |
| `subscribed` | 有 watchlist full、indicator WS 或后端 stream lease | 保护，除非强制或超高水位 |
| `visible` | UI 当前可见但不是主图核心数据 | 中等保护 |
| `warm` | 预热缓存，近期可能用 | 可 trim |
| `cold` | 久未访问或已脱离订阅意图 | 优先回收 |

统一 budget 语言：

```text
frontend:
  max_total_kline_bars
  max_watchlist_bars
  max_indicator_points
  max_estimated_bytes

backend memory:
  max_cache_series
  max_cache_bars
  max_ephemeral_bars_per_series
  ttl_seconds

backend storage:
  db_limits_by_interval_tier
  db_size_high_watermark_bytes
  db_size_low_watermark_bytes
  wal_size_high_watermark_bytes
```

统一执行模式：

```text
diagnostics:
  只读快照

dry-run:
  计算会删什么、释放多少、为什么删，但不修改状态

execute:
  执行清理，返回实际删除/裁剪结果

report:
  每次 dry-run/execute 都返回可展示、可记录的摘要
```

## 非目标

- 不把前端缓存、后端内存缓存和 SQLite 数据清理塞进一个大模块。
- 不提供模糊的“清理全部”按钮。
- 不让前端直接删除 SQLite 数据。
- 不让后端根据 UI 组件内部状态直接清前端数组。
- 不在没有 dry-run 和报告前执行数据库删除。
- 不把 retention GC 和 backfill 修复混成一个流程；GC 可以触发 cache invalidation，但不应该伪装成数据修复。

## 目标架构

### 前端

建议新增：

```text
frontend/src/features/cache-gc/
  cacheEntryModel.js
  cacheRegistry.js
  cacheDiagnostics.js
  cachePolicy.js
  cacheGcRuntime.js
```

职责：

- `cacheRegistry.js`：让 chart data、watchlist full cache、indicator result cache 注册 snapshot/dryRun/trim 能力。
- `cacheEntryModel.js`：统一 entry 字段，例如 owner、key、tier、bars、points、estimatedBytes、lastAccessMs。
- `cachePolicy.js`：根据 budget 和 tier 计算 victims。
- `cacheDiagnostics.js`：生成 UI 可读的只读快照。
- `cacheGcRuntime.js`：处理触发时机，例如 `requestIdleCallback`、`visibilitychange`、预算超限、用户手动清理。

前端缓存所有权保持原样：

| 缓存 | 继续归属 | 新增能力 |
|---|---|---|
| 活动图表 K 线 | `features/market-data` | snapshot、touch、trim |
| watchlist full K 线 | `features/watchlist-full-cache` | snapshot、touch、trim、drop cold |
| 指标结果 | `features/indicators` | snapshot、point-budget LRU、trim range |

### 后端

建议新增或扩展：

```text
backend/app/data_engine/data_manager/gc.py
backend/app/data_engine/data_manager/retention.py
backend/app/api/v1/settings.py
```

职责：

- `gc.py`：运行时内存 GC 计划和执行，保护 active/subscribed series。
- `retention.py`：继续负责 DB/ephemeral retention，可增加运行中 storage GC。
- `settings.py`：暴露 diagnostics、dry-run、execute API。

后端缓存所有权保持原样：

| 资源 | 继续归属 | 新增能力 |
|---|---|---|
| BarCache | `data_manager/cache.py` | priority-aware trim、dry-run snapshot |
| ephemeral interval cache | `retention.py` + `cache.py` | active-aware trim |
| SQLite K 线 | `retention.py` + `storage/klines_repo.py` | storage dry-run、batch delete、checkpoint/VACUUM 建议 |
| Pyne cache | `indicator/pyne` runtime | diagnostics 聚合，后续可接入 clear/dry-run |

### API

建议最终形成：

```text
GET  /api/v1/settings/cache-diagnostics
POST /api/v1/settings/cache-gc/frontend-report
POST /api/v1/settings/cache-gc/backend-memory/dry-run
POST /api/v1/settings/cache-gc/backend-memory/run
POST /api/v1/settings/cache-gc/storage/dry-run
POST /api/v1/settings/cache-gc/storage/run
POST /api/v1/settings/cache-gc/storage/vacuum
```

说明：

- 前端本地 GC 不需要后端执行，但可以把前端 snapshot 放进设置面板统一展示。
- 后端 memory GC 和 storage GC 必须分开按钮和 API。
- storage run 必须支持 dry-run 先行，并返回可解释 victims。

## 实施阶段

### Phase 0：边界确认

目标：只确认模型，不改变行为。

工作：

1. 确认三类 GC：
   - frontend memory GC
   - backend memory GC
   - backend storage GC
2. 确认统一 tier 和 budget 术语。
3. 确认每类资源的 owner。
4. 确认设置面板最终只做编排和展示，不直接拥有清理算法。

退出标准：

- 维护者能说清“谁有权删什么”。
- 没有任何实际清理行为。

### Phase 1：诊断先行

目标：让当前缓存和存储占用可见，但不清理。

前端工作：

1. 新增 `features/cache-gc` 基础目录。
2. 为 chart data cache 增加 snapshot：
   - series count
   - total bars
   - entries
   - active key
   - estimated bytes
3. 为 watchlist full cache 增加 snapshot：
   - series count
   - total bars
   - full/subscribed symbol count
   - entries
   - stale/cold count
4. 为 indicator result cache 增加 snapshot：
   - entry count
   - total line points
   - total annotation items
   - largest entries
   - estimated bytes
5. 暂不执行 trim。

后端工作：

1. 扩展 DataManager diagnostics：
   - cache total series/bars
   - max series/bars
   - top largest series
   - active/subscribed series count
2. 增加 SQLite 文件诊断：
   - db size
   - wal size
   - shm size
   - series count
   - total row estimate
3. 聚合 Pyne cache stats。
4. 暂不执行清理。

UI 工作：

1. 设置面板新增只读“缓存与存储诊断”区域。
2. 明确标注前端、本机后端内存、SQLite 存储三块。

退出标准：

- 打开设置面板能看到前端缓存、后端 cache、DB/WAL 的只读摘要。
- 没有删除、trim、VACUUM 行为。
- 现有测试保持通过。

### Phase 2：前端 GC dry-run

目标：先计算计划，不实际改缓存。

工作：

1. 实现前端 `planFrontendGc(policy)`。
2. 为每个缓存 owner 返回可回收候选：
   - owner
   - key
   - tier
   - bars/points/items
   - estimated bytes
   - reason
3. 统一排序：
   - cold 优先
   - warm 其次
   - visible 谨慎
   - active 不选
4. 输出 dry-run report。

示例 report：

```json
{
  "mode": "dry-run",
  "wouldFreeBars": 12000,
  "wouldFreeIndicatorPoints": 80000,
  "victims": [
    {
      "owner": "watchlist-full-cache",
      "key": "binance:spot:ETHUSDT::1m",
      "tier": "cold",
      "reason": "not-full-tier-and-idle"
    }
  ]
}
```

退出标准：

- dry-run 多次执行结果稳定。
- 当前主图不会出现在 victims 中。
- 用户能从 reason 理解为什么会被清理。

### Phase 3：前端真实 trim

目标：在前端真正释放 warm/cold 缓存，但保护当前体验。

工作：

1. chart data cache：
   - 当前 active series 默认不删。
   - 非当前 series 可整条删除。
   - 当前 series 只允许裁旧 bars，不允许清空。
2. watchlist full cache：
   - 不再 full tier 的 symbol 优先删除。
   - full tier 但冷门 interval 只保留最近 N 根。
   - 当前 symbol/current interval 提权保护。
3. indicator result cache：
   - 从 entry 数限制升级为 points/budget 限制。
   - 大 entry 优先按 range 裁剪旧点。
   - 无法安全裁剪的 entry 才整体删除。
4. 触发时机：
   - 用户手动清理前端缓存。
   - 切 symbol/market 后 idle 清理。
   - 页面隐藏时清理 warm/cold。
   - 超预算后自动计划并在 idle 时执行。

退出标准：

- 当前图表不闪屏、不丢实时 tick。
- 返回刚看过的 symbol 时允许重新加载，但不能出现错误状态。
- 指标显隐、参数切换、range patch 行为保持正常。

### Phase 4：后端内存 GC

目标：让 DataManager 内存 cache 可以按活跃度清理。

工作：

1. 新增 `backend/app/data_engine/data_manager/gc.py`。
2. 实现 `plan_memory_gc(dry_run=True)`：
   - 读取 BarCache snapshot。
   - 读取 event bus subscriber count。
   - 读取 stream leases。
   - 标记 active/subscribed/warm/cold。
3. 实现 `run_memory_gc()`：
   - active/subscribed 默认不删。
   - 非 ephemeral 且冷的 cache series 可直接删，因为 SQLite 可回读。
   - ephemeral 只能裁旧 bars，不能假设 storage 可恢复。
4. 将结果写入 DataManager diagnostics。

退出标准：

- 后端内存 GC 后 active stream 不断。
- 对非 ephemeral series 的缓存删除后，查询可以从 SQLite 回读。
- 对 ephemeral series 的裁剪不触发 storage/backfill 假象。

### Phase 5：数据库 GC dry-run

目标：数据库删除前必须能预估。

工作：

1. 扩展 retention policy：
   - tier row limits
   - optional time limits
   - optional disk high/low watermark
2. 实现 `plan_storage_gc(dry_run=True)`：
   - list series
   - 计算 current rows
   - 计算 keep rows
   - 计算 would delete rows
   - 估算 would free bytes
3. 标记风险：
   - active/subscribed symbol
   - custom interval
   - latest data too close to now
   - DB size high watermark
   - WAL high watermark

示例 report：

```json
{
  "mode": "dry-run",
  "dbSizeBytes": 123456789,
  "walSizeBytes": 2345678,
  "wouldDeleteRows": 230000,
  "vacuumRecommended": true,
  "series": [
    {
      "exchange": "binance",
      "marketType": "spot",
      "symbol": "BTCUSDT",
      "interval": "1m",
      "currentRows": 428360,
      "keepRows": 200000,
      "wouldDeleteRows": 228360,
      "reason": "minutes-tier-retention"
    }
  ]
}
```

退出标准：

- dry-run 不修改 DB。
- dry-run 与现有 `delete_oldest_klines()` 的保留语义一致。
- UI 能展示会删哪些 series 和为什么。

### Phase 6：数据库真实 GC

目标：安全执行数据库清理。

工作：

1. 使用 maintenance lock，避免和 repair/gap scan 并发写库。
2. 分批删除 oldest rows，避免长事务锁死。
3. 删除后 invalidate 受影响 DataManager cache。
4. 执行 WAL checkpoint：
   - 优先 `PRAGMA wal_checkpoint(TRUNCATE)`。
5. `VACUUM` 默认不自动执行，只提供手动按钮或明确配置。
6. 写入 GC report：
   - deleted rows
   - affected series
   - elapsed ms
   - errors
   - checkpoint result
   - vacuum recommendation/result

退出标准：

- 删除期间 API 不崩。
- 删除后 continuity/gap scan 能正确解释剩余数据。
- DB 文件压缩行为必须明确可控，不隐藏在普通 GC 中。

### Phase 7：统一设置面板

目标：让用户能理解和控制清理，而不是面对一个危险的“清理全部”按钮。

建议 UI 分区：

```text
前端内存
  chart bars
  watchlist bars
  indicator points
  dry-run
  清理 warm/cold 前端缓存

后端内存
  DataManager cache series/bars
  ephemeral series
  Pyne cache stats
  dry-run
  清理后端内存缓存

数据库
  DB size
  WAL size
  series count
  dry-run retention
  执行数据库清理
  压缩数据库文件
```

按钮文案：

```text
预估前端缓存清理
清理前端 warm/cold 缓存
预估后端内存清理
清理后端内存缓存
预估数据库清理
执行数据库清理
压缩数据库文件
```

退出标准：

- 所有破坏性动作前都有 dry-run 或明确确认。
- 前端内存、后端内存、数据库存储三个动作不会混淆。
- report 可复制，便于排查误删或异常。

## 推荐第一批代码切片

第一批只做 Phase 1，避免过早引入删除行为。

范围：

1. 新增前端 `features/cache-gc` 只读 registry。
2. 给 chart data cache 增加 snapshot。
3. 给 watchlist full cache 增加 snapshot。
4. 给 indicator result cache 增加 snapshot。
5. 后端增加 DB/WAL size diagnostics。
6. 设置面板只读展示这些信息。

不做：

- 不 trim。
- 不 delete。
- 不 VACUUM。
- 不改变现有缓存命中路径。

验收：

```text
frontend:
  eslint/build 通过
  现有 cache/indicator/watchlist 单测通过

backend:
  compileall 通过
  相关 diagnostics/settings 测试通过

manual:
  打开设置面板看到三块诊断
  主图切换、watchlist full、指标显示保持现状
```

## 测试策略

### 前端单测

新增或扩展：

```text
frontend/src/features/cache-gc/__tests__/
frontend/src/features/watchlist-full-cache/__tests__/
frontend/src/features/indicators/__tests__/
frontend/src/features/market-data/__tests__/
```

覆盖：

- active entry 不进入 victims。
- cold entry 优先进入 victims。
- point-budget 超限时指标 cache 选择最大/最旧 entry。
- watchlist full cache 对非 full tier symbol 做优先淘汰。
- dry-run 不修改 cache。

### 后端单测

新增或扩展：

```text
backend/tests/test_data_manager_gc.py
backend/tests/test_settings_cache_gc_api.py
backend/tests/test_storage_retention_gc.py
```

覆盖：

- active/subscribed series 不被 memory GC 删除。
- 非 ephemeral cold cache 可以删除，并能从 storage 回读。
- ephemeral 只裁内存，不触发 storage/backfill。
- storage dry-run 不删除行。
- storage run 分批删除并 invalidate cache。

### 手动验证

最低手动路径：

1. 启动后端和前端。
2. 打开 BTCUSDT 主图。
3. 添加 watchlist full symbol。
4. 添加 2-3 个指标。
5. 查看 cache diagnostics。
6. 执行前端 dry-run。
7. 执行前端 warm/cold 清理。
8. 确认主图和指标仍正常。
9. 执行后端 memory dry-run。
10. 执行数据库 dry-run，不执行真实删除。

## 风险与约束

### SQLite 删除风险

风险：

- 长事务锁住查询。
- 删除后 DB 文件不变小，用户误以为没清。
- VACUUM 耗时并锁库。

控制：

- 先 dry-run。
- 分批删除。
- checkpoint 与 VACUUM 分开。
- VACUUM 默认手动触发。

### 指标缓存风险

风险：

- 裁剪旧 range 后，指标线和 annotation 不一致。
- Pyne/custom 输出点数量远大于内置指标。

控制：

- 先按 entry 删除，再逐步升级 range trim。
- 所有输出类型统一计算 points/items。
- 对无法安全裁剪的复杂输出整体淘汰。

### watchlist full cache 风险

风险：

- 清掉后台缓存导致切换 symbol 变慢。
- 清掉正在 full 订阅的 symbol，造成体验抖动。

控制：

- full tier 提权为 subscribed。
- 当前主图 symbol 提权为 active。
- 非 full tier 和久未访问 symbol 优先清。

### 后端 memory GC 风险

风险：

- 清掉仍有 consumer 的 series。
- ephemeral 数据没有 storage backing，误删无法恢复。

控制：

- 读取 subscriber count 和 stream lease。
- ephemeral 默认只裁旧 bars，不整条删除 active series。
- 非 ephemeral 删除后依赖 SQLite 回读。

## 完成定义

整个 GC 系统完成时，应满足：

1. 用户可以看到前端内存、后端内存、SQLite 存储的真实诊断。
2. 所有清理动作都有 dry-run。
3. 前端缓存清理不会影响当前主图。
4. 后端内存清理不会断 active stream。
5. 数据库清理按 retention 分批执行，并能报告删除结果。
6. SQLite checkpoint/VACUUM 有明确、可控的入口。
7. 设置面板中前端、后端、数据库三类动作边界清楚。
