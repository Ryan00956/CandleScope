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
  actions: { retry, loadMoreLeft, onVisibleRangeChange, consumeIndicatorRangeRequest },
  status: { hasMoreLeft, loadingMoreLeft, activeChartReady, indicatorRangeRequests },
}
```

The feature owns the low-level chart data, initial load, pagination, stream,
backfill, prefetch, and gap recovery helpers directly. `App.jsx` should depend
on this feature contract rather than calling those implementation hooks.

## Allowed Dependencies

- May consume the chart session view/actions/refs passed by the app composition
  root.
- May consume chart session transition events and reset its own K-line cache,
  loading, error, visible-data, and gap-recovery state for the active session.
- May use internal chart data and stream helpers from this feature directory.
- May call backend K-line services through existing runtime hooks.
- May publish indicator range request events after K-line history expands or is
  repaired; indicators own the actual range request side effects.

## Forbidden Dependencies

- Do not own symbol, exchange, market type, interval selection, or user session
  preference persistence; those belong to `features/chart-session`.
- Do not compute or mutate indicators directly.
- Do not expose K-line reset setters back to chart-session or `App.jsx`.
- Do not own drawing, export, watchlist, settings, or alert UI state.
- Do not expose raw Lightweight Charts objects in the public contract.
