# Chart Adapter Boundaries

`src/chart-adapter` is the boundary around Lightweight Charts and chart-library
specific objects. It exists so business features can ask for chart operations
without owning chart refs, series instances, primitives, or coordinate APIs.

## Target Contract

Adapter-facing code should converge on a contract like:

```js
{
  getMainSeries,
  attachPrimitive,
  detachPrimitive,
  priceToCoordinate,
  timeToCoordinate,
  coordinateToPrice,
  coordinateToTime,
  restoreVisibleRange,
  subscribeCrosshair,
}
```

The exact implementation can evolve, but the public contract should stay about
chart operations, not feature state.

## Current Bridge

- `chartInstanceBridge.js` wraps live chart and series refs and exposes chart
  operations for drawing/runtime code.
- `lightweightChartSurface.js` owns direct `lightweight-charts` imports and
  exposes the chart factory plus series type tokens used by chart renderers.
- `coordinateBridge.js` owns Lightweight Charts coordinate interpolation helpers.
- `viewportController.js` serializes fit/restore/compensate intents so user
  interaction is not fighting automatic visible-range writes.
- `seriesDeltaRenderer.js` applies `SeriesWindowStore` deltas directly to chart
  series, using tick/update paths where possible and compensating prepends via
  `ViewportController`.
- `ChartPane` still creates and owns chart instances, series, pane sync, and
  rendering lifecycle, but it receives Lightweight Charts factory/type objects
  through this adapter boundary. Business-facing code should receive the adapter
  object, not raw chart or series refs.

The active adapter also exposes drawing-oriented chart operations such as
`getSeriesData`, `coordinateToLogical`, `logicalToCoordinate`,
`getVisibleTimeRange`, `getVisiblePriceRange`, and `requestSeriesUpdate`.
These are still chart operations; they must not grow business rules.

## Allowed Dependencies

- Adapter modules may import `lightweight-charts`.
- Adapter modules may import generic helpers from `src/shared`.
- Chart rendering components may own chart lifecycle only through adapter
  modules; direct `lightweight-charts` imports must stay inside this directory.
- Viewport writes should flow through `ViewportController`.

## Forbidden Dependencies

- Do not import feature runtime modules or feature stores into the adapter.
- Do not import backend services or create HTTP/WebSocket requests here.
- Do not access `localStorage` or own drawing, indicator, session, or export
  persistence.
- Do not encode exchange, symbol, interval, market type, indicator, drawing, or
  settings business rules.
- Do not expose raw Lightweight Charts refs or series instances from feature
  public contracts.

## Migration Notes

The active multi-pane renderer still owns its chart lifecycle, but direct
`lightweight-charts` imports now live inside `src/chart-adapter`. The old
single-pane `ChartWidget` was removed after it no longer had runtime
references. New business features should depend on adapter methods rather than
chart-library objects.
