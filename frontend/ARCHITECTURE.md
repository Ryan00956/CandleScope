# CandleScope Frontend Architecture

This document records the current frontend architecture target, the refactor
work already completed, and the remaining optimization path.

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
3. Open either `http://localhost:5173/` or `http://127.0.0.1:5173/`.
4. Confirm the page reaches `Connected to Binance`, non-zero `bars`, and
   `Live (WebSocket)`.
5. Open a lazy panel such as Settings or Indicators and check for console
   errors.

On Windows, if backend startup logs fail with a console encoding error, start
the backend with UTF-8 output enabled:

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Remaining Work

- Add a committed smoke script so the browser checks above are repeatable.
- Analyze the remaining main bundle and split only the next proven heavy path.
- Consider lazy-loading deeper indicator editor or Monaco paths if bundle
  analysis shows they still affect the first render.
- Review drawing primitives separately before lazy-loading them, because chart
  interactions are more sensitive than side panels.
- Keep top-level README and this architecture document in sync when frontend
  runtime boundaries change.
