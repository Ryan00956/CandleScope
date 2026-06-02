import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markPerf } from "../../runtime/performance/perfMarks";
import { useSymbolCatalogRuntime } from "./symbolCatalogRuntime";
import { useSymbolFavoritesStore } from "./symbolFavoritesStore";
import {
  ROW_HEIGHT,
  VISIBLE_ROWS,
  buildExchangeChips,
  buildMarketTabs,
  filterSymbols,
  getSymbolWatchlists,
  isSameSymbolEntry,
} from "./symbolSearchFilter";

export function useSymbolSearchRuntime({
  open,
  onClose,
  currentSymbol,
  currentMarketType,
  currentExchange = "binance",
  onSelect,
  exchangeCatalog,
  watchlists,
  onAddToWatchlist,
}) {
  const currentExchangeKey = currentExchange || "binance";
  const currentMarketTypeKey = currentMarketType || "spot";

  const [search, setSearch] = useState("");
  const [marketType, setMarketType] = useState(currentMarketTypeKey);
  const [exchangeFilter, setExchangeFilter] = useState(() => new Set([currentExchangeKey]));
  const [quoteFilter, setQuoteFilter] = useState("USDT");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const modalRef = useRef(null);

  const catalog = useSymbolCatalogRuntime({ currentExchange: currentExchangeKey, open });
  const favoritesStore = useSymbolFavoritesStore();

  useEffect(() => {
    if (open) markPerf("lazy.symbolSearch.ready");
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const resetTimer = setTimeout(() => {
      setSearch("");
      setMarketType(currentMarketTypeKey);
      setExchangeFilter(new Set([currentExchangeKey]));
      setHighlightIndex(0);
      setScrollTop(0);
      setContextMenu(null);
    }, 0);
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      clearTimeout(resetTimer);
      clearTimeout(focusTimer);
    };
  }, [currentExchangeKey, currentMarketTypeKey, open]);

  const exchangeChips = useMemo(() => buildExchangeChips({
    allSymbols: catalog.allSymbols,
    currentExchange: currentExchangeKey,
    exchangeCatalog,
  }), [catalog.allSymbols, currentExchangeKey, exchangeCatalog]);

  const marketTabs = useMemo(() => buildMarketTabs({
    allSymbols: catalog.allSymbols,
    exchangeCatalog,
    exchangeFilter,
  }), [catalog.allSymbols, exchangeCatalog, exchangeFilter]);

  useEffect(() => {
    if (marketType === "favorites") return undefined;
    if (marketTabs.some((tab) => tab.key === marketType)) return undefined;
    const nextMarketType = marketTabs.find((tab) => tab.key !== "favorites")?.key || "favorites";
    const timer = setTimeout(() => setMarketType(nextMarketType), 0);
    return () => clearTimeout(timer);
  }, [marketTabs, marketType]);

  const filteredSymbols = useMemo(() => filterSymbols({
    allSymbols: catalog.allSymbols,
    marketType,
    exchangeFilter,
    quoteFilter,
    search,
    favorites: favoritesStore.favorites,
  }), [catalog.allSymbols, exchangeFilter, favoritesStore.favorites, marketType, quoteFilter, search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setHighlightIndex(0);
      setScrollTop(0);
      if (listRef.current) listRef.current.scrollTop = 0;
    }, 0);
    return () => clearTimeout(timer);
  }, [exchangeFilter, marketType, quoteFilter, search]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [contextMenu]);

  const selectSymbol = useCallback((entry) => {
    if (!isSameSymbolEntry(entry, currentSymbol, currentMarketTypeKey, currentExchangeKey)) {
      onSelect({
        symbol: entry.symbol,
        marketType: entry.marketType,
        exchange: entry.exchange || "binance",
      });
    }
    onClose();
  }, [currentExchangeKey, currentMarketTypeKey, currentSymbol, onClose, onSelect]);

  const toggleFavorite = useCallback((symbolKey, event) => {
    event?.stopPropagation();
    favoritesStore.actions.toggleFavorite(symbolKey);
  }, [favoritesStore.actions]);

  const toggleExchange = useCallback((exchange) => {
    setExchangeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(exchange)) {
        if (next.size > 1) next.delete(exchange);
      } else {
        next.add(exchange);
      }
      return next;
    });
  }, []);

  const openContextMenu = useCallback((event, symbol, symbolKey) => {
    event.preventDefault();
    event.stopPropagation();
    if (!watchlists || watchlists.length === 0) return;
    setContextMenu({ x: event.clientX, y: event.clientY, symbol, _key: symbolKey });
  }, [watchlists]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const addContextSymbolToWatchlist = useCallback((watchlistId) => {
    if (contextMenu && onAddToWatchlist) {
      onAddToWatchlist(watchlistId, contextMenu._key);
    }
    setContextMenu(null);
  }, [contextMenu, onAddToWatchlist]);

  const handleKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIndex((prev) => {
        const maxIndex = Math.max(0, filteredSymbols.length - 1);
        const next = Math.min(prev + 1, maxIndex);
        const topVisible = Math.floor(scrollTop / ROW_HEIGHT);
        const bottomVisible = topVisible + VISIBLE_ROWS - 1;
        if (next > bottomVisible && listRef.current) {
          listRef.current.scrollTop = (next - VISIBLE_ROWS + 1) * ROW_HEIGHT;
        }
        return next;
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIndex((prev) => {
        const next = Math.max(prev - 1, 0);
        const topVisible = Math.floor(scrollTop / ROW_HEIGHT);
        if (next < topVisible && listRef.current) {
          listRef.current.scrollTop = next * ROW_HEIGHT;
        }
        return next;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (filteredSymbols[highlightIndex]) {
        selectSymbol(filteredSymbols[highlightIndex]);
      }
    }
  }, [contextMenu, filteredSymbols, highlightIndex, onClose, scrollTop, selectSymbol]);

  const handleScroll = useCallback((event) => {
    setScrollTop(event.target.scrollTop);
  }, []);

  const totalHeight = filteredSymbols.length * ROW_HEIGHT;
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT);
  const endIndex = Math.min(startIndex + VISIBLE_ROWS + 3, filteredSymbols.length);
  const visibleItems = filteredSymbols.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;
  const listHeight = VISIBLE_ROWS * ROW_HEIGHT;
  const hasWatchlists = Boolean(watchlists && watchlists.length > 0);

  const view = useMemo(() => ({
    search,
    marketType,
    exchangeFilter,
    quoteFilter,
    favorites: favoritesStore.favorites,
    favoriteSet: favoritesStore.favoriteSet,
    exchangeChips,
    marketTabs,
    filteredSymbols,
    highlightIndex,
    contextMenu,
    hasWatchlists,
    virtualRows: {
      rowHeight: ROW_HEIGHT,
      listHeight,
      totalHeight,
      startIndex,
      visibleItems,
      offsetY,
    },
  }), [
    contextMenu,
    exchangeChips,
    exchangeFilter,
    favoritesStore.favoriteSet,
    favoritesStore.favorites,
    filteredSymbols,
    hasWatchlists,
    highlightIndex,
    listHeight,
    marketTabs,
    marketType,
    offsetY,
    quoteFilter,
    search,
    startIndex,
    totalHeight,
    visibleItems,
  ]);

  const actions = useMemo(() => ({
    setSearch,
    setMarketType,
    setQuoteFilter,
    setHighlightIndex,
    toggleExchange,
    toggleFavorite,
    selectSymbol,
    openContextMenu,
    closeContextMenu,
    addContextSymbolToWatchlist,
    getSymbolWatchlists: (symbolKey) => getSymbolWatchlists(watchlists, symbolKey),
    handleKeyDown,
    handleScroll,
    refreshSymbols: catalog.refreshSymbols,
  }), [
    addContextSymbolToWatchlist,
    catalog.refreshSymbols,
    closeContextMenu,
    handleKeyDown,
    handleScroll,
    openContextMenu,
    selectSymbol,
    toggleExchange,
    toggleFavorite,
    watchlists,
  ]);

  return {
    view,
    actions,
    status: {
      loading: catalog.loading,
      refreshing: catalog.refreshing,
    },
    refs: {
      inputRef,
      listRef,
      modalRef,
    },
  };
}