# CandleScope 零可见缺口检测与补全设计文档

本文目标是把当前“发现缺口后尽量回补”的机制升级为“图表可见范围内不允许出现未处理缺口”的机制。

这里的“零可见缺口”不是无条件伪造交易所不存在的 K 线，而是：

- 如果交易所有真实历史 K 线，系统必须自动发现、精确拉取、写库、验证，并让图表刷新到连续状态。
- 如果交易所接口暂时失败，图表不能把断裂当作正常行情展示，必须进入修复中状态并持续重试。
- 如果交易所明确没有这段数据，系统必须把它标记为 `source_empty`，前端按显式策略展示，不能让用户误以为数据链路漏了。
- 当前尚未闭合的 K 线不计入历史缺口。

## 1. 当前问题判断

当前补缺口主链路已经存在：

```text
QueryEngine / ContinuityLayer / Settings scan
        -> DataManager._submit_missing_ranges()
        -> BackfillCoordinator
        -> BackfillEngine detect/plan/fetch/reconcile/publish
        -> storage
        -> DataManager.on_bars_backfilled()
        -> WebSocket backfill_completed
        -> frontend reload
```

但它还不是“零可见缺口”机制，主要短板如下。

### 1.1 查询范围驱动，不是可见范围强保证

`/klines/history` 只按 `days` 计算 `[now - days, now]`：

- 文件：`backend/app/api/v1/klines.py`
- 位置：`get_klines_history()`

前端如果图上存在更早的左侧加载数据，`recoverGaps()` 仍然只重拉默认 `days`，不会精准请求缺口范围。

### 1.2 手动扫描只看最近 2000 根

`MaintenanceService.scan_and_fill_gaps()` 内部缺口扫描只取最近 `limit=2000`：

- 文件：`backend/app/data_engine/data_manager/maintenance.py`
- 风险：历史深处的大缺口不会被发现。

### 1.3 启动扫描只补尾部

`BackfillCoordinator.startup_scan()` 只检查 DB 最新时间是否落后 live edge：

- 文件：`backend/app/data_engine/data_manager/backfill_coordinator.py`
- 风险：启动时不会全量扫 interior gaps。

### 1.4 前端补缺口不是精准 range 修复

`frontend/src/App.jsx` 的 `recoverGaps()` 检测到 gap 后重拉 full history：

```text
detectGaps(chartData)
    -> fetchKlinesHistory(symbol, interval, getIntervalDays(...))
```

问题：

- 对老缺口不可靠，因为默认 days 覆盖不到。
- 对多个分散缺口浪费请求。
- 对失败缺口没有持久状态和明确 retry 上限。

### 1.5 前端合并策略会让旧数据覆盖新数据

`mergeByTime(older, current)` 通过 `Map.set(time, item)` 去重，后面的 `current` 赢。

调用处经常是：

```js
mergeByTime(result.data, prev)
```

这会让已有图表数据覆盖 backfill 之后重新拉到的历史数据。对“缺失 timestamp”可以补，但对修正 OHLCV 不够可靠。

## 2. 设计目标

### 2.1 硬目标

- 图表渲染前，当前可见范围加 buffer 必须通过连续性验证。
- 可见范围发现缺口时，优先级最高，立即触发精准回补。
- 回补完成后必须二次验证；验证失败不能宣布成功。
- 后端必须维护缺口台账，避免重复发现、重复请求、无限 retry。
- 前端不再靠默认 `days` 猜测补缺口范围。

### 2.2 不做的事

- 默认不伪造 K 线。
- 默认不把交易所明确缺失的数据静默补成上一根 close。
- 默认不压缩时间轴来掩盖真实数据缺失。

如果产品层强制要求“视觉上绝对没有断裂”，可以开启显式的 `visual_continuity_mode=synthetic_flat`，但 synthetic bar 必须带 `synthetic=true`、`volume=0`、`source=synthetic_gap_fill`，并且所有指标默认排除 synthetic 数据。

## 3. 新架构总览

