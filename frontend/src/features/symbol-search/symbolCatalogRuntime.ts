import { useCallback, useEffect, useState } from "react";
import { fetchExchangeInfo, refreshExchangeInfo } from "../../services/api";
import { symbolKey } from "../../utils/symbolKey";
import {
  sharedSymbolCatalogClientCache,
  type SymbolCatalogRequest,
} from "./symbolCatalogClientCache";
import type { SymbolSearchItem } from "./symbolSearchTypes.js";

const SYMBOL_CATALOG_RETRY_BASE_MS = 1_000;
const SYMBOL_CATALOG_RETRY_MAX_MS = 15_000;
const EMPTY_EXCHANGE_SET: ReadonlySet<string> = new Set();

export function symbolCatalogRetryDelayMs(
  attempt: number,
  retryAtMs: number | null = null,
  nowMs = Date.now(),
): number {
  const exponentialDelay = Math.min(
    SYMBOL_CATALOG_RETRY_MAX_MS,
    SYMBOL_CATALOG_RETRY_BASE_MS * (2 ** Math.max(0, Math.min(4, attempt))),
  );
  const serverDelay = retryAtMs == null ? 0 : Math.max(0, retryAtMs - nowMs);
  return Math.max(exponentialDelay, serverDelay);
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

export function symbolCatalogRetryAtMs(value: unknown): number | null {
  if (typeof value === "string") {
    try {
      return symbolCatalogRetryAtMs(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const direct = Number(value.retry_at_ms);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const detail = symbolCatalogRetryAtMs(value.detail);
  if (detail != null) return detail;
  if (!isRecord(value.markets)) return null;
  const marketRetryTimes = Object.values(value.markets)
    .map((market) => symbolCatalogRetryAtMs(market))
    .filter((retryAt): retryAt is number => retryAt != null);
  return marketRetryTimes.length > 0 ? Math.max(...marketRetryTimes) : null;
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
  requestedMarketType = "spot",
  requestedExchanges,
  providerSearch = "",
  queryOnlyExchanges = EMPTY_EXCHANGE_SET,
  open,
}: {
  currentExchange?: string;
  requestedMarketType?: string;
  requestedExchanges?: ReadonlySet<string>;
  providerSearch?: string;
  queryOnlyExchanges?: ReadonlySet<string>;
  open: boolean;
}): SymbolCatalogRuntime {
  const exchangeRequestKey = Array.from(
    requestedExchanges?.size ? requestedExchanges : [currentExchange],
  )
    .map((exchange) => exchange.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
  const marketRequestKey = requestedMarketType.trim().toLowerCase();
  const queryOnlyRequestKey = Array.from(queryOnlyExchanges)
    .map((exchange) => exchange.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
  const providerSearchKey = exchangeRequestKey
    .split(",")
    .some((exchange) => queryOnlyExchanges.has(exchange))
    ? providerSearch.trim()
    : "";
  const initialRequests = exchangeRequestKey.split(",").filter(Boolean).map((exchange) => ({
    exchange,
    marketType: marketRequestKey,
  }));
  const [allSymbols, setAllSymbols] = useState<SymbolSearchItem[]>(() => (
    sharedSymbolCatalogClientCache.readAll()
  ));
  const [loading, setLoading] = useState(() => (
    open && sharedSymbolCatalogClientCache.shouldBlock(initialRequests)
  ));
  const [refreshing, setRefreshing] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let activeControllers: AbortController[] = [];
    let attempt = 0;
    const requests: SymbolCatalogRequest[] = exchangeRequestKey
      .split(",")
      .filter(Boolean)
      .map((exchange) => ({ exchange, marketType: marketRequestKey }));

    const load = async () => {
      if (cancelled) return;
      setLoading(sharedSymbolCatalogClientCache.shouldBlock(requests));
      activeControllers = requests.map(() => new AbortController());
      try {
        const responses = await Promise.allSettled(
          requests.map(async (request, index) => ({
            request,
            data: await fetchExchangeInfo(request.marketType, request.exchange, {
              signal: activeControllers[index]!.signal,
              ...(queryOnlyExchanges.has(request.exchange)
                ? { search: providerSearchKey }
                : {}),
            }),
          })),
        );
        if (cancelled) return;

        let retryNeeded = false;
        const retryAtTimes: number[] = [];
        for (let index = 0; index < responses.length; index += 1) {
          const result = responses[index]!;
          const request = requests[index]!;
          const retryAtMs = symbolCatalogRetryAtMs(
            result.status === "fulfilled" ? result.value.data : result.reason,
          );
          if (retryAtMs != null) retryAtTimes.push(retryAtMs);
          if (result.status === "rejected") {
            sharedSymbolCatalogClientCache.rememberAttempt(request);
            retryNeeded = true;
            continue;
          }
          const enriched = enrichSymbols(symbolList(result.value.data) || []);
          sharedSymbolCatalogClientCache.remember(request, enriched);
          if (symbolCatalogNeedsRetry(result.value.data)) retryNeeded = true;
        }
        setAllSymbols(sharedSymbolCatalogClientCache.readAll());
        if (!retryNeeded) return;
        if (sharedSymbolCatalogClientCache.read(requests).length > 0) {
          console.warn("Exchange symbol catalog is partial or stale; retrying");
        } else {
          console.warn("Exchange symbol catalog returned no usable symbols; retrying");
        }
        const retryAtMs = retryAtTimes.length > 0 ? Math.max(...retryAtTimes) : null;
        const delay = symbolCatalogRetryDelayMs(attempt, retryAtMs);
        attempt += 1;
        retryTimer = setTimeout(() => { void load(); }, delay);
      } catch (error) {
        if (!cancelled) {
          for (const request of requests) {
            sharedSymbolCatalogClientCache.rememberAttempt(request);
          }
          setAllSymbols(sharedSymbolCatalogClientCache.readAll());
          console.warn("Failed to load exchange info; retrying:", error);
          const delay = symbolCatalogRetryDelayMs(attempt, symbolCatalogRetryAtMs(error));
          attempt += 1;
          retryTimer = setTimeout(() => { void load(); }, delay);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const initialDelay = providerSearchKey ? 250 : 0;
    retryTimer = setTimeout(() => { void load(); }, initialDelay);

    return () => {
      cancelled = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      for (const controller of activeControllers) controller.abort();
    };
  }, [
    exchangeRequestKey,
    marketRequestKey,
    open,
    providerSearchKey,
    queryOnlyExchanges,
    queryOnlyRequestKey,
    retryEpoch,
  ]);

  const refreshSymbols = useCallback(async () => {
    const selectedExchange = exchangeRequestKey.split(",")[0] || currentExchange;
    setRefreshing(true);
    try {
      const queryOnly = queryOnlyExchanges.has(selectedExchange);
      if (!queryOnly) {
        await refreshExchangeInfo(selectedExchange, marketRequestKey);
      }
      const data = await fetchExchangeInfo(marketRequestKey, selectedExchange, {
        ...(queryOnly ? { search: providerSearchKey } : {}),
      });
      const symbols = symbolList(data);
      if (symbols) {
        const enriched = enrichSymbols(symbols);
        sharedSymbolCatalogClientCache.remember({
          exchange: selectedExchange,
          marketType: marketRequestKey,
        }, enriched);
        setAllSymbols(sharedSymbolCatalogClientCache.readAll());
        if (symbolCatalogNeedsRetry(data)) {
          setRetryEpoch((value) => value + 1);
        }
      }
    } catch (error) {
      console.warn("Refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
  }, [
    currentExchange,
    exchangeRequestKey,
    marketRequestKey,
    providerSearchKey,
    queryOnlyExchanges,
  ]);

  return {
    allSymbols,
    loading,
    refreshing,
    refreshSymbols,
  };
}
