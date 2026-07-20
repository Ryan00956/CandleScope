import { getFullSubscriptionIntervals } from "../watchlist/watchlistSubscriptionPolicy.js";
import {
  getBaseWsIntervals,
  getNativeIntervals,
} from "../chart-session/exchangeCatalogRuntime.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";
import type { IntervalCandidate, WatchlistGroup } from "../watchlist/watchlistTypes.js";
import type { NativeIntervalPurpose } from "../chart-session/chartSessionTypes.js";
import type {
  FullCachePreloadJob,
  FullCacheSocketTarget,
  FullCacheTarget,
  FullCacheTargetOptions,
} from "./watchlistFullCacheTypes.js";

const COMMON_PRELOAD_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const DEFAULT_PRELOAD_PER_SYMBOL = 8;
const DEFAULT_MAX_PRELOAD_JOBS = 16;

function uniqueWatchlistSymbols(watchlists: WatchlistGroup[] = []): string[] {
  return Array.from(new Set(watchlists.flatMap((watchlist) => watchlist.symbols || [])));
}

function getTargetNativeIntervals(
  exchange: string,
  marketType: string,
  purpose: NativeIntervalPurpose,
  currentSession: FullCacheTargetOptions["currentSession"],
  currentNativeIntervals: IntervalCandidate[],
  exchangeCatalog: FullCacheTargetOptions["exchangeCatalog"],
): IntervalCandidate[] {
  if (
    purpose === "history"
    && exchange === (currentSession?.exchange || "binance")
    && marketType === (currentSession?.marketType || "spot")
  ) return currentNativeIntervals;
  if (purpose === "realtime") {
    return getBaseWsIntervals(exchange, exchangeCatalog || null, marketType);
  }
  return getNativeIntervals(exchange, exchangeCatalog || null, marketType, purpose);
}

export function prioritizeFullCacheIntervals(
  intervals: string[],
  currentInterval: string | null | undefined,
  limit = DEFAULT_PRELOAD_PER_SYMBOL,
): string[] {
  const available = new Set<string>(intervals);
  const ordered: string[] = [];
  const push = (interval: string | null | undefined): void => {
    if (!interval || !available.has(interval) || ordered.includes(interval)) return;
    ordered.push(interval);
  };

  push(currentInterval);
  COMMON_PRELOAD_INTERVALS.forEach(push);
  intervals.forEach(push);
  return ordered.slice(0, limit);
}

function buildWatchlistFullTargets({
  watchlists = [],
  subscriptionTiers = {},
  exchangeCatalog = null,
  nativeIntervals = [],
  customIntervalRecords = [],
  currentSession = {},
}: FullCacheTargetOptions, purpose: NativeIntervalPurpose): FullCacheTarget[] {
  return uniqueWatchlistSymbols(watchlists)
    .filter((symbolKey) => subscriptionTiers?.[symbolKey] === "full")
    .map((symbolKey) => {
      const parsed = parseSymbolKey(symbolKey);
      const targetNativeIntervals = getTargetNativeIntervals(
        parsed.exchange,
        parsed.marketType,
        purpose,
        currentSession,
        nativeIntervals,
        exchangeCatalog,
      );
      const intervals = getFullSubscriptionIntervals({
        nativeIntervals: targetNativeIntervals,
        customIntervalRecords: targetNativeIntervals.length > 0 ? customIntervalRecords : [],
      });
      return {
        symbolKey,
        symbol: parsed.symbol,
        exchange: parsed.exchange,
        marketType: parsed.marketType,
        intervals,
        preloadIntervals: prioritizeFullCacheIntervals(
          intervals,
          symbolKey === currentSession.symbolKey ? currentSession.interval : null,
        ),
      };
    })
    .filter((target) => target.intervals.length > 0);
}

export function buildWatchlistFullCacheTargets(
  options: FullCacheTargetOptions = {},
): FullCacheTarget[] {
  return buildWatchlistFullTargets(options, "history");
}

export function buildWatchlistFullSocketTargets(
  options: FullCacheTargetOptions = {},
): FullCacheSocketTarget[] {
  const currentSession = options.currentSession || {};
  return buildWatchlistFullTargets({
    ...options,
    currentSession: {
      ...(currentSession.exchange === undefined ? {} : { exchange: currentSession.exchange }),
      interval: null,
      ...(currentSession.marketType === undefined ? {} : { marketType: currentSession.marketType }),
      symbol: null,
      symbolKey: null,
    },
  }, "realtime").map((target) => ({
    symbolKey: target.symbolKey,
    symbol: target.symbol,
    exchange: target.exchange,
    marketType: target.marketType,
    intervals: target.intervals,
  }));
}

export function buildFullCachePreloadJobs(targets: FullCacheTarget[], {
  currentSymbolKey = null,
  excludeSeries = null,
  maxJobs = DEFAULT_MAX_PRELOAD_JOBS,
}: {
  currentSymbolKey?: string | null;
  excludeSeries?: { symbolKey?: string | null; interval?: string | null } | null;
  maxJobs?: number;
} = {}): FullCachePreloadJob[] {
  const sortedTargets = [...targets].sort((left, right) => {
    if (left.symbolKey === currentSymbolKey) return -1;
    if (right.symbolKey === currentSymbolKey) return 1;
    return left.symbolKey.localeCompare(right.symbolKey);
  });
  const jobs: FullCachePreloadJob[] = [];
  for (const target of sortedTargets) {
    for (const interval of target.preloadIntervals) {
      if (
        excludeSeries?.symbolKey === target.symbolKey
        && excludeSeries.interval === interval
      ) continue;
      jobs.push({ ...target, interval });
      if (jobs.length >= maxJobs) return jobs;
    }
  }
  return jobs;
}
