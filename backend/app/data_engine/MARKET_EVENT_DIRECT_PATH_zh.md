# MarketEvent 直通 BarAggregator 设计与实施说明

> 目标版本：最终删干净版本。本文不是最小兼容改动方案，而是把实时 K 线主链路收敛为 `ingestion.MarketEvent -> BarAggregator.EventRouter -> BarInput` 的长期结构。

## 当前状态

实时 K 线主链路已按本文目标实现：`ExchangeIngestionFactory` 将 L6 `MarketEvent` 直接注册给 `StreamCoordinator` 的 `on_market_event` 回调，`StreamCoordinator` 再把同一个事件对象转发给 `BarAggregator.on_market_event()`。旧的 `MarketEvent -> bar_dict -> _BarDictMarketEvent` 桥接已经从生产 kline path 删除。

## 背景

当前 Data Engine 的文档边界已经把实时链路描述为：

```text
ingestion
  -> MarketEvent / GapMarker
  -> bar_aggregator
  -> BarEvent
  -> data_manager
```

但现有实现里，kline 主路径仍然经过一段历史兼容桥：

```text
L6 Delivery MarketEvent
  -> ExchangeIngestionFactory._bridge()
  -> bar_dict
  -> StreamCoordinator.on_raw_bar()
  -> _BarDictMarketEvent
  -> BarAggregator.on_market_event()
  -> EventRouter
  -> BarInput
```

这段桥接的直接原因是 `StreamCoordinator.IngestionFactory` 仍然定义为 `on_bar: Callable[[dict], Awaitable[None]]`。也就是说，真实 L6 输出已经是 `MarketEvent`，`BarAggregator.EventRouter` 也已经能把 `MarketEvent` 转成 `BarInput`，但中间契约还停留在旧的 dict bar 回调。

## 设计目标

最终状态只保留一个实时 K 线入口：

```text
Exchange WS / REST
  -> ingestion L1-L6
  -> DeliveryLayer.on_market_event(market_event)
  -> StreamCoordinator.on_market_event(market_event)
  -> BarAggregator.on_market_event(market_event)
  -> EventRouter converts MarketEvent to BarInput
  -> TimeBucketEngine
  -> BarStateEngine
  -> Finalizer
  -> BarAggregatorPublisher
  -> AggregatorBridge
  -> Cache / Storage / EventBus
```

核心原则：

- `ingestion` owns exchange I/O, normalization, deduplication, gap detection, and `MarketEvent` / `GapMarker` delivery.
- `bar_aggregator` owns realtime market event normalization into `BarInput`, bucket routing, merge mode, finalization, and `BarEvent` publication.
- `data_manager.StreamCoordinator` owns lifecycle only: start streams, stop streams, register targets, wire callbacks, route gap markers to backfill trigger.
- `ExchangeIngestionFactory` owns creation of L1-L6 pipelines, but does not down-convert kline `MarketEvent` into bar dicts.
- No layer between L6 Delivery and `BarAggregator.EventRouter` should reinterpret OHLCV fields.

## 要删除的旧结构

最终清理完成后，实时 kline path 中不再存在这些结构：

| 对象 | 当前作用 | 最终处理 |
|---|---|---|
| `ExchangeIngestionFactory._register_callback()` 里的 kline `MarketEvent -> bar_dict` bridge | 为旧 `on_bar` 回调把 L6 event 转成 dict | 删除 |
| `StreamCoordinator.on_raw_bar(bar_dict)` | 接收 ingestion factory 传来的 dict bar | 替换为 `on_market_event(market_event)` |
| `_BarDictMarketEvent` | 把 dict bar 再包成 MarketEvent-like 对象 | 删除 |
| `_EnumLike` | 只服务于 `_BarDictMarketEvent`，伪造 enum `.value` | 删除 |
| kline path 的 `IngestionFactory.start(..., on_bar: Callable[[dict], ...])` | 旧 kline 回调契约 | 替换为 market-event 契约 |
| 没有 `BarAggregator` 时 live kline dict 直写 cache 的 fallback | 历史 passive path | 从生产 kline path 删除；`DataManager` 构造时已经拥有 `BarAggregator` |

价格流是独立链路。`start_price()` 可以继续把 ticker `MarketEvent` 转成 `PriceSnapshot` 风格的 dict，因为它不进入 `bar_aggregator`，消费者契约也不同。

## 最终接口契约

### IngestionFactory

Replace the kline start contract with a market-event callback:

