# Chart Session Feature

`chart-session` owns the current chart identity: exchange, market type, symbol,
interval, dataset version, exchange capability metadata, and visible range
persistence for the active series.

## Public Contract

`useChartSession` exposes:

```js
{
  view: { symbol, exchange, marketType, interval, datasetKey, nativeIntervals, intervalGroups },
  actions: { selectSymbol, selectInterval, selectMarketType, refreshDataset },
  status: { exchangeCatalogStatus, exchangeLimitations },
}
```

It also exposes compatibility refs used by `features/market-data` while the app
composition root still bridges a small amount of cross-feature coordination.
Those refs should disappear when the market-data and indicator contracts no
longer need imperative range callbacks.

## Allowed Dependencies

- May own exchange capability catalog loading and interval metadata fallback.
- May own custom interval storage and visible-range persistence for the active
  chart identity.
- May temporarily own chart pane layout persistence while pane layout remains
  coupled to the active chart session and indicator panes.
- May use shared interval and symbol utilities.
- May expose stable actions to app composition and feature UI.

## Forbidden Dependencies

- Do not fetch or mutate K-line data here.
- Do not own indicator, drawing, watchlist, or export state.
- Do not expose Lightweight Charts raw objects through the public contract.
- Do not let UI components access chart session storage directly.