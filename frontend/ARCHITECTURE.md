# CandleScope Frontend Architecture

This document records the current frontend architecture target, the refactor
work already completed, and the remaining optimization path.

For the step-by-step execution plan, see
[Frontend Optimization Execution Plan](OPTIMIZATION_EXECUTION.md).
For the current phase review and recommended next work, see
[Frontend Optimization Phase Review](OPTIMIZATION_PHASE_REVIEW.md).

## Goals

- Keep `App.jsx` as the composition root instead of the owner of every data,
  stream, preference, and workflow concern.
- Keep rendering components in `src/components`, backend clients in
  `src/services`, and orchestration/runtime hooks in `src/runtime`.
- Make K-line loading, indicator updates, WebSocket streams, gap recovery, and
  user workflows independently understandable and testable.
- Keep local development stable across `localhost` and `127.0.0.1` entrypoints.
- Reduce initial JavaScript cost by lazy-loading panels that are not needed for
  the first chart render.

## Current Runtime Boundaries

`src/runtime` is split by ownership:

| Group | Ownership |
|---|---|
| `chart/` | Chart data cache, visible range restore, initial history load, left pagination, gap recovery, chart display derivations |
| `streams/` | K-line WebSocket runtime and backend backfill completion handling |
| `exchange/` | Exchange capability catalog and interval metadata |
| `preferences/` | Local and backend-backed user preference sync |
| `workflows/` | Export, drawing, custom interval, interval notice, and watchlist workflows |

See [src/runtime/README.md](src/runtime/README.md) for the package-local
ownership rules.

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

## Validation Baseline

Use these checks after frontend architecture changes:

```bash
cd frontend
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
- Keep top-level README and this architecture document in sync when frontend
  runtime boundaries change.
