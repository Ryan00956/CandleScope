import { getFullSubscriptionIntervals } from "../watchlist/watchlistSubscriptionPolicy.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";

const COMMON_PRELOAD_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const DEFAULT_PRELOAD_PER_SYMBOL = 8;
const DEFAULT_MAX_PRELOAD_JOBS = 16;

function uniqueWatchlistSymbols(watchlists = []) {
  return Array.from(new Set(watchlists.flatMap((watchlist) => watchlist.symbols || [])));
}

function getTargetNativeIntervals(exchange, currentExchange, currentNativeIntervals, exchangeCatalog) {
  if (exchange === currentExchange) return currentNativeIntervals;
  return exchangeCatalog?.[exchange]?.nativeIntervals || [];
}

export function prioritizeFullCacheIntervals(intervals, currentInterval, limit = DEFAULT_PRELOAD_PER_SYMBOL) {
  const available = new Set(intervals);
  const ordered = [];
  const push = (interval) => {
    if (!interval || !available.has(interval) || ordered.includes(interval)) return;
    ordered.push(interval);
  };

  push(currentInterval);
  COMMON_PRELOAD_INTERVALS.forEach(push);
  intervals.forEach(push);
  return ordered.slice(0, limit);
}

export function buildWatchlistFullCacheTargets({
  watchlists = [],
  subscriptionTiers = {},
  exchangeCatalog = null,
  nativeIntervals = [],
  customIntervalRecords = [],
  currentSession = {},
} = {}) {
  return uniqueWatchlistSymbols(watchlists)
    .filter((symbolKey) => subscriptionTiers?.[symbolKey] === "full")
    .map((symbolKey) => {
      const parsed = parseSymbolKey(symbolKey);
      const targetNativeIntervals = getTargetNativeIntervals(
        parsed.exchange,
        currentSession.exchange,
        nativeIntervals,
        exchangeCatalog,
      );
      const intervals = getFullSubscriptionIntervals({
        nativeIntervals: targetNativeIntervals,
        customIntervalRecords,
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

export function buildWatchlistFullSocketTargets(options = {}) {
  const currentSession = options.currentSession || {};
  return buildWatchlistFullCacheTargets({
    ...options,
    currentSession: {
      exchange: currentSession.exchange,
      interval: null,
      marketType: currentSession.marketType,
      symbol: null,
      symbolKey: null,
    },
  }).map((target) => ({
    symbolKey: target.symbolKey,
    symbol: target.symbol,
    exchange: target.exchange,
    marketType: target.marketType,
    intervals: target.intervals,
  }));
}

export function buildFullCachePreloadJobs(targets, {
  currentSymbolKey = null,
  maxJobs = DEFAULT_MAX_PRELOAD_JOBS,
} = {}) {
  const sortedTargets = [...targets].sort((left, right) => {
    if (left.symbolKey === currentSymbolKey) return -1;
    if (right.symbolKey === currentSymbolKey) return 1;
    return left.symbolKey.localeCompare(right.symbolKey);
  });
  const jobs = [];
  for (const target of sortedTargets) {
    for (const interval of target.preloadIntervals) {
      jobs.push({ ...target, interval });
      if (jobs.length >= maxJobs) return jobs;
    }
  }
  return jobs;
}
