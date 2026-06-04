# Watchlist Feature

`features/watchlist` owns user watchlist folders, sidebar layout persistence,
backend subscription tiers, watchlist price streaming, and the subscription
intent for full-tier K-line warming.

## Public Contract

`useWatchlistRuntime()` exposes:

```js
{
  view: {
    watchlists,
    layout: { width, sidebarCollapsed, collapsedLists },
    prices,
    subscriptionTiers,
    subscriptionResourceSummaries,
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

The runtime returns only `view`, `actions`, and `status`; callers must not
depend on legacy flat fields.

## Internal Ownership

- `watchlistStore.js` owns watchlist list storage, sidebar width, collapsed sidebar state, collapsed list state, symbol normalization, and list mutations.
- `watchlistSubscriptionRuntime.js` owns backend subscription synchronization, tier updates, price WebSocket updates, and full-tier interval request planning.
- `WatchlistSidebar.jsx` renders watchlists from feature-owned view data and calls feature actions for list, layout, and subscription changes.
- `features/watchlist-full-cache` owns full-tier background K-line arrays. It is a sibling feature so the sidebar never stores candle rows itself.

## Allowed Dependencies

- May use symbol key helpers from `src/utils` to normalize persisted symbols during migration.
- May call backend clients in `src/services/api` for watchlist subscription and price stream behavior.
- May expose watchlist view data to symbol search, alerts, settings, and the app shell through `App.jsx`.
- May receive exchange native intervals and user custom intervals from the app composition root to build full-tier subscription requests.

## Forbidden Dependencies

- Do not load chart candles, indicators, drawings, settings, alerts, or export options here.
- Do not import App internals or sibling feature internals.
- Do not let watchlist UI access `localStorage`, create `WebSocket`, or call backend services directly.
- Do not merge watchlist price streaming into `features/market-data`; watchlist prices are a separate subscription surface.
- Do not store K-line arrays in `WatchlistSidebar.jsx`; full-tier candle rows belong to `features/watchlist-full-cache`.

## Subscription Tiers

- `none`: no watchlist-owned ticker or K-line keepalive.
- `price`: ticker price stream only.
- `full`: ticker price stream plus every frontend-switchable interval for the symbol's exchange. The interval set is exchange native intervals plus saved custom intervals.

The tier API request includes `consumer_id` so DataManager can reuse existing
backend streams for duplicate frontend or chart consumers instead of opening
new exchange upstream subscriptions.

## Migration Notes

Phase 11 removed the old watchlist runtime and component wrappers. `src/services/watchlistStorage.js`
remains as a compatibility storage entry until all watchlist storage imports are
folded into this feature.
