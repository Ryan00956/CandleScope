# Chart Session Feature

`chart-session` owns the current chart identity: exchange, market type, symbol,
interval, dataset version, exchange capability metadata, and visible range
persistence for the active series.

## Public Contract

`useChartSession` exposes:

```js
{
  view: { symbol, exchange, marketType, interval, sessionKey, datasetKey, nativeIntervals, intervalGroups },
  actions: {
    selectSymbol,
    selectInterval,
    selectMarketType,
    refreshDataset,
    handleVisibleRangeChange,
    updateVisibleRangeDataMeta,
  },
  events: { transitionToken, lastTransition },
  status: { exchangeCatalogStatus, exchangeLimitations },
}
```

Session identity changes are exposed as explicit transition events. Consumers
that own data, drawing, or indicator side effects should react to those events
inside their feature runtime instead of reaching back through `App.jsx`.

## Allowed Dependencies

- May own exchange capability catalog loading and interval metadata fallback.
- May own custom interval storage and visible-range persistence for the active
  chart identity.
- May temporarily own chart pane layout persistence while pane layout remains
  coupled to the active chart session and indicator panes.
- May use shared interval and symbol utilities.
- May expose stable actions to app composition and feature UI.
- May publish pure session transition metadata for feature runtimes that need to
  reset their own state after symbol, interval, or capability changes.

## Forbidden Dependencies

- Do not fetch or mutate K-line data here.
- Do not own indicator, drawing, watchlist, or export state.
- Do not expose Lightweight Charts raw objects through the public contract.
- Do not call market-data setters through bridge refs.
- Do not let UI components access chart session storage directly.
