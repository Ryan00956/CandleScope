import { useCallback, useEffect, useState } from "react";
import { fetchExchangeInfo, refreshExchangeInfo } from "../../services/api";
import { symbolKey } from "../../utils/symbolKey";

function enrichSymbols(symbols = []) {
  return symbols.map((symbol) => ({
    ...symbol,
    exchange: symbol.exchange || "binance",
    marketType: symbol.marketType || "spot",
    _key: symbolKey(symbol.symbol, symbol.marketType || "spot", symbol.exchange || "binance"),
  }));
}

export function useSymbolCatalogRuntime({ currentExchange = "binance", open }) {
  const [allSymbols, setAllSymbols] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open || allSymbols.length > 0) return undefined;

    let cancelled = false;
    setLoading(true);
    fetchExchangeInfo()
      .then((data) => {
        if (!cancelled && data?.symbols) {
          setAllSymbols(enrichSymbols(data.symbols));
        }
      })
      .catch((error) => console.warn("Failed to load exchange info:", error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [allSymbols.length, open]);

  const refreshSymbols = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshExchangeInfo(currentExchange);
      const data = await fetchExchangeInfo();
      if (data?.symbols) {
        setAllSymbols(enrichSymbols(data.symbols));
      }
    } catch (error) {
      console.warn("Refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
  }, [currentExchange]);

  return {
    allSymbols,
    loading,
    refreshing,
    refreshSymbols,
  };
}