```text
Frontend Viewport
    |
    | exact range + continuity requirement
    v
GET /klines/range?start_ms&end_ms&strict=true&repair=auto
    |
    v
DataManager.ensure_contiguous_range()
    |
    +--> cache check
    +--> storage exact range query
    +--> continuity detector
    +--> GapLedger upsert
    +--> BackfillCoordinator priority repair
    +--> verification scan
    |
    v
Response: data + continuity + repair_ticket + missing_ranges + unfillable_ranges
    |
    v
Frontend GapGuard
    |
    +--> render verified range
    +--> or show repairing overlay and subscribe to repair events
```

后台同时运行完整审计：

```text
GapAuditScheduler
    -> page through tracked series
    -> SQL LAG / chunk detector
    -> GapLedger
    -> BackfillCoordinator low-priority queue
    -> verify after write
```

## 4. 核心概念

### 4.1 Visible Range

前端当前图表实际展示的时间范围。

每次加载、缩放、拖动、切换周期、切换交易所时，前端都把 visible range 加 buffer 后发给后端：

```text
request_start = visible_start - 2 * viewport_width
request_end   = visible_end   + 1 * viewport_width
```

这样用户向左或向右轻微拖动时不会马上看到缺口。

### 4.2 Verified Range

后端承诺某个 `[start_ms, end_ms]` 内所有应该存在的 closed bars 都已经检查过：

```json
{
  "verified_contiguous": true,
  "verified_start_ms": 1777622400000,
  "verified_end_ms": 1777627500000
}
```

只有 verified range 可以无警告渲染。

### 4.3 Gap Range

内部统一使用“真正缺失的 K 线范围”，不再使用边界 K 线范围。

如果已有：

```text
prev = 08:47
next = 08:56
interval = 1m
```

缺失范围必须是：

```text
start_ms = 08:48
end_ms   = 08:55
missing_bars = 8
```

不要再把 `08:47` 和 `08:56` 传给 backfill。

### 4.4 Unfillable Range

交易所返回成功，但范围内没有数据，或交易所明确说明该 symbol/interval 当时未上市、停牌、无成交。

这类范围不能和网络失败混在一起，必须落台账：

```text
status = source_empty | delisted | unsupported_interval
```

前端收到后按产品策略处理。

## 5. 后端设计

### 5.1 新增 GapLedger

新增表：`kline_gap_ledger`

```sql
CREATE TABLE IF NOT EXISTS kline_gap_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    expected_count INTEGER NOT NULL,
    missing_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    reason TEXT NOT NULL,
    repair_ticket TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    resolved_at INTEGER,
    next_retry_at INTEGER,
    metadata_json TEXT,
    UNIQUE(exchange, market_type, symbol, interval, start_ms, end_ms)
);

CREATE INDEX IF NOT EXISTS idx_gap_ledger_status_priority
ON kline_gap_ledger(status, priority, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_gap_ledger_series
ON kline_gap_ledger(exchange, market_type, symbol, interval, start_ms, end_ms);
```

状态机：

```text
detected
    -> queued
    -> repairing
    -> verifying
    -> filled

repairing
    -> retry_wait
    -> queued

repairing/verifying
    -> source_empty
    -> source_unavailable
    -> failed
```

要求：

- 相同 gap range 幂等 upsert。
- 可见范围触发的 gap 设置高优先级。
- retry 使用指数退避。
- `source_empty` 不无限重试，只按较长 TTL 重新验证。

### 5.2 新增 SeriesContinuityState

新增表：`kline_series_continuity`

```sql
CREATE TABLE IF NOT EXISTS kline_series_continuity (
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    earliest_ms INTEGER,
    latest_ms INTEGER,
    last_full_audit_start_ms INTEGER,
    last_full_audit_end_ms INTEGER,
    last_full_audit_at INTEGER,
    last_visible_verify_start_ms INTEGER,
    last_visible_verify_end_ms INTEGER,
    last_visible_verify_at INTEGER,
    open_gap_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(exchange, market_type, symbol, interval)
);
```

用途：

- 快速判断某个 range 是否可能已验证。
- 给后台审计提供断点续扫。
- 给 settings 页面展示每个序列的健康状态。

### 5.3 精准连续性检测器

