# Data Engine Architecture Overview

> CandleScope backend market-data layer. The current backend is organized around a modular Data Engine: `ingestion` receives exchange data, `bar_aggregator` owns K-line lifecycle, `data_manager` is the public business facade, `backfill` repairs historical gaps, and `storage` preserves channel-specific persistence semantics.

中文文档见 [README_zh.md](README_zh.md).

## Data Flow

```text
Exchange WS / REST
        │
        ▼
ingestion
        │ MarketEvent / GapMarker
        ▼
bar_aggregator
        │ BarEvent
        ▼
data_manager
        │ QueryResult / DataEvent / PriceSnapshot
        ▼
FastAPI / WebSocket / Indicator / Subscription / Settings

Historical repair:
QueryEngine / Settings / Ingestion GapMarker
        ▼
DataManager.BackfillCoordinator
        ▼
demand-aware scheduler
        ▼
chunked BackfillEngine runs
        ▼
backfill
        ▼
storage
        ▼
DataManager cache + EventBus
```

## Module Boundaries

| Module | Owns | Does not own |
|---|---|---|
| `ingestion` | Exchange HTTP/WS I/O, WS lifecycle, HTTP fallback, payload normalization, deduplication, `GapMarker` output | Business K-line generation, storage writes, historical repair |
| `bar_aggregator` | Bucket calculation, OHLCV merge, forming/closed lifecycle, custom interval aggregation, `BarEvent` publishing | Exchange connectivity, storage I/O, subscription management |
| `data_manager` | Unified query/cache/event/stream/backfill coordination/price/subscription/maintenance facade plus MarketDataCatalog channel ownership and capability metadata | Exchange protocol details, hand-written backfill pipeline, or flattening unlike data into one generic query |
| `backfill` | Historical detect/plan/fetch/reconcile/publish pipeline, `RepairReport`, `written_ranges` | API/WS management, direct DataManager cache mutation |
| `storage` | SQLite repositories for bars/metrics/rollups, raw trade archives, gap ledger, shared SQLite policy, and schema manifest | Business facade responsibilities or cross-backend atomicity |
| `interval_policy.py` | Canonical interval identity and fixed/week/month timeline semantics | Exchange-native decisions, network, or storage access |
| `interval_resolution.py` | Native/derived route and exact base selection by exchange, market, and history/realtime purpose | Bucket calculation or I/O |
| `runtime.py` | Application composition root: construct, inject, start, and shut down Data Engine | Business query logic |

## Unified Market-Data Boundary

The control plane is unified; the physical stores are not:

```text
API / WS / Indicator / Replay preparation
                    │
              DataManager
       stream / event / typed facade
                    │
             MarketDataCatalog
      owner / access / storage role / health
          │          │          │
       bars       trades      order books
    cache+SQLite  ring+rollup  process memory
                  +archive     +reconstruction
```

- `market_data/ports.py` defines typed service ports while preserving channel-specific consistency and query semantics.
- `market_data/catalog.py` publishes provider ownership, access modes, storage roles, and diagnostics; one channel has one owner.
- `storage/sqlite_runtime.py` centralizes timeout, busy timeout, WAL fallback, row factory, and synchronous policy.
- `storage/bootstrap.py` is the single startup entrypoint for market-storage schemas and records the `market_storage_schema` manifest.
- Typed namespaces expose the supported semantics directly: `dm.bars`, `dm.market_state`, `dm.trades`, `dm.liquidations`, `dm.books.partial`, and `dm.books.full`. Existing flat methods remain compatibility wrappers.
- `GET /api/v1/settings/storage/health` reports the catalog/control snapshot and startup storage manifest alongside gap/backfill health.
- Replay, Backtest, immutable archives, and process-local order books retain separate physical boundaries.

## Composition Root

Production wiring is centralized in [runtime.py](runtime.py). `app/main.py` only calls `start_data_engine()` and attaches stable handles to FastAPI `app.state`.

```text
DataEngineRuntime
├── DataManager
│   └── MarketDataCatalog
├── KlinesRepoAdapter / AsyncKlinesRepoAdapter
├── GapLedger
├── MarketDataService / PublicTradeService / LiquidationService
├── OrderBookService / FullOrderBookService
├── ExchangeIngestionFactory
├── TransportLayer(IngestionConfig)       # backfill REST transport
├── BackfillEngine
├── BackfillCoordinator
├── IngestionPriceSource
└── SubscriptionService
```

Stable app-state handles:

- `app.state.data_engine_runtime`
- `app.state.data_manager`
- `app.state.market_storage_bootstrap`, the startup schema/provider storage manifest
- `app.state.indicator_engine`, created by the Indicator bridge

API modules should not hold internal objects such as `BackfillEngine`, `BarAggregator`, or `TransportLayer` directly. The architecture boundary tests enforce this.

## Runtime Lifecycle

`start_data_engine()` does the following:

1. Creates `DataManager()`.
2. Creates `KlinesRepoAdapter()`, `AsyncKlinesRepoAdapter()`, and `GapLedger()`.
3. Injects storage into DataManager.
4. Creates and injects `ExchangeIngestionFactory`.
5. Starts a backfill-specific `TransportLayer(IngestionConfig())`.
6. Creates `BackfillEngine(storage=async_storage, transport=transport, ingestion_config=ingestion_cfg)`.
7. Creates `BackfillCoordinator` with explicit sinks: `bars_backfilled=dm.on_bars_backfilled` and `emit_event=dm.emit_event`.
8. Sets `dm.set_backfill_trigger(backfill_coordinator.trigger)`.
9. Starts DataManager.
10. Starts price/subscription workflows.
11. Schedules startup gap scan and background gap audit tasks.

