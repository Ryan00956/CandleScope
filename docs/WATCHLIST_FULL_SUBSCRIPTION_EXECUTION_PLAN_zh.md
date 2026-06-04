# Watchlist Full 订阅与后台缓存执行文档

> 目标：把自选栏订阅升级为三档明确语义：`none` 不做任何行情保活，`price` 只保活 ticker 价格流，`full` 保活 ticker 并订阅该商品所有前端可切换 K 线周期，同时由前端后台维护这些周期的 K 线数组，以便商品/周期切换可以快速命中缓存。

## 背景

当前自选栏价格流已经是独立的轻量 ticker 路径：

```text
watchlist sync / tier change
  -> SubscriptionService.set_tier()
  -> DataManager.ensure_price_stream()
  -> IngestionPriceSource
  -> ExchangeIngestionFactory.start_price()
  -> DataManager.on_price_ticks()
  -> PriceSnapshotCache + PRICE_UPDATED
  -> /stream/prices
```

这个路径保留。需要修正的是 `full` tier 的 K 线语义。

当前 `SubscriptionService._activate_full()` 硬编码调用：

```python
await self._data_manager.ensure_stream(raw_symbol, "1m", ...)
```

这会让 `full` 实际变成“价格流 + 后台 1m 基础流保活”。新的目标不是把它改成“当前周期”，而是改成完整的 watchlist full 工作流：

```text
full = ticker price stream
     + 当前交易所/市场下前端可切换的所有 native intervals
     + 用户保存的 custom intervals
     + 前端后台 K 线缓存
     + DataManager 后端流去重和 consumer/refcount 管理
```

## 范围定义

### 三档订阅语义

```text
none:
  不订阅 ticker
  不订阅 K 线
  不维护后台 K 线缓存

price:
  订阅 ticker price stream
  自选栏显示最新价、涨跌、涨跌幅
  不订阅 K 线
  不维护后台 K 线缓存

full:
  订阅 ticker price stream
  订阅该商品所有“前端可切换周期”的 K 线流
  前端后台维护 symbol + interval 的 K 线数组
  主图切换商品/周期时优先读取后台缓存，再异步补齐缺口
```

### “所有时间周期”的定义

“所有时间周期”不是无限枚举所有合法 custom interval，而是前端实际允许用户切换到的周期集合：

```text
allSwitchableIntervals(exchange, marketType)
  = backend exchange plugin capabilities native intervals
  + saved custom interval records
```

来源：

- 交易所默认/native 周期来自后端 exchange plugin 的 `capabilities().native_intervals`。
- 后端通过 `/api/v1/exchanges/` 和 `/api/v1/exchanges/{exchange}/capabilities` 暴露这些 capabilities。
- 前端 `features/chart-session/exchangeCatalogRuntime.js` 调用 `fetchExchanges()`，把返回的 `native_intervals` 转成 `nativeIntervals`。
- 前端内置的 `EXCHANGE_INTERVALS` 只作为 API 失败或 capabilities 缺失时的降级 fallback，不是 full 订阅的首选来源。
- 自定义周期来自 `features/chart-session/customIntervalStore.js`。
- 周期解析与 custom interval 可行性最终仍交给后端 `interval_policy.py`、`StreamEnsurePlanner` 和 `dm.ensure_stream()`。

前端可以声明“我要这些 intervals”，但不能决定 base interval、custom interval decomposition、exchange-specific routing 或后端 priority。

### API 边界

前端不是直接访问 Python 对象里的 `DataManager`，而是通过 DataManager 所在后端提供的 API 表达订阅意图：

```text
frontend
  -> /api/v1/subscriptions...
  -> SubscriptionService
  -> DataManager
  -> DataEngine ingestion
  -> exchange
```

## 目标架构

### Full 订阅主链路

```text
用户把自选 symbol 设为 full
  -> 前端计算 allSwitchableIntervals(exchange, marketType)
  -> PUT /subscriptions/{symbol} { tier: "full", intervals: [...] }
  -> SubscriptionService 保存 tier + intervals
  -> SubscriptionService 激活 price stream
  -> SubscriptionService 为每个 interval 调用 dm.ensure_stream(..., consumer_id=...)
  -> DataManager stream registry 去重/引用计数
  -> StreamEnsurePlanner 决定 prerequisite/base/native
  -> DataEngine ingestion 只为新后端流启动交易所订阅
  -> DataManager event bus fan out 给所有 consumers
  -> 前端后台缓存 runtime 维护各 interval K 线数组
```

