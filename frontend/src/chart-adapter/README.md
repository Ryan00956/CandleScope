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
- `coordinateBridge.js` owns Lightweight Charts coordinate interpolation helpers.
- `ChartPane` still creates and owns chart instances, series, pane sync, and
  rendering lifecycle. Business-facing code should receive the adapter object,
  not raw chart or series refs.

The active adapter also exposes drawing-oriented chart operations such as
`getSeriesData`, `coordinateToLogical`, `logicalToCoordinate`,
`getVisibleTimeRange`, `getVisiblePriceRange`, and `requestSeriesUpdate`.
These are still chart operations; they must not grow business rules.

## Allowed Dependencies

- Adapter modules may import `lightweight-charts`.
- Adapter modules may import generic helpers from `src/shared`.
- During migration, existing chart rendering components may continue to own
  Lightweight Charts lifecycle until Phase 3 moves the bridge behind this
  boundary.

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

Current chart components may still import `lightweight-charts` directly. That
is a migration allowance for the active multi-pane chart renderer, not the
target architecture. The old single-pane `ChartWidget` was removed after it no
longer had runtime references. New business features should depend on adapter
methods rather than chart-library objects.