Shutdown order:

1. Cancel gap scan / gap audit tasks.
2. Shut down `BackfillCoordinator`.
3. Stop the price source.
4. Shut down `DataManager`.
5. Shut down the ingestion factory.
6. Stop the backfill transport.

## Realtime K-line Path

```text
DataManager.ensure_stream()
        ▼
StreamEnsurePlanner
        ▼
StreamCoordinator
        ├── BarAggregator.add_target()
        └── IngestionFactory.start(on_market_event)
                ▼
ingestion.MarketEvent
        ▼
BarAggregator.on_market_event()
        ▼
BarEvent
        ▼
DataManager.on_bar_event()
        ▼
storage upsert + cache merge + EventBus
```

Important conventions:

- Every interval shares the `IntervalSpec` timeline; only `IntervalResolver` owns exchange-native versus derived routing.
- BarAggregator selects snapshot/component/price-only behavior from input `MergeMode`, not from the target interval's spelling.
- `BarData.time` is seconds for the frontend; storage/internal timestamps are milliseconds.
- Non-default exchange or non-spot market type is part of keys and topics, for example `okx:swap:BTC-USDT@1m`.
- OKX `1m` realtime can fan out to larger resolver-native intervals that it tiles exactly. Those updates use `MergeMode.PRICE_ONLY`, updating OHLC without accumulating volume/trades.

## Historical Repair Path

```text
QueryEngine / Settings / GapMarker
        ▼
BackfillCoordinator.trigger()
        ▼
BackfillEngine.run()
        │ detect -> plan -> fetch -> reconcile -> publish
        ▼
RepairReport.written_ranges
        ▼
precise storage readback
        ▼
DataManager.on_bars_backfilled()
        ▼
cache merge + BACKFILL_COMPLETED / BACKFILL_FAILED
```

Key rules:

- `BackfillEngine` only runs the repair pipeline; it does not mutate DataManager cache directly.
- `BackfillCoordinator` owns semantic priority, request deduplication, range merging, chunk scheduling, retry, cancel, gap-ledger state, and event mapping.
- `RepairReport.written_ranges` is the authoritative cache readback range.
- `PARTIAL` means some write/fetch batch failed and is not reported as completed.
- Current chart history (`initial_history`) outranks latest refreshes, related interval warmups, subscriptions, startup scans, and background audits.
- Large user-visible ranges are chunked newest-first so the chart's right edge can become renderable earlier.
- Different series can backfill concurrently; the same series stays serialized for reconcile/write safety.
- Frontend loading reacts to the completed `symbol / interval / range / reason`, not to any arbitrary `BACKFILL_COMPLETED` event.

## Price Streams And Subscriptions

Price flow is provided by `IngestionPriceSource`, `PriceSnapshotCache`, and `SubscriptionService`:

- Watchlist sync registers new symbols as `price` tier.
- `full` tier keeps both K-line and price streams.
- `price` tier keeps lightweight price flow only.
- `none` stops related realtime work.
- Factories with `start_price_many` can use a multi-symbol ticker stream; unsupported exchanges fall back to per-symbol streams.

## Maintenance API

Operational entrypoints are exposed through the settings API:

- `POST /api/v1/settings/storage/repair`: rebuild custom interval storage from authoritative base data.
- `POST /api/v1/settings/storage/gap-scan`: scan stored standard intervals and submit backfill.
- `GET /api/v1/settings/storage/health`: inspect gap ledger, audit series, and backfill coordinator state.
- `POST /api/v1/settings/cache-limits`: update retention and ephemeral-series limits.

## Directory Index

| Path | Docs |
|---|---|
| [ingestion](ingestion/) | Six-layer realtime market-data ingress pipeline |
| [bar_aggregator](bar_aggregator/) | K-line aggregation, buckets, finalizers, event publishing |
| [data_manager](data_manager/) | Unified facade, query, cache, subscriptions, events |
| [backfill](backfill/) | Historical gap repair pipeline |
| [storage](storage/) | SQLite repo and gap ledger; no standalone README yet |
| [interval_policy.py](interval_policy.py) | Interval parsing and bucket policy |
| [runtime.py](runtime.py) | Data Engine composition root |
| [MARKET_EVENT_DIRECT_PATH_zh.md](MARKET_EVENT_DIRECT_PATH_zh.md) | Design and implementation notes for routing L6 `MarketEvent` directly into `BarAggregator` |
| [DATA_FLOW_PATHS.md](DATA_FLOW_PATHS.md) | Current path map for realtime K-lines, backfill, price snapshots, indicators, and exchange WS routing |
| [ARCHITECTURE_POLISH_ROADMAP.md](ARCHITECTURE_POLISH_ROADMAP.md) | Cross-module roadmap for simplifying names, routes, WS capability routing, and path-level tests |

## Verification

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

Focused Data Engine checks:

```bash
cd backend
python -m pytest -q \
  tests/test_data_engine_phase1_boundaries.py \
  tests/test_ingestion_delivery.py \
  tests/test_ingestion_normalizers.py \
  tests/test_ingestion_session_types.py \
  tests/test_bar_aggregator_contracts.py \
  tests/test_backfill_coordinator.py \
  tests/test_backfill_gap_detector.py \
  tests/test_backfill_rate_limit.py \
  tests/test_backfill_reconciler.py \
  tests/test_transport_http_rate_limit_metadata.py \
  tests/test_okx_backfill_fetcher.py \
  tests/test_data_manager_warm_start_bridge.py
```