新增服务：`ContinuityVerifier`

职责：

- 输入一组 bars、interval、range。
- 输出 `missing_ranges`、`tail_gap`、`head_gap`、`verified_range`。
- 所有 range 使用真正缺失范围，不含边界 bar。
- 排除当前未闭合 K 线。
- 支持 fixed interval、monthly interval、custom interval。

伪代码：

```python
def verify_bars(exchange, market_type, symbol, interval, start_ms, end_ms, bars, now_ms):
    step_ms = interval_policy.step_ms(interval, anchor=start_ms)
    closed_end_ms = floor_to_last_closed_open(end_ms, step_ms, now_ms)

    expected = expected_opens(start_ms, closed_end_ms, interval)
    actual = {bar.open_time for bar in bars}

    missing = []
    current_start = None
    previous_missing = None

    for open_time in expected:
        if open_time not in actual:
            if current_start is None:
                current_start = open_time
            previous_missing = open_time
        elif current_start is not None:
            missing.append((current_start, previous_missing))
            current_start = None

    if current_start is not None:
        missing.append((current_start, previous_missing))

    return ContinuityReport(missing_ranges=missing, verified_contiguous=not missing)
```

### 5.4 新增 ensure_contiguous_range

在 DataManager 增加主入口：

```python
def ensure_contiguous_range(
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    *,
    exchange: str,
    market_type: str,
    repair: Literal["none", "async", "wait"] = "async",
    wait_ms: int = 0,
    priority: int = 0,
) -> RangeResult:
    ...
```

行为：

1. 查询 cache + storage。
2. 对返回 bars 做连续性验证。
3. 如果无缺口，返回 `verified_contiguous=true`。
4. 如果有缺口，写入 GapLedger。
5. 如果 `repair=async`，提交高优先级 repair ticket 并立即返回。
6. 如果 `repair=wait`，最多等待 `wait_ms`，然后重新 query + verify。
7. repair 完成后仍有缺口，则返回剩余 missing ranges，不伪装成功。

### 5.5 BackfillCoordinator 优先级队列

当前 coordinator 已有去重和 retry，但需要变成显式优先级：

```text
0   visible_range_blocking
10  visible_range_async
20  websocket_gap
40  user_settings_scan
60  startup_tail
80  background_audit
```

规则：

- 同 series overlapping range 要合并。
- 高优先级 visible repair 可以插队，但不能打断已在进行的同 range repair。
- 每个 exchange/market_type 有独立 rate limit。
- repair 完成后必须进入 `verifying`，不能直接 `filled`。

### 5.6 修复后验证

Backfill 写库后，coordinator 不只根据 `bars_written > 0` 宣布完成。

必须执行：

```text
query storage for requested missing range
    -> ContinuityVerifier.verify()
    -> if contiguous: GapLedger.status = filled
    -> else if source returned empty: source_empty
    -> else retry_wait / failed
```

WebSocket 事件也要带验证结果：

```json
{
  "type": "repair_completed",
  "ticket": "abc123",
  "exchange": "binance",
  "market_type": "spot",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "range": {"start_ms": 1777625280000, "end_ms": 1777625700000},
  "verified_contiguous": true,
  "bars_written": 8,
  "remaining_ranges": []
}
```

### 5.7 后台全量审计

新增：`GapAuditScheduler`

启动策略：

- 启动后 30 秒开始。
- 每轮只扫描 tracked series。
- tracked 来源：用户订阅、预热目标、最近打开过的图表、settings 标记的重要 symbol。
- 对大历史使用分页扫描，避免一次性载入全表。

扫描方式：

```sql
WITH ordered AS (
    SELECT
        open_time,
        LAG(open_time) OVER (ORDER BY open_time) AS prev_open_time
    FROM klines
    WHERE exchange = ?
      AND market_type = ?
      AND symbol = ?
      AND interval = ?
      AND open_time >= ?
      AND open_time <= ?
)
SELECT prev_open_time, open_time
FROM ordered
WHERE prev_open_time IS NOT NULL
  AND open_time - prev_open_time > ?;
```