### 重复订阅语义

DataManager 必须能够区分“前端订阅”和“后端上游流”：

```text
frontend A full 订阅 BTCUSDT 1h
  -> 后端没有 upstream stream
  -> 启动交易所/ingestion stream
  -> 注册 consumer A

frontend B 或主图也订阅 BTCUSDT 1h
  -> 后端发现已有 upstream stream
  -> 不再开交易所连接
  -> 只注册 consumer B

frontend A 取消 full
  -> 移除 consumer A
  -> 如果 B 或主图还在用，upstream stream 继续运行

最后一个 consumer 取消
  -> 才停止 upstream stream
```

这要求 DataManager 有 stream ownership/refcount，而不是简单地 `ensure_stream()` / `stop_stream()` 只看 symbol+interval。

## 执行步骤

### Phase 1：后端订阅模型保存 intervals

修改 `backend/app/data_engine/data_manager/subscriptions.py`。

1. 为 `SymbolSubscription` 增加 `intervals: list[str]` 字段。
2. `to_dict()` 返回 `intervals`。
3. SQLite 表新增 `intervals_json TEXT NOT NULL DEFAULT '[]'`。
4. `_init_db()` 创建表后检查 `PRAGMA table_info(subscriptions)`，缺列时 `ALTER TABLE`。
5. `_load_from_db()` 读取并校验 JSON。非法、空值、非数组时回退到 `[]`。
6. `_save_to_db()` 写入 normalized intervals JSON。

建议新增纯函数：

```python
def normalize_subscription_intervals(intervals: Any) -> list[str]:
    ...
```

最低要求：

- 去重。
- 去空。
- 保持排序稳定。
- 拒绝明显非法值。
- 不在这里做 custom interval 分解。

旧数据兼容：

- 旧库没有 `intervals_json`。
- 旧 full 记录读出来如果 intervals 为空，可以临时使用 `LEGACY_FULL_INTERVALS = ["1m"]` 维持旧行为。
- 但新写入的 full 记录必须保存完整 intervals。

### Phase 2：扩展订阅 API

修改 `backend/app/api/v1/subscriptions.py`。

`SetTierRequest` 增加：

```python
intervals: list[str] | None = None
consumer_id: str | None = None
```

`PUT /subscriptions/{symbol}` 调用：

```python
await mgr.set_tier(
    symbol,
    tier,
    intervals=body.intervals,
    consumer_id=body.consumer_id,
)
```

`POST /subscriptions/sync` 继续只负责 watchlist membership：

- 新增 symbol 自动注册为 `price`，不误开 K 线。
- 移除出所有自选的 symbol 可以降为 `none`，但要小心不要移除其他 consumer 的 full 订阅。
- tier detail、interval detail 继续走 `PUT /subscriptions/{symbol}`。

如果后面需要批量 full 更新，新增 endpoint，例如：

```text
PUT /subscriptions/bulk
```

不要把 membership sync 和 full intervals 更新混在一个 endpoint 里。

### Phase 3：DataManager 增加 stream consumer/refcount

这是完整实现的关键，不建议跳过。

当前风险是 `stop_stream(symbol, interval)` 可能误停主图、指标或另一个前端仍在使用的同一条后端流。

建议新增或改造 DataManager 内部 stream registry：

```python
StreamConsumerKey = tuple[str, str]  # e.g. (consumer_type, consumer_id)

StreamLease:
    key: SeriesKey
    consumers: set[StreamConsumerKey]
    focus_scopes: set[str]
    subscription_tiers: set[str]
```

公开语义：

```python
await dm.ensure_stream(
    symbol,
    interval,
    exchange=exchange,
    market_type=market_type,
    focus_scope="subscription",
    subscription_tier="full",
    consumer_id="watchlist:client-id:symbol",
)

await dm.release_stream(
    symbol,
    interval,
    exchange=exchange,
    market_type=market_type,
    consumer_id="watchlist:client-id:symbol",
)
```

要求：

