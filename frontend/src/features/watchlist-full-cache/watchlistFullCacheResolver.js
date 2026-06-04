import { symbolKey } from "../../utils/symbolKey.js";
import { getWarmRows } from "./watchlistFullCacheStore.js";

const LIVE_STATUSES = new Set(["live"]);
const WARM_STATUSES = new Set(["warm", "stale", "partial"]);

export function resolveWatchlistWarmRows({
  symbol,
  interval,
  marketType = "spot",
  exchange = "binance",
} = {}) {
  const key = symbolKey(symbol, marketType, exchange);
  const warm = getWarmRows(key, interval);
  if (!warm?.rows?.length) return null;

  if (LIVE_STATUSES.has(warm.status)) {
    return {
      ...warm,
      symbolKey: key,
      cacheState: "live",
      source: `watchlist-full-${warm.source || "live"}`,
      needsRepair: false,
    };
  }

  if (WARM_STATUSES.has(warm.status)) {
    return {
      ...warm,
      symbolKey: key,
      cacheState: warm.status,
      source: `watchlist-full-${warm.source || warm.status}`,
      needsRepair: warm.status !== "warm",
    };
  }

  return null;
}

export function resolveInitialRows({
  symbol,
  interval,
  marketType,
  exchange,
  getMemoryRows,
} = {}) {
  const warm = resolveWatchlistWarmRows({
    symbol,
    interval,
    marketType,
    exchange,
  });
  if (warm) {
    return {
      ...warm,
      tier: "watchlist-full",
    };
  }

  const memoryRows = getMemoryRows?.(symbol, interval);
  if (memoryRows?.length) {
    return {
      rows: memoryRows,
      tier: "market-data-memory",
      cacheState: "memory",
      source: "memory-cache-hit",
      needsRepair: false,
    };
  }

  return null;
}
