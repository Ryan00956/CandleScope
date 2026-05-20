import { useCallback, useState } from "react";
import { loadWatchlists, saveWatchlists } from "../../services/watchlistStorage";

export function useWatchlistStorageRuntime() {
  const [watchlists, setWatchlistsState] = useState(loadWatchlists);

  const setWatchlists = useCallback((nextOrUpdater) => {
    setWatchlistsState((prev) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      saveWatchlists(next);
      return next;
    });
  }, []);

  const handleAddToWatchlist = useCallback((watchlistId, symbol) => {
    setWatchlists((prev) => prev.map((watchlist) => {
      if (watchlist.id === watchlistId && !watchlist.symbols.includes(symbol)) {
        return { ...watchlist, symbols: [...watchlist.symbols, symbol] };
      }
      return watchlist;
    }));
  }, [setWatchlists]);

  return {
    watchlists,
    setWatchlists,
    handleAddToWatchlist,
  };
}