- 相同 `SeriesKey` 第一次 ensure 才启动上游 ingestion。
- 后续 ensure 只增加 consumer。
- release 只移除对应 consumer。
- consumer 清空后才停止上游 stream。
- prerequisite/base streams 也需要被 lease 管理，不能因为释放 custom target 就误停其他 target 依赖的 base stream。

第一版如果暂时不新增 public `release_stream()`，至少也要在 subscription 停止时避免全量扫描停 foreground stream。但完整目标建议直接做 lease/refcount。

### Phase 4：SubscriptionService 用 intervals 激活 full

修改 `SubscriptionService.set_tier()`、`_activate_full()`、`_deactivate_full()`。

目标行为：

```text
set_tier(symbol, price):
  如果旧 tier 是 full，release 旧 intervals 的 subscription leases
  activate price
  保存 tier=price, intervals=[]

set_tier(symbol, full, intervals=[...]):
  activate price
  diff old_intervals vs new_intervals
  release removed intervals
  ensure added intervals
  保存 tier=full, intervals=[...]

set_tier(symbol, none):
  release full intervals
  stop/release price stream
  保存 tier=none, intervals=[]
```

`_activate_full(key, intervals, consumer_id)` 不再硬编码 `"1m"`。

consumer id 建议：

```text
watchlist:{client_instance_id}:{subscription_key}
```

如果后端暂时没有 per-client identity，可以使用：

```text
watchlist:global:{subscription_key}
```

但文档和测试要说明这是单用户/本地应用兼容策略，不是多客户端最终形态。

### Phase 5：前端计算 full intervals

修改前端 watchlist runtime 调用链。

新增 helper：

```js
function getFullSubscriptionIntervals({
  nativeIntervals,
  customIntervalRecords,
}) {
  return stableUnique([
    ...nativeIntervals.map((item) => item.value),
    ...customIntervalRecords.map((item) => item.value),
  ]);
}
```

输入来源：

- `useChartSession()` 已经持有 `nativeIntervals`、`customIntervalRecords`、`exchange`、`marketType`。
- 这些值通过 app composition root 传给 `useWatchlistRuntime()` 或 `useWatchlistSubscriptionRuntime()`。

修改 `updateSubscriptionTier`：

```js
export async function updateSubscriptionTier(symbol, tier, options = {}) {
  return request(url, {
    method: "PUT",
    body: {
      tier,
      intervals: options.intervals,
      consumer_id: options.consumerId,
    },
  });
}
```

`handleTierChange(symbol, "full")`：

```js
const intervals = getFullSubscriptionIntervals({
  nativeIntervals,
  customIntervalRecords,
});
updateSubscriptionTier(symbol, "full", { intervals, consumerId });
```

`price` 和 `none` 不传 K 线 intervals，或显式传 `[]`。

### Phase 6：前端后台 K 线缓存 runtime

不要让 `WatchlistSidebar.jsx` 自己维护 K 线数组。建议新增独立 runtime：

```text
frontend/src/features/watchlist-full-cache/
  useWatchlistFullCacheRuntime.js
  watchlistFullCacheStore.js
  watchlistFullCachePolicy.js
```

职责：

- 监听 full subscriptions。
- 为每个 full symbol + interval 维护状态：

```js
{
  key: "spot:BTCUSDT",
  interval: "1h",
  rows: [],
  status: "idle" | "loading" | "live" | "stale" | "error",
  source: "snapshot" | "ws" | "history" | "cache",
  lastUpdatedMs,
  lastError,
}
```

- 初次 full 时按优先级加载：
  1. 当前主图周期。
  2. 常用短周期和中周期。
  3. 其它 native intervals。
  4. custom intervals。
- 不要一次性对所有 full symbols 的所有 intervals 发满 HTTP 请求。WebSocket 可以订阅所有 declared intervals，但历史数组预热要限速。
- 接收 DataManager K 线事件后 patch 对应数组。
- 主图切换时提供：

```js
getWarmRows(symbolKey, interval)
```

命中时立即渲染；随后仍可走现有 `useMarketDataRuntime` 的 gap recovery / latest reconcile。

### Phase 7：主图切换优先使用后台缓存

修改 `features/market-data` 或 app composition root。

目标：

