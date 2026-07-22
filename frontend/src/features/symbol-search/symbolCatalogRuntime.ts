import { useCallback, useEffect, useState } from "react";
import { fetchExchangeInfo, refreshExchangeInfo } from "../../services/api";
import { symbolKey } from "../../utils/symbolKey";
import type { SymbolSearchItem } from "./symbolSearchTypes.js";

const SYMBOL_CATALOG_RETRY_BASE_MS = 1_000;
const SYMBOL_CATALOG_RETRY_MAX_MS = 15_000;

export function symbolCatalogRetryDelayMs(attempt: number): number {
  return Math.min(
    SYMBOL_CATALOG_RETRY_MAX_MS,
    SYMBOL_CATALOG_RETRY_BASE_MS * (2 ** Math.max(0, Math.min(4, attempt))),
  );
}

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

export function symbolCatalogNeedsRetry(payload: unknown): boolean {
  if (!isRecord(payload)) return true;
  if (payload.stale === true) return true;
  if (!isRecord(payload.markets)) return false;
  return Object.values(payload.markets).some((value) => (
    isRecord(value) && (value.stale === true || value.refreshing === true)
  ));
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
  const [retryEpoch, setRetryEpoch] = useState(0);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const load = async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const data = await fetchExchangeInfo();
        const symbols = symbolList(data);
        const enriched = enrichSymbols(symbols || []);
        if (cancelled) return;
        if (enriched.length > 0) {
          setAllSymbols(enriched);
          if (!symbolCatalogNeedsRetry(data)) return;
          console.warn("Exchange symbol catalog is partial or stale; retrying");
        } else {
          console.warn("Exchange symbol catalog returned no usable symbols; retrying");
        }
      } catch (error) {
        if (!cancelled) console.warn("Failed to load exchange info; retrying:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (cancelled) return;
      const delay = symbolCatalogRetryDelayMs(attempt);
      attempt += 1;
      retryTimer = setTimeout(() => { void load(); }, delay);
    };

    void load();

    return () => {
      cancelled = true;
      if (retryTimer != null) clearTimeout(retryTimer);
    };
  }, [open, retryEpoch]);

  const refreshSymbols = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshExchangeInfo(currentExchange);
      const data = await fetchExchangeInfo();
      const symbols = symbolList(data);
      if (symbols) {
        setAllSymbols(enrichSymbols(symbols));
        if (symbolCatalogNeedsRetry(data)) {
          setRetryEpoch((value) => value + 1);
        }
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
