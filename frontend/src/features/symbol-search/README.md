# Symbol Search Feature

`features/symbol-search` owns exchange catalog loading for the search modal, favorite symbol persistence, search/filter state, keyboard navigation, and the modal interaction state for adding symbols to watchlists.

## Public Contract

`SymbolSearch.jsx` renders the top-bar trigger and lazy-loads `SymbolSearchModal.jsx`.

`useSymbolSearchRuntime(props)` exposes:

```js
{
  view: {
    search,
    marketType,
    exchangeFilter,
    quoteFilter,
    favorites,
    exchangeChips,
    marketTabs,
    filteredSymbols,
    highlightIndex,
    contextMenu,
    virtualRows,
  },
  actions: {
    setSearch,
    setMarketType,
    toggleExchange,
    setQuoteFilter,
    selectSymbol,
    toggleFavorite,
    openContextMenu,
    addContextSymbolToWatchlist,
    refreshSymbols,
  },
  status: { loading, refreshing },
  refs: { inputRef, listRef, modalRef },
}
```

## Internal Ownership

- `symbolCatalogRuntime.js` owns backend catalog loading and exchange refresh for the modal.
- `symbolFavoritesStore.js` owns favorite symbol localStorage serialization.
- `symbolSearchFilter.js` owns market tab, exchange chip, watchlist lookup, and symbol filtering pure helpers.
- `useSymbolSearchRuntime.js` owns modal state, reset behavior, keyboard navigation, virtual row projection, and context menu coordination.
- `SymbolSearchModal.jsx` renders only feature-owned view data and calls feature actions.

## Allowed Dependencies

- May call backend clients in `src/services/api` for symbol catalog loading and refresh while services are still shared during migration.
- May use `src/utils/symbolKey` to normalize catalog entries.
- May receive watchlist view data and watchlist actions from the app shell or composition root.
- May receive chart session selection data and call a chart session `selectSymbol` action through props.

## Forbidden Dependencies

- Do not let symbol search UI access `localStorage`, call backend services directly, or import app internals.
- Do not own watchlist list mutation beyond calling the watchlist action passed through props.
- Do not hard-code new exchange-specific frontend catalog strategies; consume backend exchange metadata.
- Do not load candles, indicators, drawings, settings, alerts, or export options here.

## Migration Notes

Phase 11 removed the old symbol-search component and runtime compatibility
wrappers. App and shell code should import symbol-search UI and catalog runtime
from this feature directly.