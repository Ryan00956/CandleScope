import { QUOTE_CHIPS } from "./symbolSearchFilter";
import { useSymbolSearchRuntime } from "./useSymbolSearchRuntime";
import type { UseSymbolSearchRuntimeOptions } from "./useSymbolSearchRuntime.js";

export type SymbolSearchModalProps = UseSymbolSearchRuntimeOptions;

export default function SymbolSearchModal(props: SymbolSearchModalProps) {
  const runtime = useSymbolSearchRuntime(props);
  const { view, actions, status, refs } = runtime;
  const { inputRef, listRef, modalRef } = refs;
  const {
    search,
    marketType,
    exchangeFilter,
    quoteFilter,
    favorites,
    favoriteSet,
    exchangeChips,
    marketTabs,
    filteredSymbols,
    highlightIndex,
    contextMenu,
    hasWatchlists,
    virtualRows,
  } = view;
  const {
    setSearch,
    setMarketType,
    setQuoteFilter,
    setHighlightIndex,
    toggleExchange,
    toggleFavorite,
    selectSymbol,
    openContextMenu,
    addContextSymbolToWatchlist,
    getSymbolWatchlists,
    handleKeyDown,
    handleScroll,
    refreshSymbols,
  } = actions;
  const {
    open,
    onClose,
    currentSymbol,
    currentMarketType,
    currentExchange = "binance",
    watchlists,
  } = props;

  if (!open) return null;

  return (
    <div className="sym-modal-overlay" onClick={onClose}>
      <div
        className="sym-modal"
        ref={modalRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
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
              onChange={(event) => setSearch(event.target.value)}
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

        <div className="sym-modal-filters">
          <div className="sym-modal-filter-row">
            <div className="sym-modal-market-tabs">
              {marketTabs.map((tab) => (
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

          <div className="sym-modal-filter-row sym-modal-filter-row-chips">
            <div className="sym-modal-chip-group">
              <span className="sym-modal-chip-label">交易所</span>
              {exchangeChips.map((exchange) => (
                <button
                  key={exchange.key}
                  className={`sym-modal-chip ${exchangeFilter.has(exchange.key) ? "active" : ""}`}
                  onClick={() => toggleExchange(exchange.key)}
                >
                  {exchange.label}
                  {exchangeFilter.has(exchange.key) && <span className="sym-modal-chip-check">✓</span>}
                </button>
              ))}
            </div>

            <div className="sym-modal-chip-divider" />

            <div className="sym-modal-chip-group">
              <span className="sym-modal-chip-label">计价</span>
              {QUOTE_CHIPS.map((quote) => (
                <button
                  key={quote}
                  className={`sym-modal-chip ${quoteFilter === quote ? "active" : ""}`}
                  onClick={() => setQuoteFilter(quote)}
                >
                  {quote}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="sym-modal-table-header">
          <span className="sym-modal-col-fav" />
          <span className="sym-modal-col-pair">交易对</span>
          <span className="sym-modal-col-base">基础资产</span>
          <span className="sym-modal-col-quote">计价资产</span>
          <span className="sym-modal-col-type">类型</span>
          <span className="sym-modal-col-exchange">交易所</span>
        </div>

        <div
          className="sym-modal-list"
          ref={listRef}
          onScroll={handleScroll}
          style={{ height: virtualRows.listHeight }}
        >
          {status.loading ? (
            <div className="sym-modal-empty">
              <div className="sym-modal-spinner" />
              <span>加载交易对数据...</span>
            </div>
          ) : filteredSymbols.length === 0 ? (
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
            <div style={{ height: virtualRows.totalHeight, position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  top: virtualRows.offsetY,
                  left: 0,
                  right: 0,
                }}
              >
                {virtualRows.visibleItems.map((symbol, index) => {
                  const realIndex = virtualRows.startIndex + index;
                  const isHighlighted = realIndex === highlightIndex;
                  const isCurrent = (
                    symbol.symbol === currentSymbol
                    && symbol.marketType === (currentMarketType || "spot")
                    && (symbol.exchange || "binance") === (currentExchange || "binance")
                  );
                  const isFavorite = favoriteSet.has(symbol._key);
                  const inWatchlists = getSymbolWatchlists(symbol._key);

                  return (
                    <div
                      key={symbol._key}
                      className={`sym-modal-row ${isHighlighted ? "highlighted" : ""} ${isCurrent ? "current" : ""}`}
                      style={{ height: virtualRows.rowHeight }}
                      onClick={() => selectSymbol(symbol)}
                      onMouseEnter={() => setHighlightIndex(realIndex)}
                      onContextMenu={(event) => openContextMenu(event, symbol.symbol, symbol._key)}
                    >
                      <button
                        className={`sym-modal-fav-btn ${isFavorite ? "active" : ""}`}
                        onClick={(event) => toggleFavorite(symbol._key, event)}
                        title={isFavorite ? "取消收藏" : "添加收藏"}
                      >
                        {isFavorite ? "★" : "☆"}
                      </button>
                      <span className="sym-modal-col-pair sym-modal-row-pair">
                        {symbol.symbol}
                        {isCurrent && <span className="sym-modal-current-tag">当前</span>}
                        {hasWatchlists && inWatchlists.length > 0 && (
                          <span className="sym-modal-wl-indicators">
                            {inWatchlists.map((watchlist) => (
                              <span
                                key={watchlist.id}
                                className="sym-modal-wl-dot"
                                style={{ background: watchlist.color || "#3b82f6" }}
                                title={`在列表: ${watchlist.name}`}
                              />
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="sym-modal-col-base sym-modal-row-base">{symbol.baseAsset}</span>
                      <span className="sym-modal-col-quote sym-modal-row-quote">{symbol.quoteAsset}</span>
                      <span className="sym-modal-col-type sym-modal-row-type">
                        <span className={`sym-modal-type-badge ${symbol.marketType}`}>
                          {symbol.marketType === "spot" ? "现货" : "合约"}
                        </span>
                      </span>
                      <span className="sym-modal-col-exchange sym-modal-row-exchange">
                        {(symbol.exchange || "binance").charAt(0).toUpperCase() + (symbol.exchange || "binance").slice(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="sym-modal-footer">
          <div className="sym-modal-footer-left">
            <span className="sym-modal-result-count">
              {filteredSymbols.length.toLocaleString()} 个交易对
            </span>
            <span className="sym-modal-shortcut-hint">
              <kbd>↑</kbd><kbd>↓</kbd> 导航 · <kbd>Enter</kbd> 选择 · <kbd>Esc</kbd> 关闭
              {hasWatchlists && " · 右键添加到自选列表"}
            </span>
          </div>
          <button
            className="sym-modal-refresh-btn"
            onClick={refreshSymbols}
            disabled={status.refreshing}
            title="刷新交易所数据"
          >
            <span className={`sym-modal-refresh-icon ${status.refreshing ? "spinning" : ""}`}>⟳</span>
            {status.refreshing ? "刷新中..." : "刷新数据"}
          </button>
        </div>
      </div>

      {contextMenu && hasWatchlists && (
        <div
          className="sym-ctx-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="sym-ctx-header">
            <span className="sym-ctx-header-symbol">{contextMenu.symbol}</span>
            <span className="sym-ctx-header-label">添加到自选列表</span>
          </div>
          <div className="sym-ctx-items">
            {(watchlists || []).map((watchlist) => {
              const alreadyIn = watchlist.symbols.includes(contextMenu._key);
              return (
                <button
                  key={watchlist.id}
                  className={`sym-ctx-item ${alreadyIn ? "already-in" : ""}`}
                  onClick={() => {
                    if (!alreadyIn) {
                      addContextSymbolToWatchlist(watchlist.id);
                    }
                  }}
                  disabled={alreadyIn}
                >
                  <span className="sym-ctx-dot" style={{ background: watchlist.color || "#3b82f6" }} />
                  <span className="sym-ctx-name">{watchlist.name}</span>
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
