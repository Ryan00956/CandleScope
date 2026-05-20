# CandleScope Frontend

React/Vite charting UI for CandleScope.

## Architecture

- [Frontend Architecture](ARCHITECTURE.md)
- [前端架构](ARCHITECTURE_zh.md)
- [Runtime Boundaries](src/runtime/README.md)

## Backend Connection

The frontend uses same-origin `/api/v1` by default. During local development,
Vite proxies `/api` HTTP and WebSocket traffic to `http://localhost:8000`, so
both `http://localhost:5173` and `http://127.0.0.1:5173` work without browser
CORS differences.

Use `VITE_API_BASE` only when the backend is not reachable through the Vite
proxy, for example:

```bash
VITE_API_BASE=http://localhost:8000/api/v1 npm run dev
```

## Exchange Capabilities

The app loads `GET /api/v1/exchanges/` on startup and builds an exchange catalog from backend capabilities.

Frontend exchange behavior should prefer backend metadata:

- `native_intervals` drives the interval selector.
- `markets` drives available spot/futures choices where the UI exposes market filters.
- `ws_connection_model` and `protocol_features` decide whether live WS intervals are subscribed.
- `known_limitations` are surfaced in the status bar so exchange-specific gaps are visible to users.

The local `EXCHANGE_INTERVALS` table in `src/App.jsx` is a fallback only. New exchange support should be added in the backend plugin first, then exposed through `ExchangeCapabilities`.

## Checks

```bash
node ./node_modules/vite/bin/vite.js build
node ./node_modules/eslint/bin/eslint.js .
```

On this Windows Codex desktop environment, use the bundled Node executable if `npm` or `node` is not available on `PATH`.
