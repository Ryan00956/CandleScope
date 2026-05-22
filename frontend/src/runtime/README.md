# Frontend Runtime Boundaries

`src/runtime` is no longer a business capability layer after Phase 11. Business
state, side effects, and compatibility wrappers that previously lived here have
been folded into their owning `src/features/*` modules.

## Remaining Scope

Only app-wide runtime instrumentation belongs here today:

- `performance/`: boot, lazy-surface, chart, stream, and indicator timing marks
    used across app, feature, and chart-rendering code.

This instrumentation is intentionally cross-cutting and does not own CandleScope
business state. Do not add new feature behavior to `src/runtime`.

## Dependency Rules

Allowed:

- Runtime instrumentation may expose small functions for app-wide performance
    marks and reports.
- Feature and rendering code may import instrumentation while Phase 12 boundary
    checks are still being introduced.

Forbidden:

- Do not add chart-session, market-data, indicator, drawing, settings,
    watchlist, symbol-search, export, or alert logic here.
- Do not add compatibility re-export wrappers that point back to features.
- Do not render JSX or own UI layout.
- Do not import raw Lightweight Charts objects here.
