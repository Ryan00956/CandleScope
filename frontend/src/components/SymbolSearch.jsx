import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchExchangeInfo } from "../services/api";

// Popular quote assets for quick-filter tabs
const QUOTE_TABS = ["USDT", "BTC", "ETH", "BNB", "ALL"];

// Virtual scroll config
const ROW_HEIGHT = 36;
const VISIBLE_ROWS = 12;

export default function SymbolSearch({ currentSymbol, onSelect }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [quoteFilter, setQuoteFilter] = useState("USDT");
  const [allSymbols, setAllSymbols] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);

  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // ── Load exchange info on mount ──
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchExchangeInfo()
      .then((data) => {
        if (!cancelled && data?.symbols) {
          setAllSymbols(data.symbols);
        }
      })
      .catch((err) => {
        console.warn("Failed to load exchange info:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ── Filter logic (client-side) ──
  const filtered = useMemo(() => {
    let list = allSymbols;
    if (quoteFilter && quoteFilter !== "ALL") {
      list = list.filter((s) => s.quoteAsset === quoteFilter);
    }
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
  }, [allSymbols, quoteFilter, search]);

  // ── Close on click outside ──
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ── Auto-focus search input when panel opens ──
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // ── Reset scroll & search when opening ──
  const handleOpen = useCallback(() => {
    setOpen((prev) => !prev);
    setSearch("");
    setScrollTop(0);
  }, []);

  const handleSelect = useCallback(
    (sym) => {
      if (sym !== currentSymbol) {
        onSelect(sym);
      }
      setOpen(false);
    },
    [currentSymbol, onSelect],
  );

  // ── Virtual scroll ──
  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT);
  const endIndex = Math.min(startIndex + VISIBLE_ROWS + 2, filtered.length);
  const visibleItems = filtered.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  const handleScroll = useCallback((e) => {
    setScrollTop(e.target.scrollTop);
  }, []);

  // Format base/quote display: "ETH / USDT"
  const formatPair = (s) => `${s.baseAsset} / ${s.quoteAsset}`;

  return (
    <div className="symbol-search-wrapper" ref={panelRef}>
      {/* Trigger button — shows current symbol */}
      <button
        className="symbol-selector"
        id="symbol-selector"
        onClick={handleOpen}
        title="切换交易对"
      >
        <span className="symbol-name">{currentSymbol}</span>
        <span className="symbol-exchange">Binance</span>
        <span className="symbol-caret">{open ? "▲" : "▼"}</span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="symbol-search-panel">
          {/* Search input */}
          <div className="symbol-search-input-row">
            <span className="symbol-search-icon">🔍</span>
            <input
              ref={inputRef}
              className="symbol-search-input"
              type="text"
              placeholder="搜索交易对..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setScrollTop(0);
              }}
              spellCheck={false}
              autoComplete="off"
            />
            {search && (
              <button
                className="symbol-search-clear"
                onClick={() => setSearch("")}
              >
                ✕
              </button>
            )}
          </div>

          {/* Quote asset tabs */}
          <div className="symbol-quote-tabs">
            {QUOTE_TABS.map((qt) => (
              <button
                key={qt}
                className={`symbol-quote-tab ${quoteFilter === qt ? "active" : ""}`}
                onClick={() => {
                  setQuoteFilter(qt);
                  setScrollTop(0);
                }}
              >
                {qt}
              </button>
            ))}
          </div>

          {/* Results list (virtual scroll) */}
          <div
            className="symbol-list-container"
            ref={listRef}
            onScroll={handleScroll}
            style={{ height: VISIBLE_ROWS * ROW_HEIGHT }}
          >
            {loading ? (
              <div className="symbol-list-empty">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="symbol-list-empty">无匹配结果</div>
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
                  {visibleItems.map((s) => (
                    <button
                      key={s.symbol}
                      className={`symbol-list-item ${s.symbol === currentSymbol ? "active" : ""}`}
                      style={{ height: ROW_HEIGHT }}
                      onClick={() => handleSelect(s.symbol)}
                    >
                      <span className="symbol-list-pair">{s.symbol}</span>
                      <span className="symbol-list-label">{formatPair(s)}</span>
                      {s.symbol === currentSymbol && (
                        <span className="symbol-list-check">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer: count */}
          <div className="symbol-list-footer">
            {filtered.length} 个交易对
          </div>
        </div>
      )}
    </div>
  );
}
