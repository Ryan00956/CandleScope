import { useCallback, useEffect, useState } from "react";
import SymbolSearchModal from "./SymbolSearchModal";

/**
 * SymbolSearch — trigger button + full-screen search modal.
 *
 * Renders a compact symbol selector button in the top bar.
 * Clicking it (or pressing Ctrl+K / /) opens a large centered
 * modal with advanced search & filtering capabilities.
 *
 * Now also passes watchlists to the modal so users can right-click
 * to add symbols to their watchlist folders.
 */
export default function SymbolSearch({
  currentSymbol, currentMarketType, currentExchange = "binance", onSelect,
  watchlists, onAddToWatchlist,
}) {
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSelect = useCallback(
    (sym) => {
      onSelect(sym);
      setOpen(false);
    },
    [onSelect],
  );

  // ── Global keyboard shortcut: Ctrl+K or / ──
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+K (or Cmd+K on Mac)
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      // "/" key — only when no input/textarea is focused
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      {/* Trigger button — shows current symbol in the top bar */}
      <button
        className="symbol-selector"
        id="symbol-selector"
        onClick={handleOpen}
        title="搜索交易对 (Ctrl+K)"
      >
        <span className="symbol-name">{currentSymbol}</span>
        {currentMarketType === "futures" && (
          <span className="symbol-market-badge futures">合约</span>
        )}
        <span className="symbol-exchange">
          {currentExchange.charAt(0).toUpperCase() + currentExchange.slice(1)}
        </span>
        <span className="symbol-shortcut-badge">
          <kbd>Ctrl</kbd><kbd>K</kbd>
        </span>
      </button>

      {/* Full-screen search modal */}
      <SymbolSearchModal
        open={open}
        onClose={handleClose}
        currentSymbol={currentSymbol}
        currentMarketType={currentMarketType}
        currentExchange={currentExchange}
        onSelect={handleSelect}
        watchlists={watchlists}
        onAddToWatchlist={onAddToWatchlist}
      />
    </>
  );
}