分页边界必须带上一页最后一根 bar，避免跨页缺口漏检。

### 5.8 API 合约

#### GET `/klines/range`

用于图表主加载。替代前端用 `days` 猜范围。

参数：

```text
symbol
interval
exchange
market_type
start_ms
end_ms
repair = none | async | wait
wait_ms = 0..5000
strict = true | false
```

响应：

```json
{
  "exchange": "binance",
  "market_type": "spot",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "start_ms": 1777622400000,
  "end_ms": 1777627500000,
  "verified_contiguous": false,
  "repair_triggered": true,
  "repair_ticket": "abc123",
  "missing_ranges": [
    {
      "start_ms": 1777625280000,
      "end_ms": 1777625700000,
      "missing_bars": 8,
      "status": "queued"
    }
  ],
  "unfillable_ranges": [],
  "data": []
}
```

当 `strict=true` 且 range 未验证时，后端可以返回 `data=[]` 或返回数据但标记 `renderable=false`。推荐前端不渲染未验证范围。

#### POST `/klines/repair`

用于显式修复一个或多个 range。

```json
{
  "exchange": "binance",
  "market_type": "spot",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "ranges": [
    {"start_ms": 1777625280000, "end_ms": 1777625700000}
  ],
  "priority": 0,
  "wait_ms": 3000
}
```

#### GET `/klines/continuity`

只检测，不修复。用于 settings 和调试。

#### GET `/klines/repair/{ticket}`

查询 repair 状态。

## 6. 前端设计

### 6.1 GapGuard

新增前端概念：`GapGuard`

职责：

- 维护当前 visible range。
- 请求 `/klines/range`，而不是只请求 `/history?days=...`。
- 对返回数据做本地二次 `detectGaps()`。
- 如果发现缺口，调用 `/klines/repair` 或等待 ticket。
- 只有 `verified_contiguous=true` 的数据进入主图。

状态：

```text
idle
loading
verified
repairing
source_empty
failed
```

### 6.2 渲染策略

推荐默认策略：

```text
verified         -> 正常渲染
repairing        -> 保留旧图或展示修复中遮罩，不渲染断裂数据
source_empty     -> 展示明确的数据不可用标记
failed           -> 展示错误状态和重试按钮
current_open_gap -> 不提示
```

如果强制视觉无断裂：

```text
visual_continuity_mode = synthetic_flat
```

规则：

- 只对 `source_empty` 或 repair 超时的 closed range 生效。
- synthetic bar 使用上一根 close 作为 OHLC。
- volume/trades 为 0。
- 数据点带 `synthetic=true`。
- 指标计算默认排除 synthetic bar。
- 图上必须有可关闭的“synthetic data”提示，避免误导交易判断。

### 6.3 合并策略

新增两个合并函数，不再用一个 `mergeByTime()` 解决所有场景。

```js
mergeRealtimeWins(storageBars, liveBars)
mergeServerClosedWins(prevBars, serverBars, now, interval)
```

规则：

- 实时 forming bar：live wins。
- 已闭合历史 bar：server wins。
- backfill reload：server closed wins。
- 当前未闭合 bar：不要被 REST 历史覆盖。

### 6.4 WebSocket 事件

前端订阅：

```text
gap_detected
repair_started
repair_progress
repair_completed
repair_failed
range_verified
```

收到 `repair_completed` 后，不再重拉默认 days，而是重拉事件里的 exact range：

```js
fetchKlinesRangeExact(symbol, interval, start_ms, end_ms)
```

## 7. 自定义周期处理

自定义周期不能只检查聚合后的 bars。

例如 `7m`：

```text
7m chart range
    -> resolve base interval, usually 1m
    -> ensure base 1m contiguous for expanded range
    -> aggregate from verified base range
    -> verify 7m bucket continuity
```

规则：

- 标准周期直接修复自身 interval。
- 自定义周期优先修复 base interval。
- 聚合输出必须带 `base_verified_contiguous`。
- 如果 base 不连续，不允许把聚合结果标记为 verified。

## 8. 当前 K 线与尾部缺口

尾部缺口要避免误判。

对于 interval `1m`：

