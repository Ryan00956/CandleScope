# CandleScope Backend

[中文](README_zh.md)

> FastAPI backend for CandleScope. It provides K-line data, realtime WebSocket streams, exchange metadata, indicator computation, custom Pyne scripts, proxy/settings management, subscriptions, and storage repair tools.

## Runtime Stack

- Python FastAPI app: `app/main.py`
- Core async infrastructure: `app/core/executors.py`, `app/core/runtime_metrics.py`
- Market data runtime: `app/data_engine/runtime.py`
- Exchange registry/plugins: `app/exchanges`
- Indicator engine and Pyne runtime: `app/indicator`
- Generic script-runtime Host/Supervisor/Installer: `app/plugin_runtime`
- SQLite K-line storage: `app/data_engine/storage`

## Quick Start

CandleScope's default first-party Pyne/Pine bundles require Windows CPython
3.12. Unsupported interpreters fail fast before the FastAPI application starts.

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

On Windows, `dev-server.ps1` runs the same development server with UTF-8 output
enabled:

```powershell
.\dev-server.ps1
```

The Windows entrypoint leaves Uvicorn reload disabled because its Selector
event loop cannot launch the Pyne/Pine sidecar subprocesses CandleScope needs.

Default API base:

```text
http://127.0.0.1:18080
```

Interactive docs:

```text
http://127.0.0.1:18080/docs
```

Health checks:

```bash
curl http://127.0.0.1:18080/health
curl http://127.0.0.1:18080/debug/snapshot
```

## Startup Sequence

`app/main.py` performs:

1. Start the event-loop lag monitor.
2. Initialize SQLite K-line storage.
3. Load runtime activation state and start explicitly configured autostart
   sidecars; an absent default registry means zero plugins.
4. Refresh exchange symbol metadata on a best-effort basis.
5. Start Data Engine through `start_data_engine()`.
6. Attach stable runtime handles to `app.state`.
7. Bridge IndicatorEngine to DataManager events.

Shutdown stops the lag monitor and IndicatorEngine, reclaims plugin sidecars,
and then shuts down the Data Engine runtime. See
[`app/plugin_runtime/README.md`](app/plugin_runtime/README.md) and the
[`installer guide`](app/plugin_runtime/INSTALLER.md) for host configuration,
`.cspkg` installation, rollback, and security boundaries. Phase 3 does not
route the existing Indicator/Pyne path to sidecars.

## API Overview

All application APIs are mounted under `/api/v1`.

| Area | Endpoints |
|---|---|
| K-lines | `GET /klines/`, `/latest`, `/history`, `/range`, `/history/before`, `/resolve`, `/storage/meta`, `/continuity`, `DELETE /klines/storage` |
| Advanced market data | `GET /market/snapshot`, `GET /market/history` |
| Streams | `WS /stream/klines`, `WS /stream/klines_multi`, `WS /stream/indicators`, `WS /stream/prices`, `WS /stream/market` |
| Indicators | `GET /indicators/registry`, runtime discovery, presets, custom CRUD, Pyne security, diagnostics, `POST /indicators/compute` |
| Exchanges | `GET /exchanges/`, `GET /exchanges/diagnostics`, `GET /exchanges/{exchange}/capabilities` |
| Symbols | `GET /symbols/exchange-info`, `POST /symbols/exchange-info/refresh` |
| Settings | proxy get/update/test, storage repair, gap scan, storage health, cache limits |
| Subscriptions | list, sync, prices snapshot, get/set/delete symbol tier |
| Replay (opt-in) | capabilities, catalog, session create/get/fork/command, journal, report, and `WS /stream/replay/{session_id}` |

The enhanced K-line volume, delta, and CVD-contribution contract is documented in [`docs/KLINE_ORDER_FLOW_CONTRACT_zh.md`](../docs/KLINE_ORDER_FLOW_CONTRACT_zh.md).

System endpoints outside `/api/v1`:

- `GET /`
- `GET /health`
- `GET /debug/snapshot`

## Deterministic Replay Runtime (Opt-In)

Replay is disabled by default. `REPLAY_ENABLED=0` does not construct the
`ReplayService`, open `REPLAY_DB_PATH`, start an actor task, or allow session
creation. The disabled capability response remains stable so the independent
frontend page can show `REPLAY_DISABLED` instead of falling back to live data.