```text
用户切到 full symbol 的某 interval
  -> 先查 watchlist full cache 里正在 live 维护的 array
  -> 没有 live array，再查 watchlist/full-cache 或 market-data memory cache 里的 cached array
  -> 如果 cached array 有数据但 stale 或覆盖不完整，先 commit 可用 rows，再后台补缺口
  -> 如果本地完全没有可用 rows，再走后端 initial load
  -> 后端返回后写回前端缓存，并继续由实时流 patch
```

不要删除现有 `useMarketDataRuntime` 的初始加载、gap recovery、backfill completion 逻辑。后台缓存只是更快的 warm source，不是唯一真相。

建议把读取优先级实现成显式策略，而不是散落在组件里：

```text
WarmLive
  > WarmCached
  > MarketDataMemoryCache
  > PartialCached + Repair
  > BackendInitialLoad
```

各层含义：

- `WarmLive`：full 订阅后台 runtime 正在维护的 `symbolKey + interval` K 线数组，状态为 `live`，实时 K 线事件会持续 patch 它。命中时直接 commit，并异步做 latest/range reconcile。
- `WarmCached`：watchlist full cache 中仍保留 rows，但当前不一定 live，例如刚从 full 降级或流暂时断开。可以先显示，但 chart meta/source 必须标记为 warm-cache/stale，并触发校准。
- `MarketDataMemoryCache`：现有 `useChartDataRuntime` 的 `chartDataCacheRef`。它是当前 market-data runtime 内部 cache，不应被 symbol-change 无条件清掉后仍假装可用；如果保留使用，需要明确 cache key 包含 exchange、marketType、symbol、interval。
- `PartialCached + Repair`：本地有部分 rows，先显示已有区间，然后用现有 `fetchKlinesRange`、`fetchKlinesBefore`、gap recovery 或 latest/history 请求补齐可见范围和尾部。
- `BackendInitialLoad`：本地没有可用 rows，回到现有 `fetchLatestKlines + fetchKlinesHistory` 初始加载链路。

当前代码不是完整的上述策略：

- `useChartInitialLoad()` 已经会先读 `getFromCache(sym, intv)`，命中后立即 `replaceChartData(..., source: "memory-cache-hit")`，然后仍并发请求 latest/history。
- `useChartBackgroundPrefetch()` 会为当前 symbol 的 tracked intervals 后台拉 `fetchLatestKlines(..., 500)` 并写入 market-data memory cache。
- `useSessionTransitionReset()` 在 `symbol-change` 时会调用 `clearCache()`，所以当前 cache 不是跨商品的 watchlist full warm cache。
- 当前没有独立的 watchlist full cache runtime，也没有 `live`、`stale`、`partial` 状态分层。

因此实现时要新增一个 resolver，例如：

```js
resolveWarmRows({ symbolKey, exchange, marketType, interval, visibleRange }) {
  // returns:
  // { rows, source: "warm-live" | "warm-cache" | "memory-cache" | "partial-cache" | null,
  //   status: "live" | "stale" | "partial" | "miss",
  //   needsRepair: boolean,
  //   repairRange?: { start, end } }
}
```

`useChartInitialLoad()` 或其上层 runtime 应先调用这个 resolver。只要 resolver 返回 rows，就先 commit；`needsRepair` 为 true 时再并行触发现有后端请求。resolver 返回 miss 时，才清空图表并进入 backend initial load。

### Phase 8：UI 与状态显示

右键菜单三档：

```text
不订阅
仅价格
完全订阅
```

文案语义：

- `不订阅`：不消耗后端行情资源。
- `仅价格`：保活价格列。
- `完全订阅`：保活价格和可切换周期 K 线，用于快速切换。

可以增加 tooltip：

```text
完全订阅：ticker + 16 native + 3 custom
```

如果 full intervals 很多，显示数量，不在菜单里塞长列表。

## 验证计划

### 后端测试

重点覆盖：

1. `price` tier 只调用 `ensure_price_stream()`，不调用 `ensure_stream()`。
2. `full` tier with native+custom intervals 会逐个调用 `ensure_stream()`，不硬编码 `1m`。
3. `full -> full` intervals diff 正确：新增 ensure，移除 release。
4. `full -> price` release K 线 leases，但保留 price stream。
5. `full -> none` release K 线 leases，并停止/release price stream。
6. 相同 symbol+interval 多个 consumer ensure，只启动一次 upstream。
7. 一个 consumer release 后，只要其他 consumer 还在，upstream 不停止。
8. 最后一个 consumer release 后，upstream 停止。
9. custom interval 的 prerequisite/base stream lease 不被提前释放。
10. 旧 DB 无 `intervals_json` 能迁移。
11. 旧 full intervals 为空时按 `LEGACY_FULL_INTERVALS` 恢复，且测试名明确这是 legacy。

