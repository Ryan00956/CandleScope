import { useWatchlistStore } from "../../features/watchlist/watchlistStore.js";

export function useWatchlistStorageRuntime() {
  const store = useWatchlistStore();

  return {
    watchlists: store.watchlists,
    setWatchlists: store.actions.setWatchlists,
    handleAddToWatchlist: store.actions.addToWatchlist,
  };
}
