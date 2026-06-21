# CandleScope Frontend

React/Vite charting UI for CandleScope.

## Architecture

- [Frontend Architecture](ARCHITECTURE.md)
- [前端架构](ARCHITECTURE_zh.md)
- [Feature Boundaries](src/features/README.md)
- [Shared Boundaries](src/shared/README.md)
- [Chart Adapter Boundaries](src/chart-adapter/README.md)
- [Runtime Boundaries](src/runtime/README.md)
- [Frontend Cleanup Execution Plan](FRONTEND_CLEANUP_EXECUTION.md)
- [前端清理执行计划](FRONTEND_CLEANUP_EXECUTION_zh.md)
- [前端理想架构执行文档](FRONTEND_ARCHITECTURE_REBUILD_EXECUTION_zh.md)
- [前端架构边界硬化执行文档](FRONTEND_ARCHITECTURE_HARDENING_EXECUTION_zh.md)
- [前端最终收尾执行计划](FRONTEND_FINAL_POLISH_EXECUTION_zh.md)

## Backend Connection

The frontend uses same-origin `/api/v1` by default. During local development,
Vite proxies `/api` HTTP and WebSocket traffic to
`http://127.0.0.1:18080`. The default dev entrypoint is
`http://127.0.0.1:15173`.

Use `VITE_API_BASE` only when the backend is not reachable through the Vite
proxy, for example:

```bash
VITE_API_BASE=http://127.0.0.1:18080/api/v1 npm run dev
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

Optimization execution notes:

- [Architecture](ARCHITECTURE.md)
- [Optimization Execution Plan](OPTIMIZATION_EXECUTION.md)
- [Frontend Cleanup Execution Plan](FRONTEND_CLEANUP_EXECUTION.md)

```bash
node ./scripts/check-architecture.mjs
node ./node_modules/vite/bin/vite.js build
node ./node_modules/eslint/bin/eslint.js .
```

With the backend and Vite running, use the browser smoke check to verify the
rendered chart, drawing toolbar, lazy symbol search, and lazy Settings panel:

```bash
npm run smoke -- --url http://127.0.0.1:15173/
```

On this Windows Codex desktop environment, use the bundled Node executable if `npm` or `node` is not available on `PATH`.
