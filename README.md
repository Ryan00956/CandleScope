# CandleScope

[简体中文](README_zh.md)

Lightweight trading chart software built with FastAPI, React, Vite, and Lightweight Charts. CandleScope supports Binance and OKX market data, spot and perpetual market types, a modular Data Engine, exchange-aware symbol metadata, realtime WebSocket streams, built-in indicators, and Pine-style Python scripting through Pyne.

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-19+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

## Contents

- [Quick Start](#quick-start)
- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [Backend](#backend)
- [Frontend](#frontend)
- [Indicators And Pyne](#indicators-and-pyne)
- [API Documentation](#api-documentation)
- [Project Structure](#project-structure)
- [Development Checks](#development-checks)
- [Notes](#notes)
- [Acknowledgments](#acknowledgments)

## Quick Start

Requirements:

- Python 3.10+
- Node.js 20+
- npm 10+

Start the backend:

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

Start the frontend:

```bash
cd frontend
npm install
npm run dev
```

In local development the frontend uses same-origin `/api/v1`; Vite proxies
HTTP and WebSocket traffic to `http://localhost:8000`. Both
`http://localhost:5173` and `http://127.0.0.1:5173` are valid dev entrypoints.

Default URLs:

| Service | URL |
|---|---|
| Frontend | `http://localhost:5173` |
| Backend | `http://localhost:8000` |
| Swagger / OpenAPI | `http://localhost:8000/docs` |
| Health | `http://localhost:8000/health` |

On Linux/WSL, create a virtual environment first if desired:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

## What It Does

CandleScope is a local-first market charting application with:

- Exchange-aware K-line data for Binance and OKX.
- Spot and derivative market support through `exchange` and `market_type` scoped series.
- Cache-first historical queries backed by SQLite.
- Realtime K-line WebSocket streams with single-interval and multi-interval modes.
- Demand-aware historical backfill scheduling: current chart history first,
  related intervals next, subscriptions and background audits later.
- Watchlists, price-only subscriptions, realtime price snapshots, and price streams.
- Built-in indicators: `MA`, `EMA`, `MACD`, `RSI`, `BOLL`, `ATR`, and `VOL`.
- Pyne, a Pine-style Python runtime for custom indicators.
- Interactive chart tools: line variants, freehand drawing, text annotations, Fibonacci retracement, and long/short position tools.
- Multi-pane chart layout for price, volume, and oscillator indicators.
- Settings tools for proxy testing, symbol metadata refresh, storage repair, gap scanning, and retention limits.

## Architecture

Current backend data flow:

```text
Exchange WS / REST
        |
        v
ingestion
        | MarketEvent / GapMarker
        v
bar_aggregator
        | BarEvent
        v
data_manager
        | QueryResult / DataEvent / PriceSnapshot
        v
API / WebSocket / Indicator / Subscription / Settings
```

Historical repair flow:

```text
QueryEngine / Settings / Ingestion GapMarker
        |
        v
BackfillCoordinator
        | priority / chunk scheduler
        v
BackfillEngine
        |
        v
storage readback
        |
        v
DataManager cache + EventBus
```

The formal backend path is centered on `DataManager` and `DataEngineRuntime`. Older `data_engine/collectors` and `data_engine/services` directories may still exist in the tree, but they are not the primary architecture documented for new work.

## Backend

The backend is a FastAPI app in [backend/app/main.py](backend/app/main.py). Startup does the following:

1. Initializes SQLite K-line storage.
2. Refreshes exchange metadata on a best-effort basis.
3. Starts `DataEngineRuntime`.
4. Attaches `app.state.data_engine_runtime` and `app.state.data_manager`.
5. Bridges `IndicatorEngine` to DataManager events.

Main backend documentation:

- [Backend README](backend/README.md)
- [Data Engine](backend/app/data_engine/README.md)
- [Data Engine 中文](backend/app/data_engine/README_zh.md)
- [Exchange plugin template](backend/app/exchanges/plugins/_template/README.md)

Core backend modules:

| Module | Purpose |
|---|---|
| `app/api/v1` | HTTP and WebSocket API routers |
| `app/core` | Runtime config, paths, proxy persistence, market helpers |
| `app/exchanges` | Exchange registry, adapters, plugins, symbol normalization |
| `app/data_engine/runtime.py` | Data Engine composition root |
| `app/data_engine/ingestion` | Realtime exchange intake and normalization |
| `app/data_engine/bar_aggregator` | K-line bucket/merge/finalization/event lifecycle |
| `app/data_engine/data_manager` | Public data facade for query/cache/events/streams/backfill/prices/maintenance |
| `app/data_engine/backfill` | Historical detect/plan/fetch/reconcile/report pipeline behind the scheduler |
| `app/data_engine/storage` | SQLite K-line repository and gap ledger |
| `app/indicator` | Built-in indicators, Pyne runtime, indicator streaming |

## Frontend

The frontend is a React + Vite app using Lightweight Charts v5.

Frontend architecture notes:

- [Frontend Architecture](frontend/ARCHITECTURE.md)
- [Runtime Boundaries](frontend/src/runtime/README.md)

Important frontend pieces:

| Path | Purpose |
|---|---|
| `frontend/src/App.jsx` | Composition root for runtime hooks and UI surfaces |
| `frontend/src/components/MultiPaneChart.jsx` | Multi-pane chart layout |
| `frontend/src/components/ChartWidget.jsx` | Lightweight Charts wrapper |
| `frontend/src/components/DrawingToolbar.jsx` | Drawing tool controls |
| `frontend/src/components/IndicatorPanel.jsx` | Lazy-loaded indicator browsing/configuration |
| `frontend/src/components/IndicatorEditor.jsx` | Pyne/custom indicator editor, loaded through indicator workflows |
| `frontend/src/components/SymbolSearch*.jsx` | Exchange-aware symbol search |
| `frontend/src/components/WatchlistSidebar.jsx` | Watchlists and price tracking |
| `frontend/src/components/SettingsModal.jsx` | Lazy-loaded proxy, data, chart, and maintenance settings |
| `frontend/src/runtime` | Runtime orchestration grouped by chart, streams, exchange, preferences, and workflows |
| `frontend/src/services/apiConfig.js` | API base and HTTP-to-WebSocket URL configuration |
| `frontend/src/services/api.js` | Main backend API client |
| `frontend/src/services/indicatorApi.js` | Indicator API client |
| `frontend/src/hooks/useIndicators.js` | Indicator HTTP/WS integration |
| `frontend/src/hooks/useDrawing.js` | Drawing state |

Frontend commands:

```bash
cd frontend
npm run dev
npm run build
npm run lint
npm run smoke -- --url http://127.0.0.1:5173/
```

## Indicators And Pyne

The indicator system has two execution paths:

- Built-in incremental indicators managed by `IndicatorEngine`.
- Pyne scripts executed through the backend script runtime.

Built-ins:

| Indicator | Output | Pane |
|---|---|---|
| `MA` | `ma` | main |
| `EMA` | `ema` | main |
| `MACD` | `dif`, `dea`, `hist` | separate |
| `RSI` | `rsi` | separate |
| `BOLL` | `middle`, `upper`, `lower` | main |
| `ATR` | `atr` | separate |
| `VOL` | `volume` | volume |

Pyne exposes Pine-style APIs such as:

```python
length = input.int(20, "Period", minval=1)
upper, mid, lower = ta.bb(close, length, 2.0)

p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Middle", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.08)")
```

Pyne supports `safe`, `research`, and `unsafe` security modes. Process execution is the default so the backend can enforce timeouts more reliably than inline execution.

Documentation:

- [Indicator Engine](backend/app/indicator/README.md)
- [Pyne Runtime](backend/app/indicator/pyne/README.md)

## API Documentation

The API reference is maintained separately:

- [API Reference](API.md)
- [API 文档](API_zh.md)

Important endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/klines/` | `GET` | Latest K-line data |
| `/api/v1/klines/history` | `GET` | Historical lookback window |
| `/api/v1/klines/range` | `GET` | Exact range query with continuity verification |
| `/api/v1/klines/history/before` | `GET` | Left-scroll pagination |
| `/api/v1/stream/klines` | WebSocket | Single-interval K-line stream |
| `/api/v1/stream/klines_multi` | WebSocket | Multi-interval K-line stream |
| `/api/v1/stream/prices` | WebSocket | Realtime price stream |
| `/api/v1/stream/indicators` | WebSocket | Realtime indicator stream |
| `/api/v1/indicators/compute` | `POST` | Built-in or Pyne script indicator compute |
| `/api/v1/subscriptions/` | `GET` | List subscriptions |
| `/api/v1/settings/storage/health` | `GET` | Gap/backfill health |
| `/api/v1/exchanges/` | `GET` | Exchange capabilities |
| `/api/v1/symbols/exchange-info` | `GET` | Symbol metadata search |

## Project Structure

```text
CandleScope/
├── README.md / README_zh.md
├── API.md / API_zh.md
├── backend/
│   ├── README.md / README_zh.md
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py
│   │   ├── api/v1/
│   │   ├── core/
│   │   ├── exchanges/
│   │   │   └── plugins/
│   │   ├── data_engine/
│   │   │   ├── runtime.py
│   │   │   ├── interval_policy.py
│   │   │   ├── ingestion/
│   │   │   ├── bar_aggregator/
│   │   │   ├── data_manager/
│   │   │   ├── backfill/
│   │   │   └── storage/
│   │   └── indicator/
│   │       ├── indicators/
│   │       └── pyne/
│   └── tests/
└── frontend/
    ├── package.json
    └── src/
        ├── components/
        ├── hooks/
        ├── services/
        ├── editor/
        └── utils/
```

## Development Checks

Backend:

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

Frontend:

```bash
cd frontend
npm run build
npm run lint
```

For rendered frontend smoke checks, start the backend and Vite, then run
`npm run smoke -- --url http://127.0.0.1:5173/`. The smoke check confirms the
status bar reaches `Connected to Binance`, shows non-zero `bars`, reports
`Live (WebSocket)`, and opens the lazy-loaded Settings panel.

## Notes

- Configure proxy settings in the app settings panel or through `/api/v1/settings/proxy` if your exchange access requires a proxy.
- Runtime proxy settings are persisted under `backend/data/proxy_settings.json` by default.
- On Windows, if backend startup fails while printing status symbols, start it with `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`.
- SQLite data is local and ignored by git.
- Pyne scripts execute locally in the backend process/process pool according to the configured security mode. Only use `unsafe` for scripts you trust.
- This repository is licensed under GNU GPL-3.0. See [LICENSE](LICENSE).

## Acknowledgments

This project uses several open-source libraries, including:

- [Lightweight Charts](https://github.com/tradingview/lightweight-charts) by TradingView, licensed under Apache-2.0.
- [FastAPI](https://fastapi.tiangolo.com/)
- [React](https://react.dev/)
- [Vite](https://vite.dev/)
