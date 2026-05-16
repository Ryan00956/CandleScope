# CandleScope Backend

[中文](README_zh.md)

> FastAPI backend for CandleScope. It provides K-line data, realtime WebSocket streams, exchange metadata, indicator computation, custom Pyne scripts, proxy/settings management, subscriptions, and storage repair tools.

## Runtime Stack

- Python FastAPI app: `app/main.py`
- Market data runtime: `app/data_engine/runtime.py`
- Exchange registry/plugins: `app/exchanges`
- Indicator engine and Pyne runtime: `app/indicator`
- SQLite K-line storage: `app/data_engine/storage`

## Quick Start

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

Default API base:

```text
http://localhost:8000
```

Interactive docs:

```text
http://localhost:8000/docs
```

Health checks:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/debug/snapshot
```

## Startup Sequence

`app/main.py` performs:

1. Initialize SQLite K-line storage.
2. Refresh exchange symbol metadata on a best-effort basis.
3. Start Data Engine through `start_data_engine()`.
4. Attach stable runtime handles to `app.state`.
5. Bridge IndicatorEngine to DataManager events.

Shutdown stops IndicatorEngine and then shuts down the Data Engine runtime.

## API Overview

All application APIs are mounted under `/api/v1`.

| Area | Endpoints |
|---|---|
| K-lines | `GET /klines/`, `/latest`, `/history`, `/range`, `/history/before`, `/resolve`, `/storage/meta`, `/continuity`, `DELETE /klines/storage` |
| Streams | `WS /stream/klines`, `WS /stream/klines_multi`, `WS /stream/indicators`, `WS /stream/prices` |
| Indicators | `GET /indicators/registry`, presets, custom CRUD, Pyne security, diagnostics, `POST /indicators/compute` |
| Exchanges | `GET /exchanges/`, `GET /exchanges/{exchange}/capabilities` |
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

## Exchange Plugins

Built-in exchanges are registered through `app.exchanges.registry`:

- Binance
- OKX

Plugin template:

- [app/exchanges/plugins/_template](app/exchanges/plugins/_template/)

Exchange adapters expose capabilities, symbol normalization, REST/WS endpoint policy, subscription specs, realtime policy, rate limits, and payload extraction.

## Indicators And Pyne

Indicator docs:

- [app/indicator](app/indicator/)
- [app/indicator/pyne](app/indicator/pyne/)

Built-ins include `MA`, `EMA`, `MACD`, `RSI`, `BOLL`, `ATR`, and `VOL`.

Pyne scripts run through `execute_pyne_script()` with process execution by default. Security modes are `safe`, `research`, and `unsafe`.

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
  tests/test_exchange_registry_plugins.py \
  tests/test_data_engine_phase1_boundaries.py
```
