import { useEffect, useRef } from "react";
import { symbolKey } from "../../utils/symbolKey.js";
import { getFullCacheEntry } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import type { FullCacheStatus } from "../watchlist-full-cache/watchlistFullCacheTypes.js";
import type { UseChartBackgroundPrefetchOptions } from "./marketDataTypes.js";
import {
  canonicalizeIntervalValue,
  intervalTiles,
  intervalsSemanticallyEquivalent,
  parseIntervalSeconds,
} from "../../utils/intervals.js";

const PREFETCH_DELAY_MS = 2_000;
const PREFETCH_INTERVAL_GAP_MS = 200;
const PREFETCH_BAR_LIMIT = 500;
export const PREFETCH_SOURCE_ROW_BUDGET = 10_000;
const PREFETCH_SOURCE_PADDING_BARS = 3;

export interface BackgroundPrefetchSkipInput {
  activeInterval: string;
  fullCacheRows?: number;
  fullCacheStatus?: FullCacheStatus | null;
  hasMemoryCache: boolean;
  inFlight: boolean;
  interval: string;
  nativeIntervals?: readonly string[];
  sourceRowBudget?: number;
  targetBarLimit?: number;
}

export function estimateBackgroundPrefetchSourceRows(
  interval: string,
  nativeIntervals: readonly string[],
  targetBarLimit = PREFETCH_BAR_LIMIT,
): number | null {
  const targetSeconds = parseIntervalSeconds(interval);
  if (!targetSeconds || targetBarLimit <= 0) return null;
  if (nativeIntervals.some((candidate) => (
    intervalsSemanticallyEquivalent(candidate, interval)
  ))) return targetBarLimit;

  const bestBaseSeconds = nativeIntervals.reduce((best, candidate) => {
    const candidateSeconds = parseIntervalSeconds(candidate);
    if (
      !candidateSeconds
      || candidateSeconds >= targetSeconds
      || !intervalTiles(candidate, interval)
    ) return best;
    return Math.max(best, candidateSeconds);
  }, 0);
  if (bestBaseSeconds <= 0) return null;

  const factor = Math.ceil(targetSeconds / bestBaseSeconds);
  return (targetBarLimit + PREFETCH_SOURCE_PADDING_BARS) * factor;
}

export class ChartBackgroundPrefetchAttemptLedger {
  private scopeKey = "";
  private readonly attemptedIntervals = new Set<string>();

  enterScope(scopeKey: string): void {
    if (scopeKey === this.scopeKey) return;
    this.scopeKey = scopeKey;
    this.attemptedIntervals.clear();
  }

  claimInterval(interval: string): boolean {
    const intervalKey = canonicalizeIntervalValue(interval) || interval.trim();
    if (!intervalKey || this.attemptedIntervals.has(intervalKey)) return false;
    this.attemptedIntervals.add(intervalKey);
    return true;
  }
}

export function shouldSkipChartBackgroundPrefetch({
  activeInterval,
  fullCacheRows = 0,
  fullCacheStatus = null,
  hasMemoryCache,
  inFlight,
  interval,
  nativeIntervals = [],
  sourceRowBudget = PREFETCH_SOURCE_ROW_BUDGET,
  targetBarLimit = PREFETCH_BAR_LIMIT,
}: BackgroundPrefetchSkipInput): boolean {
  if (intervalsSemanticallyEquivalent(interval, activeInterval) || hasMemoryCache || inFlight) return true;
  if (fullCacheStatus === "loading") return true;
  if (fullCacheRows > 0 && (fullCacheStatus === "warm" || fullCacheStatus === "live")) return true;
  if (nativeIntervals.length > 0) {
    const estimatedSourceRows = estimateBackgroundPrefetchSourceRows(
      interval,
      nativeIntervals,
      targetBarLimit,
    );
    if (estimatedSourceRows == null || estimatedSourceRows > sourceRowBudget) return true;
  }
  return false;
}

export function useChartBackgroundPrefetch({
  symbol,
  exchange,
  marketType,
  activeInterval,
  trackedIntervals,
  nativeIntervals,
  hasCache,
  seriesDataFeed,
  enabled = true,
}: UseChartBackgroundPrefetchOptions): void {
  const inFlightRef = useRef(new Set<string>());
  const attemptLedgerRef = useRef(new ChartBackgroundPrefetchAttemptLedger());

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const currentSymbolKey = symbolKey(symbol, marketType, exchange);
    attemptLedgerRef.current.enterScope(currentSymbolKey);

    const prefetch = async () => {
      for (const intv of trackedIntervals) {
        if (cancelled) break;
        const canonicalInterval = canonicalizeIntervalValue(intv) || intv;
        const key = `${currentSymbolKey}\u0000${canonicalInterval}`;
        const fullCacheEntry = getFullCacheEntry(currentSymbolKey, canonicalInterval);
        if (shouldSkipChartBackgroundPrefetch({
          activeInterval,
          fullCacheRows: fullCacheEntry?.rows.length || 0,
          fullCacheStatus: fullCacheEntry?.status || null,
          hasMemoryCache: hasCache(symbol, canonicalInterval, { marketType, exchange }),
          inFlight: inFlightRef.current.has(key),
          interval: canonicalInterval,
          nativeIntervals,
        })) continue;
        if (!attemptLedgerRef.current.claimInterval(canonicalInterval)) continue;

        inFlightRef.current.add(key);
        try {
          await seriesDataFeed.getLatest(
            { exchange, marketType, symbol, interval: canonicalInterval },
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
  }, [activeInterval, enabled, exchange, hasCache, marketType, nativeIntervals, seriesDataFeed, symbol, trackedIntervals]);
}
