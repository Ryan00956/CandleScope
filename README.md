# CandleScope

[简体中文](README_zh.md)

Lightweight trading chart software built with FastAPI, React, Vite, and Lightweight Charts. CandleScope supports Binance and OKX market data, spot and perpetual market types, a modular Data Engine, exchange-aware symbol metadata, realtime WebSocket streams, built-in indicators, and Pine-style Python scripting through Pyne.

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11+-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-19+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

## Contents

- [Quick Start](#quick-start)
- [What It Does](#what-it-does)
- [Replay Training (Opt-In)](#replay-training-opt-in)
- [Architecture](#architecture)
- [Backend](#backend)
- [Frontend](#frontend)
- [Indicators And Pyne](#indicators-and-pyne)
- [Plugin SDK (Developer Preview)](#plugin-sdk-developer-preview)
- [API Documentation](#api-documentation)
- [Project Structure](#project-structure)
- [Development Checks](#development-checks)
- [Notes](#notes)
- [Acknowledgments](#acknowledgments)

## Quick Start

Requirements:

- Python 3.11+
- Node.js 20+
- npm 10+

Start the backend:

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
```

On Windows, you can use the helper script instead:

```powershell
cd backend
.\dev-server.ps1
```

Start the frontend:

```bash
cd frontend
npm install
npm run dev
```

In local development the frontend uses same-origin `/api/v1`; Vite proxies
HTTP and WebSocket traffic to `http://127.0.0.1:18080` by default. Vite serves
the app at `http://127.0.0.1:15173`.

Default URLs:

| Service | URL |
|---|---|
| Frontend | `http://127.0.0.1:15173` |
| Backend | `http://127.0.0.1:18080` |
| Swagger / OpenAPI | `http://127.0.0.1:18080/docs` |
| Health | `http://127.0.0.1:18080/health` |

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
- Watchlists with `none` / price-only / full subscription tiers, realtime price
  snapshots, and full-tier background K-line warm caches.
- Built-in indicators: `MA`, `EMA`, `MACD`, `RSI`, `BOLL`, `ATR`, and `VOL`.
- Pyne, a Pine-style Python runtime for custom indicators.
- Interactive chart tools: line variants, freehand drawing, text annotations, Fibonacci retracement, and long/short position tools.
- Multi-pane chart layout for price, volume, and oscillator indicators.
- Settings tools for proxy testing, symbol metadata refresh, storage repair, gap scanning, and retention limits.

## Replay Training (Opt-In)

Replay v1 is a local-first, deterministic market-training runtime. It opens in
an independent `replay.html` document with its own composition root; the live
page never swaps its market source or owns replay state. Replay is disabled by
default on both sides:

```text
REPLAY_ENABLED=0
VITE_REPLAY_ENTRY_ENABLED=0
```

The frontend flag only hides or shows the live-page entry. The backend
capability is authoritative, including for direct `replay.html` access.

Supported v1 fidelity:

| Source | Data fidelity | Execution fidelity | Boundary |
|---|---|---|---|
| Closed K-lines | `EXACT_BAR_COVERAGE` | `BAR_CONSERVATIVE` | Uses a frozen, contiguous BAR snapshot. Ambiguous intrabar paths use a deterministic adverse policy. |
| Binance USD-M aggregate trades | `EXACT_AGG_TRADE_COVERAGE` | `AGG_TRADE_TAPE` | Requires a checksum-verified, exact archive partition. Fills are tape-volume constrained and strict-cross; they are not queue-exact. |

Both sources use the same deterministic actor, virtual clock,
`paper_linear_v1` broker, ledger, replay.v1 HTTP/WebSocket protocol, blind
timeline, report, and independent replay UI. Sessions restart in `PAUSED`, and
the report exposes its actual data/execution fidelity and integrity hashes.

Replay v1 explicitly does **not** support:

- `RAW_TRADE`: aggregate trades are not renamed or claimed as raw individual fills.
- `L2_BOOK`: no historical order-book queue position or book-assisted fill fidelity.
- `EXCHANGE_FUTURES_EXACT`: no historical funding, maintenance-margin tiers, liquidation/ADL, or exact exchange account semantics.

### Prepare Isolated Data

Never point replay at a K-line database or raw archive that another worktree is
actively writing. Create an SQLite-consistent BAR snapshot first:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe scripts\snapshot_replay_klines.py `
  --source .\data\candlescope.db `
  --destination .\data\replay-dev\source-candlescope.db `
  --require-quick-check
```

AGG_TRADE is optional. Its importer accepts only the official Binance USD-M
daily archive, verifies the published SHA-256 before parsing, and quarantines
identity/schema/checksum conflicts. The end date is inclusive:

```powershell
.\.venv\Scripts\python.exe scripts\import_binance_public_agg_trades.py `
  --exchange binance `
  --market-type futures `
  --symbol BTCUSDT `
  --start 2026-06-01 `
  --end 2026-06-02 `
  --archive-dir .\data\replay-dev\raw_agg_trades `
  --require-checksum

.\.venv\Scripts\python.exe scripts\audit_replay_trade_archive.py `
  --exchange binance `
  --market-type futures `
  --symbol BTCUSDT `
  --start 2026-06-01 `
  --end 2026-06-02 `
  --archive-dir .\data\replay-dev\raw_agg_trades `
  --require-exact
```

Real archives and local replay databases are runtime data and must not be
committed to Git.

### Run a Dedicated Replay Development Pair

The example files are [`backend/.env.replay.example`](backend/.env.replay.example)
and [`frontend/.env.replay.example`](frontend/.env.replay.example). A dedicated
pair avoids the normal `18080` / `15173` services:

```powershell
# Terminal 1
Set-Location backend
$env:CANDLE_DATA_DIR = '.\data\replay-dev'
$env:KLINES_DB_PATH = '.\data\replay-dev\source-candlescope.db'
$env:REPLAY_DB_PATH = '.\data\replay-dev\replay.db'
$env:REPLAY_ENABLED = '1'
# Set to 1 only after an exact AGG_TRADE archive passes the audit above.
$env:RAW_AGG_TRADE_ARCHIVE_ENABLED = '0'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18082

# Terminal 2
Set-Location frontend
$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:18082'
$env:VITE_DEV_PORT = '15175'
$env:VITE_REPLAY_ENTRY_ENABLED = '1'
npm run dev
```

Open `http://127.0.0.1:15175/`; the replay entry opens a new page with
`noopener`. A direct replay URL remains fail-closed if the backend capability
is disabled or its dataset/persistence checks fail.

### Recovery, Disable, and Verification

- Graceful backend shutdown pauses and checkpoints an active session before
  closing replay storage. Restart recovery never resumes wall-clock autoplay.
- Controller loss pauses playback. Sequence/epoch gaps resynchronize through
  an atomic snapshot; dataset, checkpoint, or persistence faults fail closed.
- To disable replay, set `REPLAY_ENABLED=0`, restart the backend, set
  `VITE_REPLAY_ENTRY_ENABLED=0`, and restart/rebuild the frontend. Keep
  `replay.db`; disabling or rolling back must not delete training records.
- An old build without replay routes ignores the retained `replay.db`. To
  disable only AGG_TRADE, set `RAW_AGG_TRADE_ARCHIVE_ENABLED=0`; BAR replay can
  remain independently available.

Release-quality local checks:

```powershell
Set-Location H:\program\CandleScope-kline-replay
$ReplayHead = (git rev-parse HEAD).Trim()
$ReplayEvidenceRoot = "H:\program\CandleScope-release-evidence\$ReplayHead"
New-Item -ItemType Directory -Force $ReplayEvidenceRoot | Out-Null

Set-Location backend
.\.venv\Scripts\python.exe scripts\audit_replay_determinism.py `
  > "$ReplayEvidenceRoot\replay-determinism.json"
.\.venv\Scripts\python.exe scripts\benchmark_replay.py `
  --bars 43200 --trades 1000000 --trade-page-rows 50000 `
  --checkpoint-event-interval 10000 `
  --baseline ..\docs\perf-baselines\replay-v1-backend-20260718.json `
  > "$ReplayEvidenceRoot\replay-backend-1m.json"

Set-Location ..\frontend
npm run smoke:replay -- --timeout-ms 120000 `
  > "$ReplayEvidenceRoot\replay-smoke.json"
node scripts\replay-soak.mjs `
  --duration-ms 14400000 --cycles 100 --projection-events 1000000 `
  --sample-ms 60000 --timeout-ms 120000 `
  --out "$ReplayEvidenceRoot\replay-browser-soak.json"
node scripts\replay-rollback-drill.mjs `
  --baseline c9a1ddbfe316c68c91787b69c783baeeb0670a9f `
  --timeout-ms 120000 `
  --out "$ReplayEvidenceRoot\replay-rollback.json"
```

Release evidence commands reject a dirty worktree or a changing Git HEAD.
Keep their outputs outside the repository so one completed gate cannot make
the next gate fail the clean-tree check. The 4-hour soak is a real release
gate, not a short harness mode. Passing these local gates does not by itself
authorize default enablement or replace a production observation window.

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
| `app/replay` | Deterministic replay actor, sources, paper broker, persistence, and reports |
| `app/indicator` | Built-in indicators, sidecar runtime routing, indicator streaming |

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
npm run smoke -- --url http://127.0.0.1:15173/
npm run smoke:chart-types
npm run smoke:export
npm run smoke:release
```

`smoke:chart-types` switches through and reload-restores all 15 main chart
types. `smoke:export` validates PNG/JPEG/WebP, all three capture scopes,
drawing visibility, watermarking, and real downloaded files. `smoke:release`
runs both matrices with drawing and indicator coverage.

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

Pyne supports `safe`, `research`, and `unsafe` security modes. It runs in an
isolated plugin environment supervised through the public sidecar protocol.

Documentation:

- [Indicator Engine](backend/app/indicator/README.md)
- [Pyne Runtime plugin](packages/candlescope-plugin-pyne/README.md)

## Plugin SDK (Developer Preview)

Community runtime authors can build against the dependency-free
[`candlescope-plugin-sdk`](packages/candlescope-plugin-sdk/README.md). It
defines the versioned `candlescope.script-runtime/1` JSON-RPC sidecar contract,
feature negotiation, typed batch OHLCV input, diagnostics, and the first
CandleScope-owned line-series Render IR. A runnable Hello Runtime and a frozen
wire transcript are included.

Plugin platform Phases 2 and 3 now include the generic
[`app.plugin_runtime`](backend/app/plugin_runtime/README.md) Host/Supervisor.
It launches and supervises explicitly activated sidecars with strict
handshake, timeout, message-limit, restart-circuit, and health behavior. Phase
3 also provides deterministic `.cspkg` bundles, caller-pinned SHA-256, one
isolated venv per bundle, offline wheel install, result probes, atomic
activation, and per-runtime rollback; see the
[`installer guide`](backend/app/plugin_runtime/INSTALLER.md). Phase 4 routes
Indicator HTTP, range, batch, and WebSocket execution through explicit runtime
routing. Phase 6 defaults Pyne to the managed `candlescope.pyne` sidecar and
fails closed when it is unavailable.
Phase 7 adds descriptor-driven language discovery at
`GET /api/v1/indicators/runtimes`; the editor accepts arbitrary routed
community language IDs and uses a plaintext fallback without loading
plugin-provided frontend code. Phase 5 adds the independently buildable
[`candlescope-plugin-pyne`](packages/candlescope-plugin-pyne/README.md), with a
release lock for the SDK, Pyne Runtime RC wheel, and NumPy version, plus a real
offline `.cspkg` installation and protocol probe gate. The 0.2.0 bridge covers
markers, horizontal lines, fills, and other output through negotiated structured
Render IR and passes the frozen goldens. The trusted development asset is now
published as
[`candlescope-plugin-pyne-v0.2.0-dev.1`](https://github.com/Ryan00956/CandleScope/releases/tag/candlescope-plugin-pyne-v0.2.0-dev.1).
The product bootstrap pins its URL, size, platform, and outer SHA-256, while the
generic community installer remains local-artifact-only. CandleScope no longer
contains `packages/pyne-runtime` or an in-process Pyne facade.

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
| `/api/v1/subscriptions/` | `GET` | List watchlist subscription tiers and full intervals |
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
│   │   ├── indicator/
│   │   │   ├── indicators/
│   │   │   └── pyne/
│   │   └── plugin_runtime/
│   └── tests/
├── packages/
│   ├── candlescope-plugin-pyne/
│   ├── candlescope-plugin-sdk/
│   └── pyne-runtime/
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
`npm run smoke -- --url http://127.0.0.1:15173/`. The smoke check confirms the
status bar reaches `Connected to Binance`, shows non-zero `bars`, reports
`Live (WebSocket)`, loads the drawing toolbar, and opens the lazy-loaded symbol
search and Settings panels.
Changes to main chart types or export behavior should also run
`npm run smoke:release`. Use `npm run perf:soak:1h` and
`npm run perf:soak:4h` for long-running stability captures; reports are written
under `docs/perf-baselines/`.

## Notes

- Configure proxy settings in the app settings panel or through `/api/v1/settings/proxy` if your exchange access requires a proxy.
- Runtime proxy settings are persisted under `backend/data/proxy_settings.json` by default.
- On Windows, if backend startup fails while printing status symbols, start it with `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`.
- SQLite data is local and ignored by git.
- Pyne scripts execute locally in an isolated sidecar according to the configured security mode. Only use `unsafe` for scripts you trust.
- This repository is licensed under GNU GPL-3.0. See [LICENSE](LICENSE).

## Acknowledgments

This project uses several open-source libraries, including:

- [Lightweight Charts](https://github.com/tradingview/lightweight-charts) by TradingView, licensed under Apache-2.0.
- [FastAPI](https://fastapi.tiangolo.com/)
- [React](https://react.dev/)
- [Vite](https://vite.dev/)