Replay training v2 has an additional subordinate switch,
`REPLAY_PRODUCT_V2_ENABLED`. It defaults to enabled so v2 is selected whenever
the authoritative `REPLAY_ENABLED` gate is opened. Explicitly setting the
subordinate switch to `0` restores the v1 route; it does not weaken the
authoritative gate or enable optional archive, book, worker, or optimization
capabilities.

When enabled, replay owns a separate SQLite database and a bounded runtime:

```text
frozen BAR snapshot or exact paged AGG_TRADE archive
  -> single-writer ReplaySessionActor + virtual clock
  -> replay-only bar builder + PAPER_LINEAR_V1 broker/ledger
  -> commit-before-publish ReplaySQLiteStore
  -> replay.v1 HTTP + resumable bounded WebSocket
```

BAR replay defaults to an independent immutable Parquet history plane and does
not open the production K-line database. Commands, checkpoints, orders, fills,
ledger entries, journals, bounded selected snapshots, and reports are stored in
`REPLAY_DB_PATH`. Snapshot bodies are compressed, content-addressed files under
`<REPLAY_DB_PATH>.datasets`; SQLite keeps their checksums and references.
Active dataset snapshots/partitions, mailboxes, event rings, subscriber queues,
checkpoint history, and frontend projection windows all have explicit capacity
limits.

Treat `REPLAY_DB_PATH` and `<REPLAY_DB_PATH>.datasets` as one recovery set.
Stop the replay backend before copying or restoring them so SQLite references
and content-addressed snapshot objects remain from the same point in time.

Training drafts use `ALL_AVAILABLE` chart history by default. The immutable
execution snapshot remains bounded by indicator warmup plus forward cache;
older pre-start chart bars are paged from the same immutable replay-history
catalog revision that created the Run, up to its continuous-history boundary.
This path never queries live SQLite, never triggers exchange backfill, and
cannot reveal data after the durable virtual-time cursor.

### Replay Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `REPLAY_ENABLED` | `0` | Authoritative backend feature/capability switch |
| `REPLAY_PRODUCT_V2_ENABLED` | `1` | Subordinate v2 product selector; explicit `0` restores v1 while the authoritative replay gate remains unchanged |
| `REPLAY_DB_PATH` | `<CANDLE_DATA_DIR>/replay.db` | Replay-only SQLite state; must differ from `KLINES_DB_PATH` |
| `REPLAY_BAR_SOURCE` | `archive` | `archive` uses the isolated immutable history plane; `legacy_sqlite` is an explicit rollback mode |
| `REPLAY_HISTORY_ARCHIVE_DIR` | `<CANDLE_DATA_DIR>/replay-history` | Local archive, or disposable metadata/object cache when `REPLAY_HISTORY_ORIGIN_URI` is set |
| `REPLAY_HISTORY_ORIGIN_URI` | unset | Authoritative `file`/HTTP(S) history root; its index and manifests define random eligibility independently of cache bodies |
| `REPLAY_HISTORY_CATALOG_REFRESH_SECONDS` | `300` | Remote metadata refresh TTL; `0` refreshes on every catalog access |
| `REPLAY_HISTORY_DOWNLOAD_TIMEOUT_SECONDS` | `60` | Bounded timeout for remote metadata and selected-object downloads |
| `REPLAY_AGG_TRADE_ENABLED` | `0` | Independent exact aggregate-trade replay gate |
| `REPLAY_AGG_TRADE_ARCHIVE_DIR` | `<CANDLE_DATA_DIR>/replay-agg-trades` | Read-only checksum-verified aggregate-trade replay archive |
| `REPLAY_AGG_TRADE_ORIGIN_URI` | unset | Authoritative remote compatibility/receipt index and on-demand aggregate-trade object origin |
| `REPLAY_MAX_ACTIVE_SESSIONS` | `8` | Active pinned session limit |
| `REPLAY_COMMAND_QUEUE_SIZE` | `256` | Per-actor bounded command mailbox |
| `REPLAY_EVENT_BUFFER_SIZE` | `10000` | Resumable domain event ring |
| `REPLAY_MAX_EMIT_FPS` | `30` | Ordinary projection ceiling; mandatory events flush immediately |
| `REPLAY_MAX_WARMUP_BARS` | `5000` | Session warmup ceiling |
| `REPLAY_MAX_BAR_DATASET_ROWS` | `100000` | Frozen BAR snapshot row ceiling |
| `REPLAY_MAX_HORIZON_DAYS` | `30` | BAR horizon ceiling |
| `REPLAY_TRADE_PAGE_ROWS` | `50000` | Maximum aggregate-trade page size |
| `REPLAY_CHECKPOINT_EVENT_INTERVAL` | `10000` | Source-event checkpoint cadence |
| `REPLAY_CHECKPOINT_VIRTUAL_MS` | `300000` | Virtual-time checkpoint cadence |
| `REPLAY_EVENT_SUBSCRIBER_QUEUE` | `256` | Per-WebSocket bounded subscriber queue |
| `REPLAY_CONTROLLER_TTL_SECONDS` | `10` | Controller heartbeat lease |
| `REPLAY_IDLE_TTL_SECONDS` | `3600` | Configured idle-session lifetime |
| `RAW_AGG_TRADE_ARCHIVE_ENABLED` | `0` | Enables live aggregate-trade capture only |
| `RAW_AGG_TRADE_ARCHIVE_DIR` | `<CANDLE_DATA_DIR>/raw-agg-live-spool` | Mutable live capture spool; replay never reads this path |

