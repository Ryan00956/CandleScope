import { useCallback, useMemo, useState } from "react";
import { parseSymbolKey, symbolKey } from "../../utils/symbolKey";

export const WATCHLISTS_KEY = "candlescope-watchlists";
export const SIDEBAR_WIDTH_KEY = "candlescope-sidebar-width";
export const SIDEBAR_COLLAPSED_KEY = "candlescope-sidebar-collapsed";
export const COLLAPSED_LISTS_KEY = "candlescope-collapsed-lists";

export const DEFAULT_WATCHLIST_WIDTH = 320;
export const MIN_WATCHLIST_WIDTH = 260;
export const MAX_WATCHLIST_WIDTH = 520;

export const WATCHLIST_COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#22c55e", "#f59e0b",
  "#ef4444", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
];

let nextWatchlistId = Date.now();

export function createWatchlistId() {
  return `wl_${nextWatchlistId++}`;
}

export function clampWatchlistWidth(width) {
  return Math.max(MIN_WATCHLIST_WIDTH, Math.min(MAX_WATCHLIST_WIDTH, width));
}

export function normalizeWatchlistSymbol(item) {
  const { symbol, marketType, exchange } = parseSymbolKey(item);
  return symbolKey(symbol, marketType, exchange);
}

export function normalizeWatchlist(watchlist) {
  return {
    ...watchlist,
    symbols: Array.isArray(watchlist.symbols)
      ? watchlist.symbols.map(normalizeWatchlistSymbol)
      : [],
  };
}

export function getDefaultWatchlists() {
  return [{ id: "default", name: "Watchlist", symbols: [], color: "#3b82f6" }];
}

export function loadWatchlists() {
  try {
    const raw = localStorage.getItem(WATCHLISTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(normalizeWatchlist);
      }
    }
  } catch {
    // Ignore malformed user storage and fall back to a clean watchlist.
  }
  return getDefaultWatchlists();
}

export function saveWatchlists(lists) {
  localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(lists));
}

export function loadSidebarWidth() {
  try {
    const width = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10) || DEFAULT_WATCHLIST_WIDTH;
    return clampWatchlistWidth(width);
  } catch {
    return DEFAULT_WATCHLIST_WIDTH;
  }
}

export function saveSidebarWidth(width) {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampWatchlistWidth(width)));
}

export function loadSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed) {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

export function loadCollapsedLists() {
  try {
    const raw = localStorage.getItem(COLLAPSED_LISTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCollapsedLists(ids) {
  localStorage.setItem(COLLAPSED_LISTS_KEY, JSON.stringify(ids));
}

export function useWatchlistStore() {
  const [watchlists, setWatchlistsState] = useState(loadWatchlists);
  const [width, setWidthState] = useState(loadSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(loadSidebarCollapsed);
  const [collapsedLists, setCollapsedListsState] = useState(loadCollapsedLists);

  const setWatchlists = useCallback((nextOrUpdater) => {
    setWatchlistsState((prev) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      saveWatchlists(next);
      return next;
    });
  }, []);

  const addToWatchlist = useCallback((watchlistId, symbol) => {
    setWatchlists((prev) => prev.map((watchlist) => {
      if (watchlist.id === watchlistId && !watchlist.symbols.includes(symbol)) {
        return { ...watchlist, symbols: [...watchlist.symbols, symbol] };
      }
      return watchlist;
    }));
  }, [setWatchlists]);

  const setWidth = useCallback((nextOrUpdater) => {
    setWidthState((prev) => {
      const rawNext = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      const next = clampWatchlistWidth(rawNext);
      saveSidebarWidth(next);
      return next;
    });
  }, []);

  const setSidebarCollapsed = useCallback((nextOrUpdater) => {
    setSidebarCollapsedState((prev) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);

  const setCollapsedLists = useCallback((nextOrUpdater) => {
    setCollapsedListsState((prev) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      saveCollapsedLists(next);
      return next;
    });
  }, []);

  const layout = useMemo(() => ({
    width,
    sidebarCollapsed,
    collapsedLists,
  }), [collapsedLists, sidebarCollapsed, width]);

  const actions = useMemo(() => ({
    setWatchlists,
    addToWatchlist,
    setWidth,
    setSidebarCollapsed,
    setCollapsedLists,
  }), [
    addToWatchlist,
    setCollapsedLists,
    setSidebarCollapsed,
    setWatchlists,
    setWidth,
  ]);

  return {
    watchlists,
    layout,
    actions,
  };
}