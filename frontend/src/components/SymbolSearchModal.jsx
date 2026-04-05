import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchExchangeInfo, refreshExchangeInfo } from "../services/api";
import { symbolKey, parseSymbolKey } from "../utils/symbolKey";

// ── Constants ────────────────────────────────────────────────
const FAVORITES_KEY = "candlescope-favorite-symbols-v2";
const QUOTE_CHIPS = ["USDT", "BTC", "ETH", "BNB", "FDUSD", "ALL"];
const MARKET_TABS = [
  { key: "favorites", label: "★ 收藏", icon: "⭐" },
  { key: "spot",      label: "现货",   icon: "💱" },
  { key: "futures",   label: "合约",   icon: "📄" },
];
const EXCHANGE_CHIPS = [
  { key: "binance", label: "Binance" },
  // Future: { key: "okx", label: "OKX" }, { key: "bybit", label: "Bybit" }
];

// Virtual scroll
const ROW_HEIGHT = 42;
const VISIBLE_ROWS = 14;

// ── LocalStorage helpers ─────────────────────────────────────
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveFavorites(list) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

// ── Component ────────────────────────────────────────────────
export default function SymbolSearchModal({
  open, onClose, currentSymbol, currentMarketType, onSelect,
  watchlists, onAddToWatchlist,
}) {
  const [search, setSearch] = useState("");
  const [marketType, setMarketType] = useState("spot");
  const [exchangeFilter, setExchangeFilter] = useState(new Set(["binance"]));
  const [quoteFilter, setQuoteFilter] = useState("USDT");
  const [favorites, setFavorites] = useState(loadFavorites);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [allSymbols, setAllSymbols] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // ── Right-click context menu state ──
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, symbol }

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const modalRef = useRef(null);

  // ── Load exchange info ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (allSymbols.length === 0) {
      setLoading(true);
      fetchExchangeInfo()
        .then((data) => {
          if (!cancelled && data?.symbols) {
            // Enrich with exchange and marketType defaults
            const enriched = data.symbols.map((s) => ({
              ...s,
              exchange: s.exchange || "binance",
              marketType: s.marketType || "spot",
              _key: symbolKey(s.symbol, s.marketType || "spot"),
            }));
            setAllSymbols(enriched);
          }
        })
        .catch((err) => console.warn("Failed to load exchange info:", err))
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [open, allSymbols.length]);

  // ── Auto-focus & reset on open ──
  useEffect(() => {
    if (open) {
      setSearch("");
      setHighlightIndex(0);
      setScrollTop(0);
      setCtxMenu(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // ── Filter logic ──
  const filtered = useMemo(() => {
    let list = allSymbols;

    // Market type
    if (marketType === "favorites") {
      const favSet = new Set(favorites);
      list = list.filter((s) => favSet.has(s._key));
    } else {
      list = list.filter((s) => s.marketType === marketType);
    }

    // Exchange
    if (exchangeFilter.size > 0) {
      list = list.filter((s) => exchangeFilter.has(s.exchange));
    }

    // Quote asset
    if (quoteFilter && quoteFilter !== "ALL") {
      list = list.filter((s) => s.quoteAsset === quoteFilter);
    }

    // Search text
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      list = list.filter(
        (s) =>
          s.symbol.includes(q) ||
          s.baseAsset.includes(q) ||
          s.quoteAsset.includes(q),
      );
    }

    return list;
  }, [allSymbols, marketType, exchangeFilter, quoteFilter, search, favorites]);

  // ── Clamp highlight when filter changes ──
  useEffect(() => {
    setHighlightIndex(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [marketType, exchangeFilter, quoteFilter, search]);

  // ── Handlers ──
  const handleSelect = useCallback(
    (entry) => {
      // entry is the full symbol object from the filtered list
      const isSame = entry.symbol === currentSymbol && entry.marketType === (currentMarketType || "spot");
      if (!isSame) onSelect({ symbol: entry.symbol, marketType: entry.marketType });
      onClose();
    },
    [currentSymbol, currentMarketType, onSelect, onClose],
  );

  const toggleFavorite = useCallback((sKey, e) => {
    e?.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(sKey)
        ? prev.filter((k) => k !== sKey)
        : [...prev, sKey];
      saveFavorites(next);
      return next;
    });
  }, []);

  const toggleExchange = useCallback((ex) => {
    setExchangeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(ex)) {
        // Don't allow deselecting all
        if (next.size > 1) next.delete(ex);
      } else {
        next.add(ex);
      }
      return next;
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshExchangeInfo();
      const data = await fetchExchangeInfo();
      if (data?.symbols) {
        const enriched = data.symbols.map((s) => ({
          ...s,
          exchange: s.exchange || "binance",
          marketType: s.marketType || "spot",
          _key: symbolKey(s.symbol, s.marketType || "spot"),
        }));
        setAllSymbols(enriched);
      }
    } catch (err) {
      console.warn("Refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // ── Right-click handler for rows ──
  const handleRowContextMenu = useCallback((e, sym, sKey) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show if watchlists are provided
    if (!watchlists || watchlists.length === 0) return;
    setCtxMenu({ x: e.clientX, y: e.clientY, symbol: sym, _key: sKey });
  }, [watchlists]);

  // Dismiss context menu
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [ctxMenu]);

  // ── Keyboard navigation ──
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (ctxMenu) { setCtxMenu(null); return; }
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((prev) => {
          const next = Math.min(prev + 1, filtered.length - 1);
          // Auto-scroll to keep highlighted item visible
          const topVisible = Math.floor(scrollTop / ROW_HEIGHT);
          const bottomVisible = topVisible + VISIBLE_ROWS - 1;
          if (next > bottomVisible && listRef.current) {
            listRef.current.scrollTop = (next - VISIBLE_ROWS + 1) * ROW_HEIGHT;
          }
          return next;
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
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
      if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[highlightIndex]) {
          handleSelect(filtered[highlightIndex]);
        }
        return;
      }
    },
    [filtered, highlightIndex, scrollTop, onClose, handleSelect, ctxMenu],
  );

  // ── Virtual scroll calculations ──
  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT);
  const endIndex = Math.min(startIndex + VISIBLE_ROWS + 3, filtered.length);
  const visibleItems = filtered.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  const handleScroll = useCallback((e) => {
    setScrollTop(e.target.scrollTop);
  }, []);

  // ── Favorites set for quick lookup ──
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  // ── Watchlist membership lookup ──
  const getSymbolWatchlists = useCallback((sKey) => {
    if (!watchlists) return [];
    return watchlists.filter((wl) => wl.symbols.includes(sKey));
  }, [watchlists]);

  if (!open) return null;

  const listHeight = VISIBLE_ROWS * ROW_HEIGHT;
  const hasWatchlists = watchlists && watchlists.length > 0;

  return (
    <div className="sym-modal-overlay" onClick={onClose}>
      <div
        className="sym-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* ── Header: Search bar ── */}
        <div className="sym-modal-header">
          <div className="sym-modal-search-row">
            <svg className="sym-modal-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={inputRef}
              className="sym-modal-search-input"
              type="text"
              placeholder="搜索交易对... (Ctrl+K)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {search && (
              <button className="sym-modal-search-clear" onClick={() => setSearch("")}>
                ✕
              </button>
            )}
            <button className="sym-modal-close-btn" onClick={onClose} title="关闭 (Esc)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Filter toolbar ── */}
        <div className="sym-modal-filters">
          {/* Market type tabs */}
          <div className="sym-modal-filter-row">
            <div className="sym-modal-market-tabs">
              {MARKET_TABS.map((tab) => (
                <button
                  key={tab.key}
                  className={`sym-modal-market-tab ${marketType === tab.key ? "active" : ""}`}
                  onClick={() => setMarketType(tab.key)}
                >
                  <span className="sym-modal-tab-icon">{tab.icon}</span>
                  {tab.label}
                  {tab.key === "favorites" && favorites.length > 0 && (
                    <span className="sym-modal-tab-badge">{favorites.length}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Exchange + Quote filters */}
          <div className="sym-modal-filter-row sym-modal-filter-row-chips">
            <div className="sym-modal-chip-group">
              <span className="sym-modal-chip-label">交易所</span>
              {EXCHANGE_CHIPS.map((ex) => (
                <button
                  key={ex.key}
                  className={`sym-modal-chip ${exchangeFilter.has(ex.key) ? "active" : ""}`}
                  onClick={() => toggleExchange(ex.key)}
                >
                  {ex.label}
                  {exchangeFilter.has(ex.key) && <span className="sym-modal-chip-check">✓</span>}
                </button>
              ))}
            </div>

            <div className="sym-modal-chip-divider" />

            <div className="sym-modal-chip-group">
              <span className="sym-modal-chip-label">计价</span>
              {QUOTE_CHIPS.map((qt) => (
                <button
                  key={qt}
                  className={`sym-modal-chip ${quoteFilter === qt ? "active" : ""}`}
                  onClick={() => setQuoteFilter(qt)}
                >
                  {qt}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Table header ── */}
        <div className="sym-modal-table-header">
          <span className="sym-modal-col-fav" />
          <span className="sym-modal-col-pair">交易对</span>
          <span className="sym-modal-col-base">基础资产</span>
          <span className="sym-modal-col-quote">计价资产</span>
          <span className="sym-modal-col-type">类型</span>
          <span className="sym-modal-col-exchange">交易所</span>
        </div>

        {/* ── Results list (virtual scroll) ── */}
        <div
          className="sym-modal-list"
          ref={listRef}
          onScroll={handleScroll}
          style={{ height: listHeight }}
        >
          {loading ? (
            <div className="sym-modal-empty">
              <div className="sym-modal-spinner" />
              <span>加载交易对数据...</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="sym-modal-empty">
              <span className="sym-modal-empty-icon">
                {marketType === "favorites" ? "⭐" : "🔍"}
              </span>
              <span>
                {marketType === "favorites"
                  ? "暂无收藏，点击 ★ 添加收藏"
                  : "无匹配结果"}
              </span>
            </div>
          ) : (
            <div style={{ height: totalHeight, position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  top: offsetY,
                  left: 0,
                  right: 0,
                }}
              >
                {visibleItems.map((s, i) => {
                  const realIndex = startIndex + i;
                  const isHighlighted = realIndex === highlightIndex;
                  const isCurrent = s.symbol === currentSymbol && s.marketType === (currentMarketType || "spot");
                  const isFav = favSet.has(s._key);
                  const inWatchlists = getSymbolWatchlists(s._key);

                  return (
                    <div
                      key={s._key}
                      className={`sym-modal-row ${isHighlighted ? "highlighted" : ""} ${isCurrent ? "current" : ""}`}
                      style={{ height: ROW_HEIGHT }}
                      onClick={() => handleSelect(s)}
                      onMouseEnter={() => setHighlightIndex(realIndex)}
                      onContextMenu={(e) => handleRowContextMenu(e, s.symbol, s._key)}
                    >
                      <button
                        className={`sym-modal-fav-btn ${isFav ? "active" : ""}`}
                        onClick={(e) => toggleFavorite(s._key, e)}
                        title={isFav ? "取消收藏" : "添加收藏"}
                      >
                        {isFav ? "★" : "☆"}
                      </button>
                      <span className="sym-modal-col-pair sym-modal-row-pair">
                        {s.symbol}
                        {isCurrent && <span className="sym-modal-current-tag">当前</span>}
                        {hasWatchlists && inWatchlists.length > 0 && (
                          <span className="sym-modal-wl-indicators">
                            {inWatchlists.map((wl) => (
                              <span
                                key={wl.id}
                                className="sym-modal-wl-dot"
                                style={{ background: wl.color || "#3b82f6" }}
                                title={`在列表: ${wl.name}`}
                              />
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="sym-modal-col-base sym-modal-row-base">{s.baseAsset}</span>
                      <span className="sym-modal-col-quote sym-modal-row-quote">{s.quoteAsset}</span>
                      <span className="sym-modal-col-type sym-modal-row-type">
                        <span className={`sym-modal-type-badge ${s.marketType}`}>
                          {s.marketType === "spot" ? "现货" : "合约"}
                        </span>
                      </span>
                      <span className="sym-modal-col-exchange sym-modal-row-exchange">
                        {(s.exchange || "binance").charAt(0).toUpperCase() + (s.exchange || "binance").slice(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="sym-modal-footer">
          <div className="sym-modal-footer-left">
            <span className="sym-modal-result-count">
              {filtered.length.toLocaleString()} 个交易对
            </span>
            <span className="sym-modal-shortcut-hint">
              <kbd>↑</kbd><kbd>↓</kbd> 导航 · <kbd>Enter</kbd> 选择 · <kbd>Esc</kbd> 关闭
              {hasWatchlists && " · 右键添加到自选列表"}
            </span>
          </div>
          <button
            className="sym-modal-refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="刷新交易所数据"
          >
            <span className={`sym-modal-refresh-icon ${refreshing ? "spinning" : ""}`}>⟳</span>
            {refreshing ? "刷新中..." : "刷新数据"}
          </button>
        </div>
      </div>

      {/* ── Right-click context menu: add to watchlist ── */}
      {ctxMenu && hasWatchlists && (
        <div
          className="sym-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sym-ctx-header">
            <span className="sym-ctx-header-symbol">{ctxMenu.symbol}</span>
            <span className="sym-ctx-header-label">添加到自选列表</span>
          </div>
          <div className="sym-ctx-items">
            {watchlists.map((wl) => {
              const alreadyIn = wl.symbols.includes(ctxMenu._key);
              return (
                <button
                  key={wl.id}
                  className={`sym-ctx-item ${alreadyIn ? "already-in" : ""}`}
                  onClick={() => {
                    if (!alreadyIn && onAddToWatchlist) {
                      onAddToWatchlist(wl.id, ctxMenu._key);
                    }
                    setCtxMenu(null);
                  }}
                  disabled={alreadyIn}
                >
                  <span className="sym-ctx-dot" style={{ background: wl.color || "#3b82f6" }} />
                  <span className="sym-ctx-name">{wl.name}</span>
                  {alreadyIn ? (
                    <span className="sym-ctx-check">✓</span>
                  ) : (
                    <span className="sym-ctx-plus">+</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