Use [`.env.replay.example`](.env.replay.example) as a starting point. The
frontend entry flag is separate and is not an authorization boundary.

### Data Preparation and Capability Rules

Install the Parquet dependency and build the BAR history catalog from official
checksum-verified Binance archives. Missing source objects split continuity;
they do not invalidate later continuous segments:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-parquet.txt

.\.venv\Scripts\python.exe scripts\import_binance_replay_history.py `
  --market-type spot --symbol BTCUSDT --interval 1m `
  --start 2017-07-01 --end 2026-07-30 `
  --archive-dir .\data\replay-history

.\.venv\Scripts\python.exe scripts\audit_replay_history.py `
  --archive-dir .\data\replay-history `
  --market-type spot --symbol BTCUSDT --interval 1m `
  --verify-objects

.\.venv\Scripts\python.exe scripts\audit_replay_history_parity.py `
  --archive-dir .\data\replay-history `
  --live-db .\data\candlescope.db `
  --market-type spot --symbol BTCUSDT --interval 1m
```

The importer publishes content-addressed objects before atomically moving
`current.json`. Runs pin the selected catalog epoch, so a later import cannot
change their snapshot or `ALL_AVAILABLE` history. For emergency compatibility
only, set `REPLAY_BAR_SOURCE=legacy_sqlite` and use
`scripts/snapshot_replay_klines.py`; this opt-in mode restores the previous
read-only SQLite source. The full BAR archive contract and operations runbook
is [`../docs/KLINE_REPLAY_HISTORY_ARCHIVE_zh.md`](../docs/KLINE_REPLAY_HISTORY_ARCHIVE_zh.md).
When a closed monthly checksum is absent, the importer automatically attempts
that month's checksum-verified daily objects before declaring a source gap.

After publishing new current manifests to a remote origin, rebuild its compact
control-plane index. A runtime configured with an origin samples this index,
persists the exact selection, and only then downloads overlapping bodies into
its local cache:

```powershell
.\.venv\Scripts\python.exe scripts\publish_replay_history_remote_index.py `
  --archive-dir .\data\replay-history-origin
```

AGG_TRADE accepts only checksum-verified official Binance USD-M daily files.
Import is idempotent; identity, date, schema, checksum, monotonicity, or ID
conflicts are quarantined and keep the capability closed:

```powershell
.\.venv\Scripts\python.exe scripts\import_binance_public_agg_trades.py `
  --exchange binance --market-type futures --symbol BTCUSDT `
  --start 2026-06-01 --end 2026-06-01 `
  --archive-dir .\data\replay-agg-trades --require-checksum

.\.venv\Scripts\python.exe scripts\audit_replay_trade_archive.py `
  --exchange binance --market-type futures --symbol BTCUSDT `
  --start 2026-06-01 --end 2026-06-01 `
  --archive-dir .\data\replay-agg-trades --require-exact

.\.venv\Scripts\python.exe scripts\build_replay_trade_bar_compatibility.py `
  --exchange binance --market-type futures --symbol BTCUSDT --interval 1m `
  --start 2026-06-01 --end 2026-06-01 `
  --trade-archive-dir .\data\replay-agg-trades `
  --bar-archive-dir .\data\replay-history
