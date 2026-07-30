# Market Data Feature

`market-data` owns the active K-line lifecycle for the current chart session:
initial history loading, bounded window stores, left-side pagination, backend
backfill completion, live K-line WebSocket updates, background interval warming,
and header price state.

## Public Contract

`useMarketDataRuntime` exposes:

```js
{
  view: { bars, seriesStore, meta, loading, error, lastPrice, dataSource, wsStatus },
  actions: { retry, loadMoreLeft, onVisibleRangeChange, consumeIndicatorRangeRequest },
  status: { hasMoreLeft, loadingMoreLeft, activeChartReady, indicatorRangeRequests },
}
```

The canonical chart data path is:

```text
REST/WS -> SeriesDataFeed -> SeriesWindowStore delta -> chart adapter renderer
```

`SeriesDataFeed` is the only market-data path that should fetch K-line REST
history. `SeriesWindowStore` owns the active bounded window and emits structural
deltas (`replace`, `prepend`, `append`, `mid-merge`, `tick`). React `bars` stays
as a compatibility/read-model field; renderers should prefer `seriesStore` and
delta subscriptions for hot paths.

Session switches are optimistic: old bars may remain rendered while `meta.status`
is `loading`; the first warm-cache or REST result swaps the active store, while a
slow empty load may clear after the configured timeout.

The app composition root owns one `ForegroundPreloadGate` and shares it with
the active chart and the watchlist full-cache preloader. Physical
`SeriesDataFeed` history/before/range/latest requests are foreground by default;
speculative callers must opt in with `priority: "preload"` and hold a preload
lease. Foreground requests and longer-lived chart busy owners synchronously
abort speculative work, then require a complete quiet dwell before one globally
serialized preload may resume. The watchlist full-cache transport remains the
only direct K-line REST exception, and it participates in the same shared gate.

Cold activation is split into two contracts. The visible `viewport` request
asks for at most 500 bars (or the smaller derived-interval source budget) and
waits at most 1.5 seconds. Once that range is settled, an
`active_hydration` lane probes the full target of up to 1,500 bars with no
backend long-poll. It outranks ordinary preload but remains synchronously
preemptible by foreground work. Partial probes use snapshot mode and publish
nothing; only a complete, contiguous, final response performs one atomic
prepend so chart rows, indicator input, and validation metadata share the same
revision. A bounded 30-second probe round resumes with capped backoff until the
active session is complete or changes.

## Allowed Dependencies

- May consume the chart session view/actions/refs passed by the app composition
  root.
- May consume chart session transition events and reset its own K-line loading,
  error, and visible-data state for the active session.
- May use internal chart data and stream helpers from this feature directory.
- May call backend K-line services through `feed/SeriesDataFeed`.
- May read `features/watchlist-full-cache` through its resolver during initial
  symbol/interval load, before falling back to the market-data memory cache or
  backend queries.
- May publish indicator range request events when `prepend` or `mid-merge`
  expands the active window; indicators own the actual range request side
  effects.

## Forbidden Dependencies

- Do not own symbol, exchange, market type, interval selection, or user session
  preference persistence; those belong to `features/chart-session`.
- Do not compute or mutate indicators directly.
- Do not expose K-line reset setters back to chart-session or `App.jsx`.
- Do not call K-line REST services directly outside `feed/`.
- Do not own drawing, export, watchlist, settings, or alert UI state.
- Do not expose raw Lightweight Charts objects in the public contract.
- Do not mutate watchlist full-cache rows; market-data may consume a resolved
  warm array and then continue its own chart reconciliation.