```python
MarketEventHandler = Callable[[MarketEvent], Awaitable[None]]
GapHandler = Callable[[GapMarker], Awaitable[None]]

class IngestionFactory(Protocol):
    async def start(
        self,
        symbol: str,
        interval: str,
        on_market_event: MarketEventHandler,
        exchange: str = "binance",
        market_type: str = "spot",
        on_gap: GapHandler | None = None,
    ) -> Any:
        ...
```

The callback name should be explicit. Avoid a generic `on_event` name here because `DeliveryLayer` can also emit gap and status envelopes; the coordinator needs only market events on the bar aggregation path.

### ExchangeIngestionFactory

`ExchangeIngestionFactory.start()` should:

1. Build the `StreamDescriptor` for `StreamType.KLINE`.
2. Create or reuse the `MarketDataIngress` pipeline.
3. Register `on_market_event` directly with `pipeline.delivery.on_market_event()`.
4. Register `on_gap` directly with `pipeline.delivery.on_gap()` when provided.
5. Return the existing `_IngestionHandle`.

It should not inspect `market_event.data` for OHLCV fields in the kline path.

### StreamCoordinator

`StreamCoordinator._start_stream()` should construct:

```python
async def on_market_event(market_event: MarketEvent) -> None:
    await self._bar_aggregator.on_market_event(market_event)
```

The coordinator should not know the kline data schema. It may still validate lifecycle prerequisites:

- `_bar_aggregator` must be set before realtime kline streams can be started.
- `on_gap` remains keyed by the `SeriesKey` whose stream was started.
- stream status and handle tracking remain unchanged.

If a future test or custom runtime wants passive/manual bar injection, it should use a separate explicit method such as `DataManager.on_bar_event()` or `BarAggregator.ingest_bar_input()`. It should not reuse the ingestion factory kline contract.

### BarAggregator

No major API change is required. The intended public boundary already exists:

```python
await bar_aggregator.on_market_event(market_event)
```

The router remains the only place that converts realtime `MarketEvent` into `BarInput`:

- filter accepted stream types;
- extract `symbol`, `exchange`, `market_type`;
- match registered targets;
- convert kline/trade event data into `BarInput`;
- choose routing and merge mode for exact interval, custom interval, tick input, and exchange-specific fan-out.

## 职责边界

### Field interpretation

Only these layers should understand kline payload fields:

- `ingestion.normalizers`: exchange-specific raw payload to standardized `MarketEvent.data`;
- `bar_aggregator.EventRouter`: standardized `MarketEvent.data` to `BarInput`.

