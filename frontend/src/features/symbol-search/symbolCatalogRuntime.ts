import { useCallback, useEffect, useState } from "react";
import { fetchExchangeInfo, refreshExchangeInfo } from "../../services/api";
import { symbolKey } from "../../utils/symbolKey";
import type { SymbolSearchItem } from "./symbolSearchTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function symbolList(payload: unknown): unknown[] | null {
  return isRecord(payload) && Array.isArray(payload.symbols) ? payload.symbols : null;
}

export function enrichSymbols(symbols: unknown = []): SymbolSearchItem[] {
  if (!Array.isArray(symbols)) return [];
  return symbols.flatMap((value) => {
    if (!isRecord(value)) return [];
    const symbol = stringField(value, "symbol");
    if (!symbol) return [];
    const exchange = stringField(value, "exchange", "binance") || "binance";
    const marketType = stringField(value, "marketType", "spot") || "spot";
    return [{
      ...value,
      symbol,
      baseAsset: stringField(value, "baseAsset"),
      quoteAsset: stringField(value, "quoteAsset"),
      exchange,
      marketType,
      _key: symbolKey(symbol, marketType, exchange),
    }];
  });
}

export interface SymbolCatalogRuntime {
  allSymbols: SymbolSearchItem[];
  loading: boolean;
  refreshing: boolean;
  refreshSymbols(): Promise<void>;
}

export function useSymbolCatalogRuntime({
  currentExchange = "binance",
  open,
}: {
  currentExchange?: string;
  open: boolean;
}): SymbolCatalogRuntime {
  const [allSymbols, setAllSymbols] = useState<SymbolSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open || allSymbols.length > 0) return undefined;

    let cancelled = false;
    setLoading(true);
    fetchExchangeInfo()
      .then((data) => {
        const symbols = symbolList(data);
        if (!cancelled && symbols) {
          setAllSymbols(enrichSymbols(symbols));
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
      const symbols = symbolList(data);
      if (symbols) {
        setAllSymbols(enrichSymbols(symbols));
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