```text
now = 08:56:25
last closed open <= 08:55:00
08:56:00 是 forming，不算缺口
```

公式：

```python
last_closed_open = floor(now_ms, interval_ms) - interval_ms
```

只有 `db_latest_open < last_closed_open` 才是 tail gap。

## 9. 失败与重试策略

### 9.1 网络失败

```text
status = source_unavailable
retry = exponential backoff: 5s, 15s, 45s, 2m, 5m
max_attempts_before_degrade = 5
```

可见范围失败时前端保持 `repairing` 或 `failed`，不展示断裂为正常图。

### 9.2 交易所限流

- coordinator 按 exchange 分桶。
- visible range 请求可以提高优先级，但不能绕过硬限流。
- 前端显示修复中，等待事件。

### 9.3 交易所无数据

```text
status = source_empty
next_recheck_at = now + 24h
```

不开 synthetic 模式时，前端应展示数据不可用段，而不是静默断裂。

## 10. 配置项

建议新增：

```env
KLINE_STRICT_VISIBLE_CONTINUITY=true
KLINE_VISIBLE_REPAIR_WAIT_MS=3000
KLINE_VISIBLE_RANGE_BUFFER_MULTIPLIER_LEFT=2
KLINE_VISIBLE_RANGE_BUFFER_MULTIPLIER_RIGHT=1
KLINE_GAP_AUDIT_ENABLED=true
KLINE_GAP_AUDIT_INTERVAL_SECONDS=300
KLINE_GAP_AUDIT_PAGE_BARS=5000
KLINE_GAP_MAX_REPAIR_ATTEMPTS=8
KLINE_GAP_SOURCE_EMPTY_RECHECK_SECONDS=86400
KLINE_VISUAL_CONTINUITY_MODE=verified_only
```

`KLINE_VISUAL_CONTINUITY_MODE` 可选：

```text
verified_only
synthetic_flat
compress_time_axis
```

推荐默认：`verified_only`。

`compress_time_axis` 不推荐用于交易图，因为会破坏时间距离语义。

## 11. 验收标准

### 11.1 后端验收

- `/klines/range` 对完整 range 返回 `verified_contiguous=true`。
- `/klines/range` 对缺口 range 返回精确缺失范围，不含边界 bar。
- 可见 range 缺口会写入 GapLedger。
- repair 完成后必须二次验证。
- `source_empty` 与 `source_unavailable` 可区分。
- background audit 能扫出超过最近 2000 根之外的历史缺口。
- custom interval 在 base 缺失时不返回 verified。

### 11.2 前端验收

- 图表主加载不再依赖默认 `days` 补缺口。
- pan/zoom 后 visible range 自动校验。
- backfill completed 后只重拉 exact repaired range。
- 已闭合历史 bar 由 server 数据覆盖旧数据。
- 未验证 range 不以正常断裂形态展示。
- repair 失败有明确状态，不无限 silent retry。

### 11.3 端到端验收

构造测试：

1. 写入 BTCUSDT 1m 连续 100 根。
2. 删除中间 8 根。
3. 打开图表范围覆盖这 100 根。
4. 前端必须进入 repairing。
5. 后端触发 exact repair：只请求缺失 8 根。
6. 写库后 verify。
7. 前端收到事件，重拉 exact range。
8. 图表恢复连续。

断言：

```text
visible_gaps.length == 0
backend.verified_contiguous == true
gap_ledger.status == filled
no default-days reload was used
```

## 12. 分阶段实施路线

### Phase 0：快速止血

目标：先消除当前最明显的漏补和前端覆盖问题。

- 后端 missing range 改为真正缺失范围：
  - query interior gap：`prev + interval` 到 `next - interval`
  - ingestion gap：`last + interval` 到 `current - interval`
  - maintenance gap：同样不含边界 bar
- `/history` 和 `/history/before` 返回 `missing_ranges`。
- 前端 backfill completed 后用 server closed bars 覆盖旧历史 bars。
- 前端 `recoverGaps()` 不再只重拉默认 days，先增加 exact range fetch。

### Phase 1：精准 range API