### 前端测试

重点覆盖：

1. `getFullSubscriptionIntervals()` 合并 native + custom，去重且顺序稳定。
2. `updateSubscriptionTier(symbol, "full", { intervals })` body 包含 intervals。
3. `price` / `none` 不携带 full intervals。
4. full cache store 能按 `symbolKey + interval` 写入、patch、读取。
5. 主图切换时 warm cache 命中会先 commit rows。
6. cache miss/stale 时仍回退现有 initial load。

### 集成冒烟

手工或 Playwright：

1. 打开 Binance spot `BTCUSDT`。
2. 保存一个 custom interval，例如 `45m`。
3. 右键自选 symbol，设为 `完全订阅`。
4. `/subscriptions/` 返回该 symbol `tier=full`，intervals 包含 native intervals 和 `45m`。
5. DataManager debug snapshot 中相同 symbol+interval 只存在一个 upstream stream。
6. 打开另一个消费者或主图订阅同一 interval，不新增重复 upstream。
7. 切换到该 symbol 的另一个 interval，图表先从后台缓存显示，再完成 reconcile。
8. 把 full 改为 price，K 线后台缓存停止继续 live 更新，但价格列继续更新。
9. 把 price 改为 none，价格列停止显示 live tick，后端 price stream 被 release。

## 风险与控制

- **网络和内存放大**：full 订阅所有可切换周期会显著增加资源占用。必须设置 full symbol 数量软上限、历史预热并发上限、每 interval rows 上限。
- **custom interval 爆炸**：只订阅用户保存的 custom records，不订阅所有可能 custom 表达式。
- **误停主图 stream**：必须实现或至少模拟 consumer/refcount 语义，否则停止 full 会误伤 foreground stream。
- **后台缓存不是唯一真相**：主图仍要保留 latest/range reconcile、gap recovery、backfill completion。
- **旧数据兼容**：旧 full 记录可以 legacy 恢复 1m，但新语义必须写 intervals。
- **多客户端 identity**：本地单用户可以先用 global consumer，但最终多窗口/多客户端需要真实 client id。

## 不做事项

- 不让前端直接启动 DataEngine 或交易所连接。
- 不在 `SubscriptionService` 中实现 custom interval 分解。
- 不把 price snapshot 合并进 K 线 `BarAggregator`。
- 不一次性订阅无限 custom intervals。
- 不把后台缓存当成数据库持久层。
- 不删除现有主图加载和 gap recovery 逻辑。

## 推荐提交顺序

1. 后端 subscription model/API/schema 支持 intervals，保留旧行为兼容。
2. DataManager stream lease/refcount/fanout 语义落地。
3. `SubscriptionService._activate_full()` 改为 intervals 驱动，去掉长期硬编码 `1m`。
4. 前端计算 native + custom full intervals，并通过 API 提交。
5. 前端新增 watchlist full cache runtime，只做缓存写入和读取，不先改主图切换。
6. 主图切换接入 warm cache，然后保留现有 reconcile。
7. UI 文案、tooltip、资源上限提示。
8. 更新 API/README，并做浏览器冒烟。

## 成功标准

- `none` 不保活 ticker/K 线。
- `price` 只保活 ticker，不创建 K 线流。
- `full` 保活 ticker，并订阅所有前端可切换周期。
- `full` 不再以硬编码 `"1m"` 作为长期语义。
- 重复订阅相同 symbol+interval 不重复打开交易所 upstream。
- 取消一个 consumer 不会误停其他 consumer 仍在使用的 stream。
- 前端能为 full symbol 后台维护多周期 K 线数组。
- 主图切换到已缓存 symbol+interval 时能先快速显示缓存，再异步校准。

## 进一步优化：前端数组维护

这部分不是主线第一阶段的阻塞项。主线仍是修正 ticker/full 订阅语义、后端流去重和前端 warm cache 接入。下面的内容用于后续把前端后台数组维护做得更稳、更省资源。

### 推荐结构

