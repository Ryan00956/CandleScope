# Frontend Runtime Boundaries

`src/runtime` holds app orchestration hooks and pure helpers that sit between
`App.jsx`, UI components, services, and storage. Keep UI rendering in
`components/`; keep HTTP/WebSocket primitives in `services/`.

## Migration Status

`src/runtime` is a migration-period directory. Existing runtime modules remain
valid while the frontend moves from technical layering to feature ownership,
but new long-lived business capability code should be placed under
`src/features/*` when it has a clear owner.

Use this directory for compatibility wrappers or code that has not reached its
planned migration phase yet. When touching a runtime module, prefer reducing
`App.jsx` coordination and moving ownership into the relevant feature boundary
only when that phase is in scope.

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

## Dependency Rules

Allowed:

- Runtime hooks may import React hooks, shared pure helpers, and service clients
    needed to orchestrate current migrated behavior.
- Runtime helpers may import other runtime helpers inside the same ownership
    group when that keeps behavior understandable.
- Runtime code may expose state and callbacks to `App.jsx` or future feature
    runtimes through explicit return values.

Forbidden:

- Runtime modules must not render JSX or own UI layout.
- Runtime modules must not become new cross-feature coordinators that know
    unrelated chart, drawing, settings, indicator, and watchlist details.
- Runtime service or storage helpers must not import React.
- Runtime modules should not introduce new direct Lightweight Charts object
    dependencies; use the future `src/chart-adapter` boundary for that work.
