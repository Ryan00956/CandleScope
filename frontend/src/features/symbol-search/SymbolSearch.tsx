import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { markPerf } from "../../runtime/performance/perfMarks";
import type { UseSymbolSearchRuntimeOptions, SymbolSelection } from "./useSymbolSearchRuntime.js";

export type SymbolSearchProps = Omit<
  UseSymbolSearchRuntimeOptions,
  "open" | "onClose"
>;

function loadSymbolSearchModal() {
  return import("./SymbolSearchModal");
}

const SymbolSearchModal = lazy(loadSymbolSearchModal);

export default function SymbolSearch({
  currentSymbol,
  currentMarketType,
  currentExchange = "binance",
  onSelect,
  exchangeCatalog,
  watchlists,
  onAddToWatchlist,
}: SymbolSearchProps) {
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => {
    markPerf("lazy.symbolSearch.open.start", { trigger: "button" });
    setOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSelect = useCallback((symbol: SymbolSelection) => {
    onSelect(symbol);
    setOpen(false);
  }, [onSelect]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "k") {
        event.preventDefault();
        setOpen((prev) => {
          if (!prev) markPerf("lazy.symbolSearch.open.start", { trigger: "keyboard" });
          return !prev;
        });
        return;
      }
      if (
        event.key === "/"
        && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")
      ) {
        event.preventDefault();
        markPerf("lazy.symbolSearch.open.start", { trigger: "keyboard" });
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <button
        className="symbol-selector"
        id="symbol-selector"
        onPointerEnter={loadSymbolSearchModal}
        onMouseOver={loadSymbolSearchModal}
        onMouseEnter={loadSymbolSearchModal}
        onFocus={loadSymbolSearchModal}
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

      {open && (
        <Suspense fallback={null}>
          <SymbolSearchModal
            open={open}
            onClose={handleClose}
            currentSymbol={currentSymbol}
            currentExchange={currentExchange}
            onSelect={handleSelect}
            {...(currentMarketType === undefined ? {} : { currentMarketType })}
            {...(exchangeCatalog === undefined ? {} : { exchangeCatalog })}
            {...(watchlists === undefined ? {} : { watchlists })}
            {...(onAddToWatchlist === undefined ? {} : { onAddToWatchlist })}
          />
        </Suspense>
      )}
    </>
  );
}
