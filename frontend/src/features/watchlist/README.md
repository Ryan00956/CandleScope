# Watchlist Feature

`features/watchlist` owns user watchlist folders, sidebar layout persistence, backend subscription tiers, and watchlist price streaming.

## Public Contract

`useWatchlistRuntime()` exposes:

```js
{
  view: {
    watchlists,
    layout: { width, sidebarCollapsed, collapsedLists },
    prices,
    subscriptionTiers,
  },
  actions: {
    setWatchlists,
    addToWatchlist,
    setWidth,
    setSidebarCollapsed,
    setCollapsedLists,
    handleTierChange,
    refreshSubscriptions,
  },
  status: {},
}
```

The runtime still returns legacy flat fields while `App.jsx` and shell props continue to migrate.

## Internal Ownership

- `watchlistStore.js` owns watchlist list storage, sidebar width, collapsed sidebar state, collapsed list state, symbol normalization, and list mutations.
- `watchlistSubscriptionRuntime.js` owns backend subscription synchronization, tier updates, and price WebSocket updates.
- `WatchlistSidebar.jsx` renders watchlists from feature-owned view data and calls feature actions for list, layout, and subscription changes.

## Allowed Dependencies

- May use symbol key helpers from `src/utils` to normalize persisted symbols during migration.
- May call backend clients in `src/services/api` for watchlist subscription and price stream behavior.
- May expose watchlist view data to symbol search, alerts, settings, and the app shell through `App.jsx`.

## Forbidden Dependencies

- Do not load chart candles, indicators, drawings, settings, alerts, or export options here.
- Do not import App internals or sibling feature internals.
- Do not let watchlist UI access `localStorage`, create `WebSocket`, or call backend services directly.
- Do not merge watchlist price streaming into `features/market-data`; watchlist prices are a separate subscription surface.

## Migration Notes

Phase 11 removed the old watchlist runtime and component wrappers. `src/services/watchlistStorage.js`
remains as a compatibility storage entry until all watchlist storage imports are
folded into this feature.