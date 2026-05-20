# Data Flow Paths

> Current source-of-truth map for Data Engine runtime paths. This file describes what happens today; the polish roadmap describes how to simplify and harden it over time.

## Boundary Event Types

| Type | Producer | Consumer | Meaning |
|---|---|---|---|
| `RawMessage` | `TransportLayer` / `SessionLayer` / `SharedWsSessionAdapter` | `NormalizeLayer` | Raw exchange payload plus source and endpoint metadata. |
| `MarketEvent` | `NormalizeLayer` + `ContinuityLayer` | `BarAggregator.on_market_event()` | Exchange-normalized market event ready for K-line semantics. |
| `GapMarker` | `ContinuityLayer` | `StreamCoordinator` gap handler / backfill trigger | Realtime continuity signal that a historical range may need repair. |
| `BarEvent` | `BarAggregator` publisher | `AggregatorBridge.on_bar_event()` | Business K-line lifecycle output: created, updated, closed, amended, or expired. |
| `DataEvent` | `DataManager` / `AggregatorBridge` / `BackfillCoordinator` | API WS streams, indicator bridge, subscribers | Public backend event bus message. |
| `PriceSnapshot` | `DataManager.on_price_ticks()` | price REST/WS consumers | Lightweight watched-symbol price state, separate from OHLCV bars. |

## Realtime K-line Path

```text
WS /stream/klines or /stream/klines_multi
  -> dm.ensure_stream(symbol, interval, exchange, market_type)
  -> StreamEnsurePlanner
     -> aggregation targets registered in BarAggregator
     -> prerequisite base streams selected for custom intervals
  -> StreamCoordinator.ensure_stream()
  -> ExchangeIngestionFactory.start(on_market_event, on_gap)
  -> MarketDataIngress.add_stream()
  -> FeedControlLayer
     -> SessionLayer for path_per_stream exchanges
     -> SharedWsSessionAdapter for shared_multiplex exchanges
     -> HTTP fallback when WS is unhealthy or unavailable
  -> NormalizeLayer
  -> ContinuityLayer
  -> DeliveryLayer
  -> on_market_event(MarketEvent)
  -> BarAggregator.on_market_event()
  -> BarEvent
  -> AggregatorBridge.on_bar_event()
  -> cache upsert/append, storage upsert for closed/amended bars, EventBus emit
  -> WebSocket/API/indicator subscribers
```

Rules:

- `MarketEvent` does not mutate DataManager cache directly.
- Realtime cache mutation happens through `AggregatorBridge` after `BarAggregator` emits a `BarEvent`.
- Custom intervals reuse base interval input when `StreamEnsurePlanner` requires it.
- Non-default `exchange` and non-spot `market_type` are part of stream identity.

## Historical Repair Path

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
  -> precise storage readback from RepairReport.written_ranges
  -> DataManager.on_bars_backfilled()
  -> cache.bulk_load()
  -> EventBus BACKFILL_COMPLETED or BACKFILL_FAILED
  -> WebSocket/API consumers refresh the affected range
```

Rules:

- Backfill does not use the realtime `MarketEvent -> BarAggregator` path.
- `BackfillCoordinator` owns priority, deduplication, merge, retry, cancel, and completion semantics.
- Cache readback must use written ranges, not blindly assume the requested range was fully repaired.

## Price Snapshot Path

```text
SubscriptionService.set_tier() or sync_watchlist()
  -> dm.ensure_price_stream(symbol, exchange, market_type)
  -> PriceSnapshotCache.watch()
  -> IngestionPriceSource.ensure_symbol()
  -> ExchangeIngestionFactory.start_price()
  -> MarketDataIngress ticker or miniTicker stream
  -> DeliveryLayer MarketEvent
  -> ExchangeIngestionFactory price bridge
  -> DataManager.on_price_ticks()
  -> PriceSnapshotCache.upsert_many()
  -> EventBus PRICE_UPDATED
  -> /subscriptions/prices or /stream/prices
```

Rules:

- Price snapshots do not enter `BarAggregator`.
- `full` subscription tier keeps both K-line and price paths active.
- `price` tier keeps only the lightweight price path active.

## Builtin Indicator Path

```text
WS /stream/indicators subscribe builtin
  -> dm.ensure_stream(symbol, interval)
  -> dm.query_latest(...) for initial history
  -> IndicatorEngine.subscribe(...)
  -> IndicatorEngine listener pushes snapshot to the indicator WS queue
  -> DataManager EventBus bar updates drive incremental indicator updates
  -> indicator WS sends patches/snapshots to the client
```

Rules:

- Indicator subscriptions start market data only through `dm.ensure_stream()`.
- Builtin indicator runtime consumes DataManager bars/events; it does not own exchange sessions.
- Range requests query DataManager for bars and compute bounded patches.

## Pyne / Custom Indicator Path

```text
WS /stream/indicators subscribe custom/Pyne
  -> custom script resolved from request or CustomIndicatorStore
  -> dm.ensure_stream(symbol, interval)
  -> bounded history queried from DataManager
  -> Pyne executor computes initial snapshot
  -> DataManager subscription listens for bar updates
  -> incremental session or bounded recompute creates patch
  -> indicator WS sends Pyne payload to the client
```

Rules:

- Pyne execution is backend-hosted and bounded by configured security/runtime limits.
- Pyne does not receive direct exchange payloads.
- Stored custom indicators are metadata/script definitions; live bars still come through DataManager.

## Exchange WS Session Routing

```text
plugin.capabilities().ws_connection_model
  path_per_stream
    -> StreamDescriptor maps to one stream URL/path
    -> SessionLayer manages the upstream connection

  shared_multiplex
    -> SharedWsHubRegistry creates/reuses a hub per (exchange, market_type, symbol)
    -> SharedMultiplexHub combines descriptors into one upstream subscription
    -> SharedWsSessionAdapter dispatches matching payloads to each pipeline

  polling_only
    -> FeedControlLayer uses HTTP polling and skips direct WS session creation
```

Current examples:

- Binance is modeled as `path_per_stream`; duplicate protection is pipeline/key reuse.
- OKX kline is modeled as `shared_multiplex`; multiple interval descriptors can share one upstream connection.
- A future Binance combined-stream implementation should be introduced through exchange capabilities and protocol methods, not through DataManager special cases.

## Ownership Checklist

- API routes validate requests and serialize responses.
- DataManager is the public market-data facade.
- StreamCoordinator starts/stops ingestion streams and routes realtime `MarketEvent` to `BarAggregator`.
- BarAggregator owns K-line semantics.
- AggregatorBridge owns realtime `BarEvent -> DataEvent/cache/storage` conversion.
- BackfillCoordinator owns historical repair scheduling semantics.
- Exchange plugins own protocol/capability differences.
- Frontend chooses semantic intent; backend owns priority, scheduling, and execution.
