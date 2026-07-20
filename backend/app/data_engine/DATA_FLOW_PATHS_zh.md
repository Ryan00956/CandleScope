# 数据流路径地图

> Data Engine 当前运行路径的事实地图。本文件描述“现在怎么走”；架构打磨路线图描述后续如何简化和加固。

## 边界事件类型

| 类型 | 生产者 | 消费者 | 含义 |
|---|---|---|---|
| `RawMessage` | `TransportLayer` / `SessionLayer` / `SharedWsSessionAdapter` | `NormalizeLayer` | 原始交易所 payload，加上 source 和 endpoint 元数据。 |
| `MarketEvent` | `NormalizeLayer` + `ContinuityLayer` | `BarAggregator.on_market_event()` | 已经标准化、可以进入 K 线语义层的行情事件。 |
| `GapMarker` | `ContinuityLayer` | `StreamCoordinator` gap handler / backfill trigger | 实时 continuity 信号，说明某段历史可能需要修复。 |
| `BarEvent` | `BarAggregator` publisher | `AggregatorBridge.on_bar_event()` | 业务 K 线生命周期输出：created、updated、closed、amended 或 expired。 |
| `DataEvent` | `DataManager` / `AggregatorBridge` / `BackfillCoordinator` | API WS、indicator bridge、订阅者 | 后端公开 event bus 消息。 |
| `PriceSnapshot` | `DataManager.on_price_ticks()` | 价格 REST/WS 消费者 | watchlist 价格轻量状态，和 OHLCV K 线分离。 |

`DataEvent` 带 audience 分级。用于用户可见窗口的事件才进入 API WS
广播；内部修复、审计、后台维护事件默认留在服务端或定向消费者，避免前端因
无关 backfill/recompute 重新拉取几万根历史。

## 周期语义与能力路由

周期有两个彼此独立的维度，禁止再用“是否在全局标准列表”同时回答两者：

1. `interval_policy.IntervalSpec` 是时间语义的唯一权威：规范化 identity、
   fixed-epoch / Monday-week / calendar-month 对齐，以及 floor/next/previous。
   因而 `60m == 1h`，但 `7d != 1w`、`30d != 1M`；任意 `nM` 都以
   1970-01 为绝对月锚点，不按自然年重置。
2. `interval_resolution.IntervalResolver` 是交易所能力路由的唯一权威：按
   `(exchange, market_type, purpose=history|realtime)` 决定 target 是
   `NATIVE` 还是 `DERIVED`，并为 derived target 选择能精确铺满它的 native base。

例如 Binance `8h` 是 native，而 OKX `8h` 是从 `4h` 派生；两者的 `8h`
时间轴完全相同。Query、stream、backfill 和 API `/resolve` 必须消费同一 route。
BarAggregator 的合并与关闭由 `MergeMode`（`SNAPSHOT`、`COMPONENT`、
`PRICE_ONLY` 等）决定，不能再由 target 名字是否“自定义”决定。

## 实时 K 线路径

```text
WS /stream/klines 或 /stream/klines_multi
  -> dm.ensure_stream(symbol, interval, exchange, market_type)
  -> StreamEnsurePlanner
     -> 在 BarAggregator 注册 aggregation targets
     -> 按 exchange-aware route 为 derived target 选择 prerequisite base streams
  -> StreamCoordinator.ensure_stream()
  -> ExchangeIngestionFactory.start(on_market_event, on_gap)
  -> MarketDataIngress.add_stream()
  -> FeedControlLayer
     -> path_per_stream 交易所使用 SessionLayer
     -> shared_multiplex 交易所使用 SharedWsSessionAdapter
     -> WS 不健康或不可用时走 HTTP fallback
  -> NormalizeLayer
  -> ContinuityLayer
  -> DeliveryLayer
  -> on_market_event(MarketEvent)
  -> BarAggregator.on_market_event()
  -> BarEvent
  -> AggregatorBridge.on_bar_event()
  -> cache upsert/append，closed/amended bar 写 storage，EventBus emit
  -> WebSocket/API/indicator subscribers
```

规则：

- `MarketEvent` 不直接修改 DataManager cache。
- 实时 cache 修改发生在 `BarAggregator` 产出 `BarEvent` 后，由 `AggregatorBridge` 完成。
- derived target 在 `StreamEnsurePlanner` 要求时复用 resolver 选出的 base interval 输入。
- 非默认 `exchange` 和非 spot `market_type` 都属于 stream identity。
- API K-line WebSocket 按订阅 identity 和 event audience 过滤，只给当前
  用户可见序列发送需要前端处理的事件。

## 历史修复路径