```

Random AGG_TRADE starts are sampled only from the intersection of eligible BAR
windows and a revision-bound compatibility index built by the final command
above. The index compares every aggregate-trade-derived BAR with one immutable
BAR archive revision and stores only maximal matching segments. The complete
forward replay range must fit inside one such segment. Proofs are immutable per
BAR revision, raw dataset epoch, and parity policy, so publishing a later day
cannot overwrite earlier verified coverage.

For remote AGG_TRADE serving, publish checksum-bound compatibility proofs and
verified receipts after the offline parity job:

```powershell
.\.venv\Scripts\python.exe scripts\publish_replay_agg_trade_remote_index.py `
  --archive-dir .\data\replay-agg-trades-origin
```

`EXACT_BAR_COVERAGE` uses the conservative BAR execution model.
`EXACT_AGG_TRADE_COVERAGE` uses an aggregate-tape, volume-constrained execution
model. Replay v1 does **not** provide or claim `RAW_TRADE`, `L2_BOOK`, or
`EXCHANGE_FUTURES_EXACT` fidelity.

For AGG_TRADE sessions, bar parity remains fail-closed for timestamps, OHLC,
base/quote volume, and taker-buy volume. Binance may aggregate individual fills
across a minute boundary into one `aggTrade`; those affected official K-lines
cannot be reconstructed exactly from the aggregate event and are excluded from
random candidates. The K-line `trades` counter is never reconstructible from
aggregate events and remains explicitly non-comparable. Session creation still
rechecks the selected window after the metadata-only random choice.

### Failure Recovery and Rollback

- Graceful shutdown first pauses a `PLAYING` actor, persists
  `status_reason=shutdown_pause`, flushes/checkpoints, then closes the store.
- Restart recovery is `PAUSED` or `ENDED`; wall-clock autoplay and controller
  ownership are never restored.
- Controller expiry, sequence/epoch mismatch, slow subscribers, SQLite busy or
  write failure, corrupt checkpoints, dataset drift, and degraded archives all
  fail closed with bounded diagnostics or explicit resynchronization.
- Set `REPLAY_ENABLED=0` and restart to disable the backend in one deployment.
  The capability reports persistence unopened; retain `replay.db`.
- To roll back only aggregate-trade replay, set
  `REPLAY_AGG_TRADE_ENABLED=0`; live capture and BAR replay are independent.
- To roll back only the BAR history reader, set
  `REPLAY_BAR_SOURCE=legacy_sqlite` and restart. Do not delete
  `REPLAY_HISTORY_ARCHIVE_DIR`; old catalog epochs remain Run dependencies.
- Replay storage schema upgrades are forward-only. Before starting a build that
  migrates `replay.db`, stop replay and back up both `replay.db` and its
  `.datasets` directory. A full rollback to an older replay-aware build must
  either keep `REPLAY_ENABLED=0` or restore that pre-upgrade recovery set; it
  must not open a newer schema with the older runtime.

Formal local gates are `scripts/audit_replay_determinism.py`,
`scripts/benchmark_replay.py`, the frontend `smoke:replay` and 4-hour replay
soak, and `frontend/scripts/replay-rollback-drill.ps1`. Passing local gates does
not make replay default-on; production observation and an explicit enablement
decision remain separate.

## Data Engine

The backend data path is:

```text
Exchange WS/REST
        ▼
ingestion
        ▼
bar_aggregator
        ▼
data_manager
        ▼
API / WS / Indicator
```

Historical repair path:

```text
Query/Settings/GapMarker
        ▼
BackfillCoordinator
        ▼
BackfillEngine
        ▼
storage
        ▼
DataManager cache + events
```

Detailed docs:

- [app/data_engine](app/data_engine/)
- [app/data_engine/ingestion](app/data_engine/ingestion/)
- [app/data_engine/bar_aggregator](app/data_engine/bar_aggregator/)
- [app/data_engine/backfill](app/data_engine/backfill/)
- [app/data_engine/data_manager](app/data_engine/data_manager/)
- [app/data_engine/DATA_FLOW_PATHS.md](app/data_engine/DATA_FLOW_PATHS.md)
- [app/data_engine/ARCHITECTURE_POLISH_ROADMAP.md](app/data_engine/ARCHITECTURE_POLISH_ROADMAP.md)

## Concurrency Model

The backend keeps the FastAPI event loop as an orchestration layer. Blocking or heavy work is routed through bounded infrastructure instead of running inline on the loop.