目标：让图表请求从 `days` 模型切到 exact range 模型。

- 新增 `/klines/range`。
- 新增 `fetchKlinesRangeExact()`。
- 图表加载、左侧加载、repair reload 全部切到 exact range。
- 响应增加 `verified_contiguous`、`repair_ticket`、`missing_ranges`。

### Phase 2：GapLedger 与修复验证

目标：让缺口有状态、有去重、有审计记录。

- 新增 `kline_gap_ledger`。
- BackfillCoordinator 接入 priority queue。
- repair 后进行 verification scan。
- WebSocket 发布 `repair_completed` / `repair_failed` / `range_verified`。

### Phase 3：前端 GapGuard

目标：图表不再渲染未验证断裂范围。

- 增加 visible range tracker。
- 加载数据前请求 `/klines/range?strict=true&repair=wait`。
- wait 超时进入 repairing overlay。
- repair 完成后重拉 exact range。
- 本地 `detectGaps()` 只作为防线，不作为主要修复策略。

### Phase 4：后台全量审计

目标：用户打开图表前，常用序列已经尽量健康。

- 新增 `GapAuditScheduler`。
- settings 页面增加 continuity health。
- 支持指定 symbol/interval/time range 的手动审计。
- 扫描不再限制最近 2000 根。

### Phase 5：可选视觉连续模式

目标：满足“任何情况下视觉上都不能断”的产品诉求。

- 增加 synthetic flat bars 模式。
- synthetic 数据隔离存储或只前端临时生成。
- 指标默认排除 synthetic。
- UI 明确标记 synthetic 区间。

## 13. 测试计划

### 13.1 单元测试

- fixed interval gap detection 精确边界。
- monthly interval gap detection。
- current open candle 不误判 tail gap。
- overlapping gaps 合并。
- GapLedger 状态机。
- BackfillCoordinator priority queue。
- server closed wins merge。

### 13.2 集成测试

- API `/klines/range` 缺口触发 repair。
- repair 写库后 verification 成功。
- source empty 不无限重试。
- custom interval base 缺失时不 verified。

### 13.3 前端测试

- 删除中间 K 线后，图表进入 repairing。
- repair completed 后 exact range reload。
- 重拉后的数据覆盖旧历史 bar。
- pan 到未验证范围时不会显示正常断裂图。

### 13.4 真实库回归

用本地库现有缺口做回归样本：

```text
binance spot BTCUSDT 1m
okx spot BTC-USDT 1m
okx futures ETH-USDT-SWAP 1m
binance spot BTCUSDT 3m
```

验证这些 gap 在 repair 后进入：

```text
filled | source_empty | source_unavailable
```

不能停留在未知状态。

## 14. 关键工程原则

- 先保证 visible range，再做全库洁癖。
- 后端是连续性真相源，前端检测只是最后防线。
- repair 成功必须以二次 verify 为准，不以写入数量为准。
- 不要用默认 `days` 修具体 gap。
- 不要静默伪造 K 线。
- 不要让未验证断裂数据以正常图表形态出现。
- 所有缺口都必须有明确状态：`filled`、`repairing`、`source_empty`、`source_unavailable` 或 `failed`。

## 15. 推荐最终用户体验

正常情况：

```text
用户打开图表
    -> 请求 visible range + buffer
    -> 后端 verified
    -> 图表连续显示
```

发现缺口但可修复：

```text
用户打开图表
    -> 后端发现缺口
    -> wait 3 秒内修复
    -> 返回 verified data
    -> 用户看不到断裂
```

修复超过 3 秒：

```text
用户打开图表
    -> 显示“历史数据修复中”
    -> 后端继续 repair
    -> repair_completed
    -> exact range reload
    -> 图表连续显示
```

交易所无数据：

```text
用户打开图表
    -> 后端标记 source_empty
    -> 前端显示数据不可用段
    -> 不把它伪装成系统漏数据
```

如果开启 synthetic 模式：

```text
source_empty
    -> 前端生成 flat synthetic bars
    -> 图表视觉连续
    -> synthetic 区间明确标记
    -> 指标默认排除
```

