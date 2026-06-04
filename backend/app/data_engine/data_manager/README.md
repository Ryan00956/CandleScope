# Data Manager

[中文](README_zh.md)

> Public business facade for CandleScope market data. `DataManager` is the module API/WS/Indicator code should use for K-line queries, cache access, event subscriptions, stream lifecycle, backfill coordination, price snapshots, and maintenance tasks.

## Position In Data Engine

```text
ingestion -> bar_aggregator -> DataManager -> API / WS / Indicator
                         ▲
                         └── backfill -> storage readback
```

`data_manager` is the boundary between low-level data plumbing and application features. External modules should use the package root exports from [__init__.py](__init__.py), not internal services such as `QueryEngine`, `StreamCoordinator`, or `AggregatorBridge`.

## Responsibilities

| Area | Component | Responsibility |
|---|---|---|
| Facade | `DataManager` | Public methods for query, stream, subscription, maintenance, and diagnostics |
| Cache | `KlineCache` | In-memory series cache with size/TTL limits |
| Query | `QueryEngine` | Resolve Cache -> Storage -> Backfill with missing-range metadata |
| Streams | `StreamCoordinator` / `StreamEnsurePlanner` | Start and stop ingestion + bar aggregator targets; share upstream streams across consumer leases |
| Events | `DataEventBus` | Callback and async-iterator event distribution |
| Aggregation Bridge | `AggregatorBridge` | Persist bar events, merge cache, emit `DataEvent` |
| Backfill | `BackfillCoordinator` | Request dedup, merge, retry, cancel, storage readback, event mapping |
| Custom Query | `CustomQueryEngine` | Query custom intervals consistently |
| Warm Start | `AggregatorWarmStartService` | Seed aggregator state from storage on startup |
| Price | `IngestionPriceSource` / `PriceSnapshotCache` | Lightweight realtime price stream and snapshots |
| Subscription | `SubscriptionService` | Watchlist tiers: `full`, `price`, `none`; persisted full intervals and consumer leases |
| Maintenance | `maintenance.py`, `retention.py` | storage repair, gap scan, retention limits |

## Public API

Common methods on `DataManager`:

| Method | Purpose |
|---|---|
| `start()` / `shutdown()` | Lifecycle |
| `query()` | Query a range, optionally triggering backfill |
| `query_latest()` | Latest N bars |
| `query_before()` | Pagination before a timestamp |
| `get_bounds()` | Storage metadata for a series |
| `scan_storage_gaps()` | Continuity scan without repair |
| `ensure_stream()` | Ensure realtime ingestion + aggregation is running, optionally registered to a consumer lease |
| `release_stream()` | Release a consumer lease without forcing unrelated consumers to stop |
| `subscribe()` / `unsubscribe()` | Callback event subscription |
| `subscribe_iter()` | Async iterator event subscription |
| `on_bar_event()` | Consume `BarAggregator` events |
| `on_bars_backfilled()` | Merge repaired bars after storage readback |
| `get_prices_snapshot()` | Current watched-symbol price snapshots |
| `get_subscription_service()` | Access subscription tier manager |
| `repair_custom_storage()` | Rebuild custom interval rows |
| `scan_and_fill_storage_gaps()` | Manual gap scan and repair |
| `update_retention_limits()` | Update DB/ephemeral retention settings |
| `snapshot()` | Full diagnostic snapshot |

Example:

```python
from app.data_engine.data_manager import DataManager

dm = DataManager()
await dm.start()

await dm.ensure_stream("BTCUSDT", "1m", exchange="binance", market_type="spot")
result = dm.query_latest("BTCUSDT", "1m", 500, "binance", market_type="spot")

handle = dm.subscribe(callback=on_event, symbol="BTCUSDT", interval="1m")
dm.unsubscribe(handle)

await dm.shutdown()
```

## Public Types

The package root exports the stable facade and contracts:

- Config: `DataManagerConfig`, `CacheConfig`, `QueryConfig`, `EventBusConfig`, `CoordinatorConfig`, `PrewarmTarget`
- Data: `BarData`, `SeriesKey`, `QueryResult`, `MissingRange`, `QuerySource`
- Events: `DataEvent`, `DataEventType`, `SubscriptionHandle`
- Streams: `StreamInfo`, `StreamStatus`
- Storage protocol: `StorageBackend`
- Maintenance/subscription: `MaintenanceBusyError`, `MaintenanceUnavailableError`, `SubscriptionTier`

## Timestamp And Identity Rules

- Storage and internal engine timestamps are milliseconds.
- `BarData.time` is Unix seconds for `lightweight-charts`.
- `SeriesKey` normalizes symbol to uppercase and exchange/market type to lowercase.
- Binance spot topics remain compact: `BTCUSDT@1m`.
- Non-default exchange or market type is prefixed: `okx:swap:BTC-USDT@1m`, `futures:BTCUSDT@1m`.

## Query Semantics

`QueryEngine` resolves data in this order:

1. Cache, when the requested range is present.
2. Storage, via the injected storage backend.
3. Backfill trigger, when missing ranges are detected and `auto_backfill` is enabled.

`QueryResult` includes:

- `bars`: sorted ascending `BarData`
- `source`: `cache`, `storage`, `backfill`, `mixed`, or `empty`
- `cache_hit`
- `has_more`
- `backfill_triggered`
- `has_tail_gap`
- `missing_ranges`
- `metadata`

API range endpoints add visible-range verification on top of this metadata.

## Stream Lifecycle

`ensure_stream()` is the public way to start realtime data:

```text
ensure_stream(symbol, interval)
        ▼
StreamEnsurePlanner
        ▼
StreamCoordinator
        ├── BarAggregator.add_target()
        └── IngestionFactory.start(on_market_event)
```

The planner chooses the required source streams. For custom intervals, this can mean starting a suitable base interval and registering the requested target interval with the aggregator.

## Backfill Coordination

`BackfillCoordinator` is deliberately separate from `BackfillEngine`:

- Converts facade/API requests into semantic demands with `reason`, `priority`,
  `requester`, and metadata.
- Deduplicates in-flight requests.
- Merges compatible pending ranges while preserving the highest priority.
- Splits large repairs into chunks; user-visible repairs run newest-first.
- Runs different series concurrently while keeping the same
  `(exchange, market_type, symbol, interval)` serialized.
- Maintains per-exchange/market token buckets for scheduler-level pacing.
- Persists gap lifecycle in `GapLedger`.
- Handles retry/cancel/shutdown.
- Runs `BackfillEngine`.
- Reads `RepairReport.written_ranges` back from storage.
- Calls `DataManager.on_bars_backfilled()`.
- Emits `BACKFILL_COMPLETED` or `BACKFILL_FAILED`.

API and settings code should trigger repair through DataManager/coordinator, not call `BackfillEngine.run()` directly.

Current demand mapping:

| Source | Reason | Priority |
|---|---|---:|
| `/klines/history` | `initial_history` | 10 |
| `/klines/range` | `visible_range_gap` | 20 |
| `/klines/history/before` | `visible_load_more` | 20 |
| foreground custom/base warm start | `visible_seed_gap` | 30 |
| same-symbol interval warmup | `related_interval_warmup` | 40 |
| ingestion tail gap | `tail_gap` | 50 |
| `SubscriptionTier.FULL` warmup | `full_subscription_warmup` | 60 |
| price stream daily open | `price_daily_open` | 70 |
| `/klines/latest` if explicitly enabled | `latest_refresh` | 80 |
| startup scan | `startup_gap_scan` | 120 |
| background audit | `background_gap_audit` | 150 |

`/klines/latest` is intentionally `auto_backfill=false` by default. On a cold
symbol, first-screen loading is driven by `/klines/history`, and related
intervals are submitted only as lower-priority warmup.

## Events

`DataEventType` values include:

- Bar lifecycle: `BAR_CREATED`, `BAR_UPDATED`, `BAR_CLOSED`, `BAR_AMENDED`, `BAR_EXPIRED`
- Stream lifecycle: `STREAM_STARTED`, `STREAM_STOPPED`, `STREAM_ERROR`
- Backfill lifecycle: `BACKFILL_STARTED`, `BACKFILL_COMPLETED`, `BACKFILL_FAILED`
- Cache/price: `CACHE_PREWARM`, `CACHE_EVICTION`, `PRICE_UPDATED`

Consumers can use callbacks or async iteration:

```python
async for event in dm.subscribe_iter(symbol="BTCUSDT", interval="1m"):
    print(event.to_dict())
```

## Configuration

`DataManagerConfig` groups:

| Section | Important Fields |
|---|---|
| `cache` | `max_bars_per_series`, `max_series`, `prewarm_bars`, `ttl_seconds` |
| `query` | `default_limit`, `max_limit`, `sync_backfill_timeout_seconds`, `auto_backfill` |
| `event_bus` | `subscriber_queue_size`, `emit_bar_updated`, `emit_bar_created` |
| `coordinator` | `auto_start_ingestion`, `idle_stream_timeout_seconds`, `base_interval`, `prewarm_intervals`, `prewarm_symbols`, `prewarm_targets` |

## Maintenance

`DataManager` exposes maintenance through facade methods used by settings API:

- `repair_custom_storage()`
- `scan_and_fill_storage_gaps()`
- `scan_storage_gaps()`
- `update_retention_limits()`
- `retention_snapshot()`

Maintenance methods raise `MaintenanceBusyError` for concurrent conflicting work and `MaintenanceUnavailableError` when a required runtime dependency is missing.

## Tests

```bash
cd backend
python -m pytest -q \
  tests/test_query_engine_paths.py \
  tests/test_backfill_coordinator.py \
  tests/test_data_manager_warm_start_bridge.py \
  tests/test_maintenance_facade.py \
  tests/test_price_subscription_services.py
```
