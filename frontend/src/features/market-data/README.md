# Market Data Feature

`market-data` owns the active K-line lifecycle for the current chart session:
initial history loading, in-memory chart data cache, left-side pagination,
backend backfill completion, live K-line WebSocket updates, background interval
warming, gap recovery, and header price state.

## Public Contract

`useMarketDataRuntime` exposes:

```js
{
  view: { bars, renderBars, meta, loading, error, lastPrice, dataSource, wsStatus },
  actions: { retry, loadMoreLeft, onVisibleRangeChange },
  events: { onBackfillCompleted },
  status: { hasMoreLeft, loadingMoreLeft, activeChartReady },
}
```

The feature owns the low-level chart data, initial load, pagination, stream,
backfill, prefetch, and gap recovery helpers directly. `App.jsx` should depend
on this feature contract rather than calling those implementation hooks.

## Allowed Dependencies

- May consume the chart session view/actions/refs passed by the app composition
  root.
- May use internal chart data and stream helpers from this feature directory.
- May call backend K-line services through existing runtime hooks.
- May notify indicator range loading through a callback passed from the app
  composition root while indicator ownership remains in a later phase.

## Forbidden Dependencies

- Do not own symbol, exchange, market type, interval selection, or user session
  preference persistence; those belong to `features/chart-session`.
- Do not compute or mutate indicators directly.
- Do not own drawing, export, watchlist, settings, or alert UI state.
- Do not expose raw Lightweight Charts objects in the public contract.