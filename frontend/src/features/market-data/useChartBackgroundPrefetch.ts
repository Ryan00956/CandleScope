import { useEffect, useRef } from "react";
import { symbolKey } from "../../utils/symbolKey.js";
import { getFullCacheEntry } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import type { FullCacheStatus } from "../watchlist-full-cache/watchlistFullCacheTypes.js";
import type { UseChartBackgroundPrefetchOptions } from "./marketDataTypes.js";

const PREFETCH_DELAY_MS = 2_000;
const PREFETCH_INTERVAL_GAP_MS = 200;
const PREFETCH_BAR_LIMIT = 500;

export interface BackgroundPrefetchSkipInput {
  activeInterval: string;
  fullCacheRows?: number;
  fullCacheStatus?: FullCacheStatus | null;
  hasMemoryCache: boolean;
  inFlight: boolean;
  interval: string;
}

export function shouldSkipChartBackgroundPrefetch({
  activeInterval,
  fullCacheRows = 0,
  fullCacheStatus = null,
  hasMemoryCache,
  inFlight,
  interval,
}: BackgroundPrefetchSkipInput): boolean {
  if (interval === activeInterval || hasMemoryCache || inFlight) return true;
  if (fullCacheStatus === "loading") return true;
  return fullCacheRows > 0 && (fullCacheStatus === "warm" || fullCacheStatus === "live");
}

export function useChartBackgroundPrefetch({
  symbol,
  exchange,
  marketType,
  activeInterval,
  trackedIntervals,
  hasCache,
  seriesDataFeed,
  enabled = true,
}: UseChartBackgroundPrefetchOptions): void {
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const currentSymbolKey = symbolKey(symbol, marketType, exchange);

    const prefetch = async () => {
      for (const intv of trackedIntervals) {
        if (cancelled) break;
        const key = `${currentSymbolKey}\u0000${intv}`;
        const fullCacheEntry = getFullCacheEntry(currentSymbolKey, intv);
        if (shouldSkipChartBackgroundPrefetch({
          activeInterval,
          fullCacheRows: fullCacheEntry?.rows.length || 0,
          fullCacheStatus: fullCacheEntry?.status || null,
          hasMemoryCache: hasCache(symbol, intv, { marketType, exchange }),
          inFlight: inFlightRef.current.has(key),
          interval: intv,
        })) continue;

        inFlightRef.current.add(key);
        try {
          await seriesDataFeed.getLatest(
            { exchange, marketType, symbol, interval: intv },
            {
              limit: PREFETCH_BAR_LIMIT,
              source: "background-prefetch",
              apiSource: "background-prefetch",
              commit: "cache",
              signal: controller.signal,
            },
          );
          if (cancelled) break;
        } catch {
          // Best-effort warming only; active interval loading owns user-visible errors.
        } finally {
          inFlightRef.current.delete(key);
        }

        await new Promise((resolve) => setTimeout(resolve, PREFETCH_INTERVAL_GAP_MS));
      }
    };

    const timer = setTimeout(prefetch, PREFETCH_DELAY_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeInterval, enabled, exchange, hasCache, marketType, seriesDataFeed, symbol, trackedIntervals]);
}