`ExchangeIngestionFactory` and `StreamCoordinator` should not copy `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `trades`, or `is_closed`.

### Identity

`MarketEvent` remains the authoritative carrier of:

- `symbol`;
- `exchange`;
- `stream_key`;
- `event_type`;
- `source`;
- `event_time_ms`;
- `received_at_ms`;
- stream-specific `data`.

`market_type` should be preserved from `StreamDescriptor` / pipeline context. If current `MarketEvent` does not expose `market_type` directly, the final implementation should make that identity available through the event or a typed pipeline callback context before deleting the wrapper path. Do not reconstruct it from string prefixes in coordinator code.

### Backfill

Backfill paths are not the target of this deletion. They already have explicit entry points:

- `BarAggregator.on_backfill_bars()`;
- `BarAggregator.aggregate_batch()`;
- `BackfillReconciler.set_bar_aggregator()`;
- `DataManager.on_bars_backfilled()`.

Do not route historical repair through the realtime `IngestionFactory.start()` callback.

## 实施计划

### Phase 1: strengthen canonical event identity

1. Verify `MarketEvent` can carry all identity needed by `EventRouter`: `symbol`, `exchange`, `market_type`, `stream_key`, `source`, `event_type`, and data schema.
2. If `market_type` is absent from `MarketEvent`, add it to the dataclass and `to_dict()`.
3. Update normalizers / pipeline construction so `market_type` is populated from `StreamDescriptor`.
4. Add router tests using real `MarketEvent` objects for Binance and OKX spot/swap cases.

退出条件：`EventRouter` 可以在没有任何 wrapper 的情况下路由真实 L6 event。

### Phase 2: change the kline factory contract

1. Change `IngestionFactory.start()` from `on_bar` to `on_market_event`.
2. Update `ExchangeIngestionFactory.start()` and its docstring to register the callback directly on L6 Delivery.
3. Keep `start_price()` unchanged unless a separate price-contract cleanup is planned.
4. Update tests that define fake ingestion factories to accept `on_market_event`.

退出条件：生产 kline path 不再需要 `Callable[[dict], Awaitable[None]]`。

### Phase 3: simplify StreamCoordinator

1. Replace `on_raw_bar(bar_dict)` with `on_market_event(market_event)`.
2. Require `_bar_aggregator` for realtime kline stream startup.
3. Route gaps through the existing `on_gap(key, gap)` path.
4. Remove the dict-to-cache fallback from `_start_stream()`.

退出条件：`StreamCoordinator` 不再构造 fake market event，也不再解析 OHLCV dict。

### Phase 4: delete legacy adapters

Delete:

- `_BarDictMarketEvent`;
- `_EnumLike`;
- kline `_register_callback()` bridge code that builds `bar_dict`;
- docstrings that mention `on_bar(bar_dict)` in the kline ingestion path;
- tests whose only purpose is to preserve the dict bridge.

Search targets before declaring the cleanup complete:

```text
_BarDictMarketEvent
_EnumLike
on_raw_bar
on_bar: Callable[[dict]
MarketEvent -> bar_dict
bar_dict -> MarketEvent
```

### Phase 5: update docs and boundary tests

Update:

- `backend/app/data_engine/README.md`;
- `backend/app/data_engine/README_zh.md`;
- `backend/app/data_engine/ingestion/README.md`;
- `backend/app/data_engine/ingestion/README_zh.md`;
- `backend/app/data_engine/bar_aggregator/README.md`;
- `backend/app/data_engine/bar_aggregator/README_zh.md`;
- `backend/app/data_engine/data_manager/README.md`;
- `backend/app/data_engine/data_manager/README_zh.md`;
- module docstrings in `ingestion/factory.py` and `data_manager/coordinator.py`.

Add or adjust tests so the boundary is enforced:

- kline `IngestionFactory.start()` accepts `on_market_event`, not `on_bar`;
- `ExchangeIngestionFactory` registers L6 `MarketEvent` directly;
- `StreamCoordinator` forwards the same `MarketEvent` object to `BarAggregator.on_market_event()`;
- no DataManager / Coordinator code imports or constructs `_BarDictMarketEvent`;
- no kline path copies OHLCV fields outside normalizers and `EventRouter`;
- gap markers still trigger backfill with the correct `SeriesKey`;
- OKX realtime fan-out still produces `PRICE_ONLY` where expected;
- custom intervals still route from base interval components.

## 验证计划

Focused tests after the cleanup:

```bash
cd backend
python -m pytest -q \
  tests/test_ingestion_delivery.py \
  tests/test_ingestion_normalizers.py \
  tests/test_ingestion_session_types.py \
  tests/test_bar_aggregator_contracts.py \
  tests/test_data_engine_phase1_boundaries.py \
  tests/test_data_manager_warm_start_bridge.py \
  tests/test_price_subscription_services.py
```

Full backend smoke check:

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

Manual architecture check:

```text
DataManager.ensure_stream()
  -> StreamEnsurePlanner registers aggregator targets
  -> StreamCoordinator starts ExchangeIngestionFactory
  -> ExchangeIngestionFactory creates or reuses L1-L6 pipeline
  -> DeliveryLayer emits MarketEvent
  -> StreamCoordinator forwards MarketEvent
  -> BarAggregator.EventRouter converts MarketEvent to BarInput
  -> AggregatorBridge persists closed/amended bars and emits DataEvent
```

## 非目标

- Do not redesign price snapshots in the same change.
- Do not route backfill repair through realtime ingestion callbacks.
- Do not move exchange-specific parsing into DataManager.
- Do not remove `BarAggregator.ingest_bar_input()`; it remains useful for tests, manual injection, and future adapters that already produce normalized `BarInput`.
- Do not change frontend contracts; frontend still consumes `DataEvent`, `BarData`, and WebSocket messages from DataManager/API layers.

## 最终验收标准

The cleanup is complete only when all of the following are true:

- A real L6 `MarketEvent` reaches `BarAggregator.on_market_event()` without conversion to dict.
- `StreamCoordinator` has no OHLCV parsing or fake event wrapper.
- `ExchangeIngestionFactory` does not build kline `bar_dict` objects.
- `_BarDictMarketEvent` and `_EnumLike` are removed.
- The kline ingestion factory contract is named around `on_market_event`.
- `EventRouter` remains the single realtime conversion point from `MarketEvent` to `BarInput`.
- Gap markers still reach `BackfillCoordinator`.
- Price stream dict conversion remains isolated to the price path.
- README and module docstrings describe the direct path, not the deleted bridge.
