# CandleScope Frontend Architecture

This document records the current frontend architecture target, the refactor
work already completed, and the remaining optimization path.

For the step-by-step execution plan, see
[Frontend Optimization Execution Plan](OPTIMIZATION_EXECUTION.md).
For the current phase review and recommended next work, see
[Frontend Optimization Phase Review](OPTIMIZATION_PHASE_REVIEW.md).

## Goals

- Keep `src/app/App.jsx` as the composition root instead of the owner of every data,
  stream, preference, and workflow concern.
- Keep business ownership in `src/features/*`, grouped by capability rather
  than by technical layer.
- Keep `src/runtime` free of business ownership; it now only hosts app-wide
  performance instrumentation.
- Make K-line loading, indicator updates, WebSocket streams, gap recovery, and
  user workflows independently understandable and testable by feature.
- Keep local development stable across `localhost` and `127.0.0.1` entrypoints.
- Reduce initial JavaScript cost by lazy-loading panels that are not needed for
  the first chart render.

## Current Ownership Boundaries

After Phase 10, `src/app` owns the composition root and shell. After Phase 11,
business runtimes that previously lived in `src/hooks` and `src/runtime` have
been folded into their owning features.

`src/features` is split by capability:

| Group | Ownership |
|---|---|
| `chart-session/` | Active symbol, exchange, market type, interval, dataset key, custom intervals, exchange capabilities, visible-range storage |
| `market-data/` | K-line cache, initial history load, left pagination, backfill completion, K-line WebSocket, background prefetch, gap recovery, header market display state |
| `indicators/` | Active indicators, compute scheduling, hosted indicator WebSocket, output reducer, pane projection, catalog, and Pyne security policy |
| `drawings/` | Drawing tool state, primitive interaction, selection, snap, persistence, and lazy drawing engine host |
| `watchlist/` | Watchlist folders, sidebar layout, subscription tiers, and watchlist price streams |
| `symbol-search/` | Symbol catalog, favorites, filtering, and modal interaction |
| `settings/` | Chart appearance, proxy settings, exchange refresh, cache limits, maintenance actions, and database tools panel |
| `export/` | Export options, preview, export service, and drawing commit coordination before export |

`src/runtime` only keeps app-wide performance marks; see
[src/runtime/README.md](src/runtime/README.md). Feature boundary rules live in
[src/features/README.md](src/features/README.md).

## Backend Connection

The frontend uses same-origin `/api/v1` by default. In Vite development,
`vite.config.js` proxies `/api` HTTP and WebSocket traffic to
`http://localhost:8000`.

This avoids a class of false frontend failures where `http://127.0.0.1:5173`
loads the page but browser CORS blocks requests to `http://localhost:8000`.

Use `VITE_API_BASE` only for deployments where the backend is not reachable
through the Vite proxy.

## Completed Work

| Area | Status |
|---|---|
| Chart data runtime extraction | Done |
| Initial history load runtime extraction | Done |
| K-line WebSocket runtime extraction | Done |
| Backfill completion runtime extraction | Done |
| Gap recovery runtime extraction | Done |
| Background prefetch runtime extraction | Done |
| Watchlist runtime and storage extraction | Done |
| Drawing, export, settings, price scale, custom interval workflow extraction | Done |
| Runtime folder grouping and ownership docs | Done |
| Vite `/api` proxy and configurable API base | Done |
| Lazy chunks for Settings, Indicators, Alerts, Export panels | Done |
| Lazy chunks for symbol search modal, watchlist sidebar, and drawing toolbar | Done |
| Lazy drawing engine host for active/saved drawing workflows | Done |
| Frontend performance marks and smoke timing report | Done |
| K-line-first loading before indicator/background work | Done |
| Conservative trailing chart-series update paths | Done |
| Intent-based preload for symbol search and Settings | Done |
| Build-time vendor chunks for React, Lightweight Charts, editor, and export libraries | Done |
| Phase 10 app shell and lazy surfaces moved into `src/app` | Done |
| Phase 11 cleanup for `src/hooks` and business `src/runtime` migration entries | Done |

## Validation Baseline

Use these checks after frontend architecture changes:

```bash
cd frontend
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

For rendered smoke validation:

1. Start the backend on `http://localhost:8000`.
2. Start Vite on port `5173`.
3. Run the committed smoke check:

   ```bash
   npm run smoke -- --url http://127.0.0.1:5173/
   ```

   The smoke check confirms the page reaches `Connected to Binance`, non-zero
   `bars`, `Live (WebSocket)`, that the drawing toolbar loads, and that the
   lazy-loaded symbol search and Settings panels open.

On Windows, if backend startup logs fail with a console encoding error, start
the backend with UTF-8 output enabled:

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Remaining Work

- Tighten smoke timing granularity for lazy surfaces; the current browser
  smoke loop is product-safe but has a coarse 500 ms polling floor.
- Continue measured chart rendering work around fills, markers, hlines,
  overlays, and visible-range restoration before attempting broader chart
  component refactors.
- Keep `ChartPane` internal simplification evidence-led. It is still the
  densest chart module, but Lightweight Charts ownership should remain inside
  chart components.
- Consider CI-visible performance budget reporting once local smoke numbers are
  stable enough to compare across machines.
- Continue moving feature UI implementations that still live under
  `src/components` into their owning features when those files are stable enough
  to move without behavior churn.
- Keep top-level README and this architecture document in sync when frontend
  feature boundaries change.
