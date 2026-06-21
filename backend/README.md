# CandleScope Backend

[中文](README_zh.md)

> FastAPI backend for CandleScope. It provides K-line data, realtime WebSocket streams, exchange metadata, indicator computation, custom Pyne scripts, proxy/settings management, subscriptions, and storage repair tools.

## Runtime Stack

- Python FastAPI app: `app/main.py`
- Core async infrastructure: `app/core/executors.py`, `app/core/runtime_metrics.py`
- Market data runtime: `app/data_engine/runtime.py`
- Exchange registry/plugins: `app/exchanges`
- Indicator engine and Pyne runtime: `app/indicator`
- SQLite K-line storage: `app/data_engine/storage`

## Quick Start

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
```

On Windows, `dev-server.ps1` runs the same development server with UTF-8 output
enabled:

```powershell
.\dev-server.ps1
```

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
3. Refresh exchange symbol metadata on a best-effort basis.
4. Start Data Engine through `start_data_engine()`.
5. Attach stable runtime handles to `app.state`.
6. Bridge IndicatorEngine to DataManager events.

Shutdown stops the lag monitor, stops IndicatorEngine, and then shuts down the Data Engine runtime.

## API Overview

All application APIs are mounted under `/api/v1`.

| Area | Endpoints |
|---|---|
| K-lines | `GET /klines/`, `/latest`, `/history`, `/range`, `/history/before`, `/resolve`, `/storage/meta`, `/continuity`, `DELETE /klines/storage` |
| Streams | `WS /stream/klines`, `WS /stream/klines_multi`, `WS /stream/indicators`, `WS /stream/prices` |
| Indicators | `GET /indicators/registry`, presets, custom CRUD, Pyne security, diagnostics, `POST /indicators/compute` |
| Exchanges | `GET /exchanges/`, `GET /exchanges/diagnostics`, `GET /exchanges/{exchange}/capabilities` |
| Symbols | `GET /symbols/exchange-info`, `POST /symbols/exchange-info/refresh` |
| Settings | proxy get/update/test, storage repair, gap scan, storage health, cache limits |
| Subscriptions | list, sync, prices snapshot, get/set/delete symbol tier |

System endpoints outside `/api/v1`:

- `GET /`
- `GET /health`
- `GET /debug/snapshot`

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

- `ExchangeCapabilities` includes `plugin_api_version`, `capability_schema_version`, protocol features, limits, and known limitations.
- `ExchangeRegistry.register()` rejects plugins whose major plugin API version or capability schema is not supported by this backend.
- `GET /api/v1/exchanges/diagnostics` reports load status, protocol class, adapter facade, and policy classes for each plugin.
- `app.exchanges.contracts` provides a reusable contract harness for REST specs, WS specs, payload extraction, historical pagination, and normalizer output schema.
- Built-in contract fixtures live under `tests/fixtures/exchanges/`; add new exchange fixtures there before wiring the plugin into runtime code.
- Optional out-of-tree plugins can be loaded with `CANDLESCOPE_EXCHANGE_PLUGINS=module.path,module.path:factory`. This path is explicit and diagnostics-backed; built-in plugins still load first.
- The frontend consumes `/api/v1/exchanges/` for interval lists, market availability, WS mode, and user-visible limitations. Keep new exchange UI behavior in capabilities rather than hard-coded frontend branches.

## Indicators And Pyne

Indicator docs:

- [app/indicator](app/indicator/)
- [app/indicator/pyne](app/indicator/pyne/)

Built-ins include `MA`, `EMA`, `MACD`, `RSI`, `BOLL`, `ATR`, and `VOL`.

Pyne scripts run through `execute_pyne_script()` with process execution by default. Security modes are `safe`, `research`, and `unsafe`.

The backend imports Pyne through `app.indicator.pyne`, backed by the bundled
`packages/pyne-runtime` package in this repository. The backend loads that
source tree automatically, so a normal backend install is enough:

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
```

Diagnostics expose the selected runtime package under
`/api/v1/indicators/diagnostics -> pyne.runtimeBackend`.

If you want to test a newer external Pyne checkout temporarily, override the
source path for that shell session:

```powershell
$env:CANDLESCOPE_PYNE_RUNTIME_SRC = "<path-to-pyne-runtime>\src"
```

HTTP indicator compute is offloaded through dedicated executors:

- Builtin indicator HTTP compute uses one-shot engine instances so it does not mutate the app-wide realtime `IndicatorEngine`.
- Pyne HTTP and range snapshot paths use the Pyne wait executor around the process-based runtime.
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
