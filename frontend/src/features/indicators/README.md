# Indicators Feature

`features/indicators` owns indicator state and rendering outputs for the active
chart session. It consumes chart-session and market-data contracts, then exposes
stable view/action/status objects to the app shell.

## Public Contract

`useIndicatorRuntime({ session, marketData, candleUpColor, candleDownColor, onIndicatorRemoved })`
exposes:

```js
{
  view: {
    activeIndicators,
    mainOverlayLines,
    subPanes,
    markers,
    fills,
    hlines,
    bgcolors,
    barcolors,
    signals,
    paramSchemas,
  },
  actions: {
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    recompute,
    requestIndicatorRange,
  },
  status: { computing },
}
```

The hook returns only `view`, `actions`, and `status`; callers must not depend
on legacy flat fields.

## Internal Ownership

- `activeIndicatorStore.js` owns active indicator persistence and mutation.
- `useIndicatorCatalogRuntime.js` owns preset/custom indicator catalog loading
  and custom indicator save/delete actions.
- `indicatorComputeController.js` owns local/backend compute scheduling.
- `indicatorStreamController.js` owns hosted indicator WebSocket subscriptions,
  snapshots, patches, range requests, and sequence recovery.
- `indicatorOutputReducer.js` owns marker/fill/hline/bgcolor/barcolor/signal
  output updates.
- `indicatorPaneProjection.js` maps active indicator lines into main overlays and
  sub panes as a pure projection.

## Allowed Dependencies

- May consume `features/chart-session` and `features/market-data` contracts
  through arguments passed by the app composition root.
- May consume market-data indicator range request status/actions idempotently and
  issue hosted indicator range requests through the indicator stream controller.
- May notify the app composition root when an indicator is removed so owning
  features can handle related cleanup through their own public actions.
- May call indicator backend services through `services/indicatorApi`.
- May use chart data shape supplied by market-data, without owning K-line
  loading, caching, WebSocket ticks, or gap recovery.
- May expose feature UI entry points such as `IndicatorPanel` and
  `IndicatorEditor`.

## Forbidden Dependencies

- Do not own symbol, exchange, market type, interval selection, or K-line data
  lifecycle.
- Do not import App internals or raw Lightweight Charts objects.
- Do not write drawing, watchlist, settings, export, or alert state here.
- Do not move indicator rendering series lifecycle into this feature; chart
  rendering remains behind chart components and the chart adapter boundary.

## Migration Notes

Phase 11 removed the old `src/hooks/useIndicators.js` wrapper and folded the
indicator compute, payload, catalog, security-policy, hosted stream helpers,
and indicator panel/editor UI into this feature.