```text
FastAPI event loop
  -> request / WebSocket orchestration
  -> no blocking storage query
  -> no heavy indicator compute
  -> no Pyne process wait

Core executors
  -> indicator executor: builtin indicator HTTP/range compute
  -> pyne-wait executor: Pyne process wait and Pyne snapshot work
  -> storage executor: SQLite/DataManager synchronous storage paths

DataEventBus
  -> emit() filters and enqueues
  -> each callback subscriber has a bounded queue and worker
  -> iterator subscribers use bounded queues

BackfillScheduler
  -> priority queue
  -> per-series single flight
  -> global concurrency limit
  -> token bucket rate limit
  -> delayed drain wakeup after rate-limit skips
```

New core modules:

- `app/core/executors.py` owns the dedicated thread pools and executor queue/run statistics.
- `app/core/runtime_metrics.py` owns event-loop lag sampling and aggregate WebSocket send/heartbeat metrics.

This keeps business ownership local: APIs orchestrate, DataEventBus delivers events, BackfillScheduler schedules repairs, and core modules provide shared runtime infrastructure.

## Exchange Plugins

Built-in exchanges are registered through `app.exchanges.registry`:

- Binance
- OKX

Plugin template:

- [app/exchanges/plugins/_template](app/exchanges/plugins/_template/)

Architecture guide:

- [app/exchanges](app/exchanges/)

Exchange plugins expose capabilities, symbol normalization, REST/WS protocol specs, subscription specs, realtime policy, rate limits, pagination policy, and payload normalization. Adapters remain as legacy facades for older imports.

Long-lived plugin boundaries:

- Capability schema v2 adds an authoritative per-market `channels` matrix: realtime/history transports, delivery class, snapshot/delta and resync semantics, normalized field availability, parameters, update intervals, limits, connection model, and known limitations. Schema-v1 plugins remain loadable; their empty channel matrix means "unknown", not "unsupported".
- `ExchangeRegistry.register()` rejects plugins whose major plugin API version or capability schema is not supported by this backend.
- `GET /api/v1/exchanges/diagnostics` reports load status, protocol class, adapter facade, policy classes, and capability coverage counts for each plugin.
- `app.exchanges.contracts` provides a reusable contract harness for capability declarations, REST specs, WS connection models, payload extraction, historical pagination, fixture coverage, and normalizer output schema.
- Built-in contract fixtures live under `tests/fixtures/exchanges/`; add new exchange fixtures there before wiring the plugin into runtime code.
- Optional out-of-tree plugins can be loaded with `CANDLESCOPE_EXCHANGE_PLUGINS=module.path,module.path:factory`. This path is explicit and diagnostics-backed; built-in plugins still load first.
- The frontend consumes `/api/v1/exchanges/` for interval lists, market availability, WS mode, and user-visible limitations. Keep new exchange UI behavior in capabilities rather than hard-coded frontend branches.

## Indicators And Pyne

Indicator docs:

- [app/indicator](app/indicator/)
- [Runtime plugin host](app/plugin_runtime/README.md)
- [Pyne sidecar bridge](../packages/candlescope-plugin-pyne/README.md)

Built-ins include `MA`, `EMA`, `MACD`, `RSI`, `BOLL`, `ATR`, and `VOL`.

Pyne scripts run only through the isolated `candlescope.pyne` sidecar. Security
modes are `safe`, `research`, and `unsafe`; the sidecar inherits the selected
policy without importing Pyne into the backend process.

CandleScope contains neither a Pyne Runtime source snapshot nor an in-process
Pyne facade. On the first supported Windows CPython 3.12 startup, the product
bootstrap verifies and installs the exact prerelease `.cspkg` pinned in
`app/official-plugin-releases.json`. Later startups rerun the managed
environment probe without downloading again:

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

Diagnostics expose the selected sidecar route under
`/api/v1/indicators/diagnostics -> pyne.runtimeBackend`.

For an offline first run, provide the same digest-pinned bundle explicitly:

```powershell
$env:CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE = "C:\release\candlescope-pyne-0.2.0-cp312-win_amd64.cspkg"
```

Set `CANDLESCOPE_OFFICIAL_PLUGIN_BOOTSTRAP=0` only when a compatible runtime is
already activated manually. Community runtimes continue to use the generic
local-artifact installer and are never downloaded or overwritten by the
first-party bootstrap.

HTTP indicator compute is offloaded through dedicated executors:

- Builtin indicator HTTP compute uses one-shot engine instances so it does not mutate the app-wide realtime `IndicatorEngine`.
- Script HTTP, range, batch, and WebSocket paths send typed requests to the selected sidecar.
- Both paths are guarded by `INDICATOR_HTTP_TIMEOUT_SECONDS`.

## Observability And Benchmarks

Diagnostics are exposed through existing endpoints:

```bash
curl http://127.0.0.1:18080/health
curl http://127.0.0.1:18080/debug/snapshot
curl http://127.0.0.1:18080/api/v1/indicators/diagnostics
curl http://127.0.0.1:18080/api/v1/settings/storage/health
```

Important fields:

| Field | Meaning |
|---|---|
| `event_loop_lag` | event-loop scheduling lag summary from `/health` |
| `runtime.event_loop_lag` | full event-loop lag snapshot in `/debug/snapshot` |
| `runtime.websocket.heartbeat_delay` | WebSocket heartbeat scheduling delay |
| `runtime.websocket.send_timeouts` | timed-out WebSocket sends grouped by payload type |
| `executors.*` | per-executor submitted/active/pending and queue/run timing |
| `event_bus.callback_lag` | callback subscriber queue lag and drops |
| `event_bus.queue_lag` | async-iterator subscriber queue lag and drops |
| `ready_chunks` / `running_chunks` / `next_drain_in_ms` | backfill scheduler state |

Run the concurrency benchmark against a live backend:

```bash
cd backend
python scripts/bench_concurrency.py --base-url http://127.0.0.1:18080
```

The benchmark exercises K-line latest queries, builtin indicator compute, Pyne compute, visible range repair, and the main WebSocket streams, then prints latency percentiles plus diagnostics before/after the run.

## Configuration

Environment variables are loaded through `python-dotenv`.

Common variables:

| Variable | Purpose |
|---|---|
| `CANDLE_HOST` | backend host, default `0.0.0.0` |
| `CANDLE_PORT` | backend port, default `8000` |
| `CANDLE_DATA_DIR` | data directory, default `backend/data` |
| `KLINES_DB_PATH` | SQLite DB path |
| `CORS_ORIGINS` | comma-separated frontend origins |
| `INGESTION_*` | realtime ingestion endpoints, timeout, proxy, WS/fallback tuning |
| `BACKFILL_*` | historical repair intervals, fetch limits, dedup, publish mode |
| `HISTORY_ARCHIVE_ENABLED` | official historical ZIP routing, default `1` |
| `HISTORY_ARCHIVE_CACHE_MAX_BYTES` | persistent archive LRU cap, default 10 GiB |
| `OKX_HISTORY_ARCHIVE_ENABLED` | guarded OKX website archive support, default `0` |
| `BAR_AGG_*` | aggregation source mode, alignment, finalization, event throttling |
| `PYNE_*` | Pyne security, executor mode, timeouts, output limits |
| `INDICATOR_HTTP_TIMEOUT_SECONDS` | HTTP indicator compute wait cap |
| `INDICATOR_THREAD_WORKERS` | builtin indicator executor size |
| `PYNE_HTTP_THREAD_WORKERS` | Pyne wait executor size |
| `STORAGE_THREAD_WORKERS` | storage executor size |
| `WS_SEND_TIMEOUT_SECONDS` | WebSocket send timeout |
| `EVENT_LOOP_LAG_INTERVAL_SECONDS` | event-loop lag sampling interval |

Proxy settings can also be updated through API and are persisted to:

```text
DATA_DIR/proxy_settings.json
```

## Storage

K-line storage is SQLite-backed. Internal timestamps use milliseconds. API chart bars use seconds in `BarData.time` for `lightweight-charts`.

Maintenance endpoints can:

- rebuild custom intervals from base intervals,
- scan and repair gaps,
- show gap ledger health,
- update retention limits.

## Tests

Run all backend tests:

```bash
cd backend
python -m pytest -q
```

Compile check:

```bash
cd backend
python -m compileall app tests -q
```

Focused smoke set:

```bash
cd backend
python -m pytest -q \
  tests/test_klines_api.py \
  tests/test_stream_api.py \
  tests/test_indicator_api.py \
  tests/test_exchanges_api.py \
  tests/test_exchange_plugin_contracts.py \
  tests/test_exchange_registry_plugins.py \
  tests/test_data_engine_phase1_boundaries.py
```

Concurrency benchmark script compile check:

```bash
cd backend
python -m py_compile scripts/bench_concurrency.py app/core/executors.py app/core/runtime_metrics.py
```
