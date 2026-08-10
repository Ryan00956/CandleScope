# CandleScope

[简体中文](README_zh.md)

Lightweight trading chart software built with FastAPI, React, Vite, and Lightweight Charts. CandleScope supports Binance and OKX market data, spot and perpetual market types, a modular Data Engine, exchange-aware symbol metadata, realtime WebSocket streams, built-in indicators, and Pine-style Python scripting through Pyne.

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-19+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

## Contents

- [Quick Start](#quick-start)
- [What It Does](#what-it-does)
- [Replay Training](#replay-training)
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

- Windows CPython 3.12 (the pinned platform for first-party Pyne/Pine bundles)
- Node.js 20+
- npm 10+

Start the backend:

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

On Windows, you can use the helper script instead:

```powershell
cd backend
.\dev-server.ps1
```

The Windows entrypoint leaves Uvicorn reload disabled because its Selector
event loop cannot launch the Pyne/Pine sidecar subprocesses CandleScope needs.

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

## Replay Training

Replay is a local-first, deterministic v2 market-training product. It opens in
an independent `replay.html` document with its own composition root; the live
page never swaps its market source or owns replay state. Replay and its live-page
entry are part of the normal build and are enabled by default. Missing or
invalid pinned datasets fail the affected operation closed with a visible
capability reason; they do not hide or disable the product. Live aggregate-trade
capture, background workers, automatic GC, and optimized paths remain
independently closed:

```text
REPLAY_ENABLED=1
RAW_AGG_TRADE_ARCHIVE_ENABLED=0
REPLAY_HISTORICAL_BOOK_ENABLED=1
REPLAY_SEGMENT_DOWNLOAD_WORKER_ENABLED=0
REPLAY_SEGMENT_AUTO_GC_ENABLED=0
REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED=0
REPLAY_ACCOUNT_HISTORY_ENABLED=1
```

The frontend has no replay-entry feature flag. The backend capability and
dataset validation remain authoritative, including for direct `replay.html`
access. `REPLAY_ENABLED=0` is an explicit whole-product operational stop, not a
rollout or gray-release mechanism.

Internal adapter fidelity used by v2:

| Source | Data fidelity | Execution fidelity | Boundary |
|---|---|---|---|
| Closed K-lines | `EXACT_BAR_COVERAGE` | `BAR_CONSERVATIVE` | Uses a frozen, contiguous BAR snapshot. Ambiguous intrabar paths use a deterministic adverse policy. |
| Binance USD-M aggregate trades | `EXACT_AGG_TRADE_COVERAGE` | `AGG_TRADE_TAPE` | Requires a checksum-verified, exact archive partition. Fills are tape-volume constrained and strict-cross; they are not queue-exact. |

Both sources use the same deterministic actor, virtual clock,
`paper_linear_v1` broker, ledger, and replay.v1 HTTP/WebSocket protocol. These
are internal execution contracts, not a selectable v1 product. Sessions restart in `PAUSED`, and
the report exposes its actual data/execution fidelity and integrity hashes.

The internal adapter explicitly does **not** claim:

- `RAW_TRADE`: aggregate trades are not renamed or claimed as raw individual fills.
- private exchange queue position, maker priority, or hidden-liquidity fidelity.
- exact exchange-private insurance-fund and ADL candidate state when those
  archives are unavailable. The hedge, maintenance-margin, liquidation,
  insurance-fund, and ADL state machines remain complete and deterministic,
  with approximation disclosed in every affected result.

Phase 8 adds explainable
`CHECKPOINT_JUMP` / `AGGREGATE_SCAN` / `FULL_EVENT_SCAN` / `BLOCKED` planning,
bounded source-page scans, cancellable committed chunks, and a replay-isolated
aggregate-trade Tape/CVD panel. `AGGREGATE_SCAN` still applies every source event
to the deterministic reducer and source-event chain; it only skips redundant
intermediate state materialization and coalesces delivery before an exact reset.
Any active order, position, funding, risk, book, or multi-track dependency uses
`FULL_EVENT_SCAN`. BAR runs report Tape/order flow as
`UNSUPPORTED_SOURCE_MODE`, and aggregate trades are never labeled raw fills.

Phase 9 adds an optional, replay-owned historical L2 archive for Binance USD-M.
It accepts only an operator-captured SQLite snapshot plus ordered diff-depth
stream that passes schema, range, checksum, snapshot bridge, resident-depth,
and `U/u/pu` continuity validation. A `BOOK_ASSISTED_REQUIRED` run pins that
exact object; a gap clears every displayed book, pauses the run, and requires
explicit revalidation/resync. The execution model remains `TOUCH_OR_TAPE_V2`
and reports `BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE`: L2 is an exact
continuity capability, not proof of queue position or maker-fill priority.

`REPLAY_ENABLED` is the only whole-product operational stop. Historical-book
validation is active by default and fails individual BOOK-required operations
closed when no trusted capture is available; optimization remains default-off:

```text
REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED=0
REPLAY_HISTORICAL_BOOK_ENABLED=1
REPLAY_HISTORICAL_BOOK_MAX_ARCHIVE_BYTES=1099511627776
```

No production L2 dataset is bundled or claimed. Before enabling the feature,
an operator must retain the trusted capture outside replay-owned storage and
formally import it. The importer copies the checksum-identical object into the
managed archive and keeps the external path only for verified rehydration:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe scripts\import_replay_historical_book.py `
  --replay-db .\data\replay-dev\replay-v2.db `
  --archive D:\trusted-replay-captures\BTCUSDT-book.sqlite3 `
  --archive-root .\data\replay-dev\replay-historical-books `
  --trusted-origin OPERATOR_VERIFIED_CAPTURE
```

Storage GC remains explicit dry-run/run, never automatically reclaims an
active pin, and rehydrates only when the retained trusted source still matches
the frozen checksum.

Phases 11–18 complete the training-workbench contract: live-page launch
context, server-owned time disclosure, BAR/AGG control semantics, on-demand
multi-symbol data policy, checkpoint-equivalent fast-forward, exact
account-history inputs, read-only review/fork workflows, and bounded storage
governance. The Hub storage panel is lazy-loaded and path-redacted. Segment,
book, and account-history GC are category-specific, require a fresh dry-run
plan hash, protect active pins, and rehydrate only from checksum-identical
trusted sources. Review evidence has no deletion action.

The production contract is `HARD_CUTOVER_DEFAULT_ON`: the replay entry, hedge
account, historical-book validation, and account-history validation are present
in every normal build. A missing BOOK/account capture is reported as a pinned
data capability gap for that requested fidelity, never as a hidden feature or
silent downgrade.

### Prepare Isolated Data

BAR replay uses an independent immutable Parquet history plane by default. It
does not import old candles into, or query, the live K-line SQLite database:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m pip install -r requirements-parquet.txt
.\.venv\Scripts\python.exe scripts\import_binance_replay_history.py `
  --market-type spot `
  --symbol BTCUSDT `
  --interval 1m `
  --start 2017-07-01 `
  --end 2026-07-30 `
  --archive-dir .\data\replay-dev\replay-history
```

The importer verifies Binance checksums, writes content-addressed Parquet
objects, records gaps as separate continuous segments, and atomically publishes
an immutable catalog epoch. Random candidates and `ALL_AVAILABLE` history both
use that archive; an existing Run remains pinned to its original epoch. See
[`docs/KLINE_REPLAY_HISTORY_ARCHIVE_zh.md`](docs/KLINE_REPLAY_HISTORY_ARCHIVE_zh.md)
for the continuity, revision, audit, and rollback contract.

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
$env:REPLAY_DB_PATH = '.\data\replay-dev\replay.db'
$env:REPLAY_HISTORY_ARCHIVE_DIR = '.\data\replay-dev\replay-history'
$env:REPLAY_ENABLED = '1'
# Set to 1 only after an exact AGG_TRADE archive passes the audit above.
$env:RAW_AGG_TRADE_ARCHIVE_ENABLED = '0'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18082

# Terminal 2
Set-Location frontend
$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:18082'
$env:VITE_DEV_PORT = '15175'
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
- Emergency stop is whole-build operational rollback: deploy the previous
  verified build, or explicitly set `REPLAY_ENABLED=0` and restart the backend.
  The frontend entry remains visible and reports the authoritative unavailable
  reason. Keep `replay.db`; stopping or rolling back must not delete training
  records.
- An old build without replay routes ignores the retained `replay.db`. To
  disable only AGG_TRADE, set `RAW_AGG_TRADE_ARCHIVE_ENABLED=0`; BAR replay can
  remain independently available.

Release-quality local checks:

```powershell
Set-Location H:\program\CandleScope-kline-replay
$ReplayHead = (git rev-parse HEAD).Trim()
$ReplayEvidenceRoot = "H:\program\CandleScope-release-evidence\$ReplayHead\replay-v2"
$ReplayNpm = "F:\工具箱\node.js\node-v22.14.0-win-x64\npm.cmd"
New-Item -ItemType Directory -Force $ReplayEvidenceRoot | Out-Null

Set-Location backend
.\.venv\Scripts\python.exe scripts\run_replay_v2_release_checks.py `
  --npm $ReplayNpm `
  --out "$ReplayEvidenceRoot\checks.json"
.\.venv\Scripts\python.exe scripts\benchmark_replay_v2_release.py `
  --out "$ReplayEvidenceRoot\benchmark.json"
.\.venv\Scripts\python.exe scripts\validate_replay_v2_real_sources.py `
  --klines-db .\data\replay-dev\source-candlescope.db `
  --agg-archive-dir "$ReplayEvidenceRoot\official-aggtrade-archive" `
  --agg-day 2026-07-24 `
  --out "$ReplayEvidenceRoot\real-source-validation.json"

Set-Location ..\frontend
& $ReplayNpm run smoke:replay -- --timeout-ms 120000 `
  --out "$ReplayEvidenceRoot\replay-v2-smoke.json"
node scripts\replay-soak.mjs `
  --real-klines-source ..\backend\data\replay-dev\source-candlescope.db `
  --duration-ms 3600000 --cycles 100 --projection-events 1000000 `
  --sample-ms 60000 --timeout-ms 120000 `
  --out "$ReplayEvidenceRoot\replay-v2-soak.json"
node scripts\replay-v2-rollback-drill.mjs `
  --baseline c9a1ddbfe316c68c91787b69c783baeeb0670a9f `
  --timeout-ms 120000 `
  --out "$ReplayEvidenceRoot\replay-v2-rollback.json"

Set-Location ..\backend
.\.venv\Scripts\python.exe scripts\verify_replay_v2_release.py `
  --evidence-dir "$ReplayEvidenceRoot" `
  --out "$ReplayEvidenceRoot\release-manifest.json"
```

Release evidence commands reject a dirty worktree or a changing Git HEAD.
Keep their outputs outside the repository so one completed gate cannot make
the next gate fail the clean-tree check. The final verifier also checks all 40
product-contract scenarios, exact repository defaults, artifact hashes, real
BAR and official aggTrade source provenance, bounded storage inventory, 100
archive lifecycles, keyboard/focus/reduced-motion evidence, and a detached
`git revert --no-commit` drill.

The blocking browser stability gate compresses 100 lifecycle cycles and
1,000,000 projection events into at least 60 minutes. It formally requires
`--real-klines-source` (or `REPLAY_REAL_KLINES_SOURCE`). The historical 4-hour
command is retained only as an optional non-blocking observation. Before the
formal run, `npm run stress:replay:orders` exercises 10 real browser lifecycle
cycles and rejects order-capacity/preview request amplification in minutes;
the same bounded-request contract remains active in the 60-minute gate. After
a tooling-only commit, pass one or more
`--reuse-evidence-dir <prior-head>/replay-v2` arguments to reuse benchmark,
real-source, or rollback artifacts only when their declared runtime inputs have
no Git diff. Checks, smoke, and stability evidence must still come from the
current HEAD. Passing these local gates leaves production on HOLD and does not
replace the required BOOK/account capture, capacity/alerting observation
window, or explicit enablement decision.

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
- [Pyne Workbench v2 plugin](packages/candlescope-plugin-pyne-workbench/README.md)
- [Pine Compatibility plugin](packages/candlescope-plugin-pine-compat/README.md)

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
routing. Phase 8 defaults both Pyne and Pine to the managed
`candlescope.pyne` and `candlescope.pine-compat` sidecars and fails closed when
either required runtime is unavailable.
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

The development-only
[`candlescope-plugin-pyne-workbench`](packages/candlescope-plugin-pyne-workbench/README.md)
is a separate Plugin Platform v2 package. It reads the active chart through
scoped Host calls, brokers exact `request.*` data, owns bounded incremental
sessions, and publishes only validated `candlescope.render/2` items. It does
not change or replace the installed v1 runtime bridge.

The separately evolving general Plugin Platform v2 has completed Phases 1–12.
Above the SDK, business-neutral Host, Bundle/Installer, permissions, and Windows
OS sandbox, the product composition now provides commands/settings/events/jobs,
private storage, scoped market consumers, Host-owned chart layers, declarative
and opaque-origin sandbox UI, controlled HTTPS/file/endpoint gateways, and
paired public symbol/market-data providers, plus Paper and the default-off
WP-A–WP-F Live Broker technical path. Phase 12 adds a default-off Ed25519-signed
Marketplace with immutable artifact/index caches, SBOM/license binding,
transparency, revocation, permission diffs, and explicit
prepare/apply/activate/health-rollback stages.

The repository ships with no Marketplace roots. `verified-publisher` proves
release provenance, not trusted code: community backends still run as
`untrusted` code in Windows AppContainer and Host grants remain independent.
Community Live `trade.submit`/`trade.cancel`, real Demo/real-money testing, and
WP-G remain unavailable. See the
[`Phase 12 execution record`](docs/PLUGIN_PLATFORM_V2_PHASE12_zh.md).

The base Plugin Platform v2 is enabled by default. Set
`CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED=0` only to disable it or perform an
emergency rollback. Marketplace, Paper, and every Live Broker capability remain
independent and default off.

Phase 8 adds the independently buildable
[`candlescope-plugin-pine-compat`](packages/candlescope-plugin-pine-compat/README.md).
It pins the public `pine-compat-runtime` v0.2.0 Release wheel, contains no Pine
engine source snapshot or private CandleScope imports, and advertises only its
closed-bar batch contract. The development bundle is published as
[`candlescope-plugin-pine-compat-v0.2.0-dev.1`](https://github.com/Ryan00956/CandleScope/releases/tag/candlescope-plugin-pine-compat-v0.2.0-dev.1).
Unsupported realtime, strategy, `request.*`, import, and native-object features
remain fail-closed.

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
│   ├── candlescope-plugin-pyne-workbench/
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