不要让 `WatchlistSidebar.jsx`、主图组件或多个 hook 各自维护 K 线数组。建议拆成一个全局 warm cache store、一个调度器和一个读取 resolver：

```text
watchlistFullCacheStore
  owns: symbolKey + interval -> cache entry

watchlistFullCacheScheduler
  owns: preload queue / concurrency / priority / eviction

watchlistFullCacheRuntime
  owns: full subscriptions, live patches, scheduler wiring

marketDataRuntime
  consumes: resolveWarmRows()
```

### Cache Entry 形状

每个 `symbolKey + interval` 不只保存 rows，还要保存状态、覆盖范围和修复信息：

```js
{
  key: "binance:spot:BTCUSDT:1h",
  rows,
  status: "live" | "warm" | "stale" | "partial" | "loading" | "error",
  coverage: { firstTime, lastTime, bars },
  lastUpdatedMs,
  lastRealtimeMs,
  source: "ws" | "history" | "latest" | "prefetch",
  dirtyRanges: [],
  inflight: { latest: false, history: false, ranges: new Set() },
  subscribers: 0,
}
```

### 更新策略

- 实时 tick 优先走尾部更新：用 `upsertRealtimeKline` 追加或替换最后一根，避免每次全量 merge。
- 历史补齐、gap fill、range repair 才走 `mergeByTime`。
- merge 后如果 `klineRowsEqual(oldRows, nextRows)`，复用旧数组引用，避免不必要的 React/chart 重绘。
- 非当前主图 entry 只更新 store，不主动 commit 到 chart。
- 当前主图 entry 可以用 `requestAnimationFrame` 或短 batch 合并多次 patch。

### 预热优先级

full 不应该一次性把所有 symbol 的所有 intervals 都发满请求。建议分级调度：

```text
P0 当前主图 symbol + interval
P1 当前主图 symbol 的其它高频周期
P2 full symbol 的常用周期：1m/5m/15m/1h/4h/1d
P3 其它 exchange native intervals
P4 用户 custom intervals
```

调度器限制：

- HTTP 历史预热并发建议从 1-2 开始。
- 每个 interval 请求之间保留 100-300ms 间隔。
- WebSocket 可以声明所有 full intervals，但历史数组预热必须限速。
- custom intervals 放低优先级，避免用户添加大量 custom 后拖慢主图。

### 容量与淘汰

缓存必须有上限。建议配置：

```text
maxFullSymbols = 10
maxRowsPerEntry = by interval tier
maxTotalRows = 200_000
maxWarmEntries = by memory budget
```

淘汰顺序：

```text
non-live stale
  -> non-live warm but old lastAccessedMs
  -> low-priority custom intervals
  -> rarely accessed native intervals
```

不要淘汰当前主图 entry。对 full symbol，优先保留常用周期和最近访问过的周期。

### 不同周期保存不同长度

不要所有周期都存一样多 rows。可以复用 `getIntervalDays()` 和现有 cache limit 思路：

```text
1s / 1m:
  较短窗口，防止高频 rows 爆炸

5m / 15m / 30m:
  中等窗口，覆盖常用切换

1h / 4h:
  更长窗口，适合分析回看

1d / 1w / 1M:
  可以保存更长历史，但更新频率低
```

### Live 与 Cached 状态

`full` 降级为 `price` 时，不必立刻删除 K 线数组。建议：

```text
live -> warm/stale
```

这样用户短时间切回来还能快速显示，但该 entry 不再消耗 K 线 live stream。超过 TTL 或容量上限后再淘汰。

### Resolver 契约

主图只通过 resolver 读取，不直接关心 full cache 内部结构：

```js
resolveWarmRows({ symbolKey, exchange, marketType, interval, visibleRange })
```

返回：

```js
{
  rows,
  source: "warm-live" | "warm-cache" | "memory-cache" | "partial-cache" | null,
  status: "live" | "stale" | "partial" | "miss",
  needsRepair: boolean,
  repairRange,
}
```

读取优先级保持：

```text
WarmLive
  > WarmCached
  > MarketDataMemoryCache
  > PartialCached + Repair
  > BackendInitialLoad
```

后台数组只是前端加速层，不是数据库或最终真相。任何 stale、partial、tail gap 都必须继续通过后端 latest/history/range 或 gap recovery 校准。
