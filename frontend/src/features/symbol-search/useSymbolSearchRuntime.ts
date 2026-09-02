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
  resolveExchangeMarketType,
} from "./symbolSearchFilter";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
  UIEvent as ReactUIEvent,
} from "react";
import type { WatchlistGroup } from "../watchlist/watchlistTypes.js";
import type {
  ExchangeCatalog,
  SymbolSearchItem,
} from "./symbolSearchTypes.js";
import {
  resolveKlineSeriesIdentity,
  type KlineSeriesIdentityInput,
} from "../market-data/klineSeriesIdentity.js";

export interface SymbolSelection extends KlineSeriesIdentityInput {
  symbol: string;
  marketType: string;
  exchange: string;
}

export interface SymbolContextMenu {
  x: number;
  y: number;
  symbol: string;
  _key: string;
}

export interface UseSymbolSearchRuntimeOptions {
  open: boolean;
  onClose(): void;
  currentSymbol: string;
  currentMarketType?: string | null;
  currentExchange?: string;
  onSelect(selection: SymbolSelection): void;
  exchangeCatalog?: ExchangeCatalog | null;
  watchlists?: WatchlistGroup[] | null;
  onAddToWatchlist?: ((watchlistId: string, symbolKey: string) => void) | null;
}

export interface SymbolSearchRuntime {
  view: {
    search: string;
    marketType: string;
    exchangeFilter: Set<string>;
    quoteFilter: string;
    favorites: string[];
    favoriteSet: Set<string>;
    exchangeChips: Array<{ key: string; label: string; disabled: boolean }>;
    marketTabs: ReturnType<typeof buildMarketTabs>;
    filteredSymbols: SymbolSearchItem[];
    highlightIndex: number;
    contextMenu: SymbolContextMenu | null;
    hasWatchlists: boolean;
    virtualRows: {
      rowHeight: number;
      listHeight: number;
      totalHeight: number;
      startIndex: number;
      visibleItems: SymbolSearchItem[];
      offsetY: number;
    };
  };
  actions: {
    setSearch: Dispatch<SetStateAction<string>>;
    setMarketType: Dispatch<SetStateAction<string>>;
    setQuoteFilter: Dispatch<SetStateAction<string>>;
    setHighlightIndex: Dispatch<SetStateAction<number>>;
    selectExchange(exchange: string): void;
    toggleExchange(exchange: string): void;
    toggleFavorite(symbolKey: string, event?: { stopPropagation(): void } | null): void;
    selectSymbol(entry: SymbolSearchItem): void;
    openContextMenu(event: ReactMouseEvent, symbol: string, symbolKey: string): void;
    closeContextMenu(): void;
    addContextSymbolToWatchlist(watchlistId: string): void;
    getSymbolWatchlists(symbolKey: string): WatchlistGroup[];
    handleKeyDown(event: ReactKeyboardEvent): void;
    handleScroll(event: ReactUIEvent<HTMLDivElement>): void;
    refreshSymbols(): Promise<void>;
  };
  status: {
    loading: boolean;
    refreshing: boolean;
  };
  refs: {
    inputRef: MutableRefObject<HTMLInputElement | null>;
    listRef: MutableRefObject<HTMLDivElement | null>;
    modalRef: MutableRefObject<HTMLDivElement | null>;
  };
}

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
}: UseSymbolSearchRuntimeOptions): SymbolSearchRuntime {
  const currentExchangeKey = currentExchange || "binance";
  const currentMarketTypeKey = currentMarketType || "spot";

  const [search, setSearch] = useState("");
  const [marketType, setMarketType] = useState(currentMarketTypeKey);
  const [exchangeFilter, setExchangeFilter] = useState<Set<string>>(() => new Set([currentExchangeKey]));
  const [quoteFilter, setQuoteFilter] = useState("USDT");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState<SymbolContextMenu | null>(null);
  const queryOnlyExchanges = useMemo(() => new Set(
    Object.entries(exchangeCatalog || {})
      .filter(([, entry]) => entry.protocolFeatures?.has("rest.symbol_search.query_only"))
      .map(([exchange]) => exchange),
  ), [exchangeCatalog]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const catalog = useSymbolCatalogRuntime({
    currentExchange: currentExchangeKey,
    requestedMarketType: marketType === "favorites" ? currentMarketTypeKey : marketType,
    requestedExchanges: exchangeFilter,
    providerSearch: search,
    queryOnlyExchanges,
    open,
  });
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
      setQuoteFilter(queryOnlyExchanges.has(currentExchangeKey) ? "ALL" : "USDT");
      setHighlightIndex(0);
      setScrollTop(0);
      setContextMenu(null);
    }, 0);
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      clearTimeout(resetTimer);
      clearTimeout(focusTimer);
    };
  }, [currentExchangeKey, currentMarketTypeKey, open, queryOnlyExchanges]);

  const exchangeChips = useMemo(() => buildExchangeChips({
    allSymbols: catalog.allSymbols,
    currentExchange: currentExchangeKey,
    ...(exchangeCatalog === undefined ? {} : { exchangeCatalog }),
  }), [catalog.allSymbols, currentExchangeKey, exchangeCatalog]);

  const marketTabs = useMemo(() => buildMarketTabs({
    allSymbols: catalog.allSymbols,
    exchangeFilter,
    ...(exchangeCatalog === undefined ? {} : { exchangeCatalog }),
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

  const selectSymbol = useCallback((entry: SymbolSearchItem) => {
    if (!isSameSymbolEntry(entry, currentSymbol, currentMarketTypeKey, currentExchangeKey)) {
      const exchange = entry.exchange || "binance";
      onSelect({
        symbol: entry.symbol,
        marketType: entry.marketType,
        exchange,
        ...resolveKlineSeriesIdentity(exchange, entry),
      });
    }
    onClose();
  }, [currentExchangeKey, currentMarketTypeKey, currentSymbol, onClose, onSelect]);

  const toggleFavorite = useCallback((symbolKey: string, event?: { stopPropagation(): void } | null) => {
    event?.stopPropagation();
    favoritesStore.actions.toggleFavorite(symbolKey);
  }, [favoritesStore.actions]);

  const toggleExchange = useCallback((exchange: string) => {
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

  const selectExchange = useCallback((exchange: string) => {
    const nextExchangeFilter = new Set([exchange]);
    const nextMarketTabs = buildMarketTabs({
      allSymbols: catalog.allSymbols,
      exchangeFilter: nextExchangeFilter,
      ...(exchangeCatalog === undefined ? {} : { exchangeCatalog }),
    });
    const nextMarketType = resolveExchangeMarketType(marketType, nextMarketTabs);
    setExchangeFilter(nextExchangeFilter);
    setMarketType(nextMarketType);
    if (queryOnlyExchanges.has(exchange)) setQuoteFilter("ALL");
  }, [catalog.allSymbols, exchangeCatalog, marketType, queryOnlyExchanges]);

  const openContextMenu = useCallback((event: ReactMouseEvent, symbol: string, symbolKey: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!watchlists || watchlists.length === 0) return;
    setContextMenu({ x: event.clientX, y: event.clientY, symbol, _key: symbolKey });
  }, [watchlists]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const addContextSymbolToWatchlist = useCallback((watchlistId: string) => {
    if (contextMenu && onAddToWatchlist) {
      onAddToWatchlist(watchlistId, contextMenu._key);
    }
    setContextMenu(null);
  }, [contextMenu, onAddToWatchlist]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
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

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
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
    selectExchange,
    toggleExchange,
    toggleFavorite,
    selectSymbol,
    openContextMenu,
    closeContextMenu,
    addContextSymbolToWatchlist,
    getSymbolWatchlists: (symbolKey: string) => getSymbolWatchlists(watchlists, symbolKey),
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
    selectExchange,
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
