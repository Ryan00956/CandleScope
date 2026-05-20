# Frontend Runtime Boundaries

`src/runtime` holds app orchestration hooks and pure helpers that sit between
`App.jsx`, UI components, services, and storage. Keep UI rendering in
`components/`; keep HTTP/WebSocket primitives in `services/`.

## Groups

- `chart/`: chart data caches, visible range helpers, initial history loading,
  pagination, gap recovery, and chart display derivations.
- `streams/`: live K-line streams and backend backfill completion handling.
- `exchange/`: exchange capability catalog loading and interval metadata.
- `preferences/`: local or backend-backed user preference sync.
- `workflows/`: user workflows that coordinate UI actions with runtime state,
  such as export, drawing, custom intervals, interval notices, and watchlists.

When adding runtime code, choose the group by ownership rather than by the UI
that triggers it. If a module starts mixing API calls, chart cache mutation, and
panel state, split it before wiring it into `App.jsx`.