```text
QueryEngine missing range / Settings repair / GapMarker
  -> BackfillCoordinator.trigger()
  -> demand-aware scheduler
  -> BackfillEngine.run()
     -> detect
     -> plan
     -> fetch via exchange REST transport
     -> reconcile
     -> publish RepairReport
  -> 根据 RepairReport.written_ranges 精确回读 storage
  -> DataManager.on_bars_backfilled()
  -> cache.bulk_load()
  -> EventBus BACKFILL_COMPLETED 或 BACKFILL_FAILED
  -> WebSocket/API consumers 刷新受影响区间
```

规则：

- Backfill 不走实时 `MarketEvent -> BarAggregator` 路径。
- `BackfillCoordinator` 负责 priority、去重、合并、retry、cancel 和 completion 语义。
- Cache 回灌必须使用实际 written ranges，不能假设原始请求范围已经完整修复。

## 价格快照路径

```text
SubscriptionService.set_tier() 或 sync_watchlist()
  -> dm.ensure_price_stream(symbol, exchange, market_type)
  -> PriceSnapshotCache.watch()
  -> IngestionPriceSource.ensure_symbol()
  -> ExchangeIngestionFactory.start_price()
  -> MarketDataIngress ticker 或 miniTicker stream
  -> DeliveryLayer MarketEvent
  -> ExchangeIngestionFactory price bridge
  -> DataManager.on_price_ticks()
  -> PriceSnapshotCache.upsert_many()
  -> EventBus PRICE_UPDATED
  -> /subscriptions/prices 或 /stream/prices
```

规则：

- 价格快照不进入 `BarAggregator`。
- `full` 订阅 tier 同时保持 K 线和价格路径。
- `price` tier 只保持轻量价格路径。

## 内置指标路径

```text
WS /stream/indicators subscribe builtin
  -> dm.ensure_stream(symbol, interval)
  -> dm.query_latest(...) 获取初始历史
  -> IndicatorEngine.subscribe(...)
  -> IndicatorEngine listener 推送 snapshot 到 indicator WS queue
  -> DataManager EventBus bar updates 驱动增量指标更新
  -> indicator WS 向客户端发送 patch/snapshot
```

规则：

- 指标订阅只能通过 `dm.ensure_stream()` 启动行情。
- 内置指标 runtime 消费 DataManager bars/events，不拥有交易所 session。
- range request 从 DataManager 查询 bars，再计算有界 patch。

## Pyne / Custom 指标路径

```text
WS /stream/indicators subscribe custom/Pyne
  -> 从 request 或 CustomIndicatorStore 解析 custom script
  -> dm.ensure_stream(symbol, interval)
  -> 从 DataManager 查询 bounded history
  -> Pyne executor 计算初始 snapshot
  -> DataManager subscription 监听 bar updates
  -> incremental session 或 bounded recompute 生成 patch
  -> indicator WS 向客户端发送 Pyne payload
```

规则：

- Pyne 执行在后端托管，并受配置的安全和运行时限制约束。
- Pyne 不接收直接交易所 payload。
- 已保存 custom indicator 是 metadata/script 定义；实时 bars 仍来自 DataManager。

## 交易所 WS Session Routing

```text
plugin.capabilities().ws_connection_model
  path_per_stream
    -> StreamDescriptor 映射到一条 stream URL/path
    -> SessionLayer 管理上游连接

  shared_multiplex
    -> SharedWsHubRegistry 按 (exchange, market_type, symbol) 创建/复用 hub
    -> SharedMultiplexHub 把多个 descriptor 合并到同一上游订阅
    -> SharedWsSessionAdapter 把匹配 payload 分发给各 pipeline

  polling_only
    -> FeedControlLayer 使用 HTTP polling，不创建直接 WS session
```

当前例子：

- Binance 建模为 `path_per_stream`；重复保护主要靠 pipeline/key 复用。
- OKX kline 建模为 `shared_multiplex`；多个 interval descriptor 可以共享一条上游连接。
- 未来如果要实现 Binance combined stream，应通过 exchange capabilities 和 protocol methods 引入，不应在 DataManager 里写特判。

## Ownership Checklist

- API route 负责校验请求和序列化响应。
- DataManager 是公开行情数据门面。
- StreamCoordinator 启停 ingestion stream，并把实时 `MarketEvent` 路由进 `BarAggregator`。
- BarAggregator 负责 K 线语义。
- AggregatorBridge 负责实时 `BarEvent -> DataEvent/cache/storage` 转换。
- BackfillCoordinator 负责历史修复调度语义。
- Exchange plugins 负责协议和 capability 差异。
- 前端选择语义意图；后端负责 priority、scheduling 和 execution。
