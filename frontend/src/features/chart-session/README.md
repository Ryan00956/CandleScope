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

During the migration it also exposes compatibility fields for existing market
data runtimes, such as tracked interval refs and custom interval actions. Those
fields should disappear when Phase 2 moves the K-line lifecycle into
`features/market-data`.

## Allowed Dependencies

- The feature may consume exchange capability helpers from the migration
  runtime until exchange catalog ownership is revisited.
- It may use shared interval and symbol utilities.
- It may expose stable actions to app composition and feature UI.

## Forbidden Dependencies

- Do not fetch or mutate K-line data here.
- Do not own indicator, drawing, watchlist, or export state.
- Do not expose Lightweight Charts raw objects through the public contract.
- Do not let UI components access chart session storage directly.