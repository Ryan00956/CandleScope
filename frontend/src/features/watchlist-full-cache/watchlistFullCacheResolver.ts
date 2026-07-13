import { symbolKey } from "../../utils/symbolKey.js";
import { recordFrontendCacheAccess } from "../cache-gc/cacheAccessRuntime.js";
import { getWarmRows } from "./watchlistFullCacheStore.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { FullCacheStatus } from "./watchlistFullCacheTypes.js";
import type {
  InitialRowsResolution,
  WarmRowsResolution,
} from "./watchlistFullCacheTypes.js";

const LIVE_STATUSES = new Set(["live"]);
const WARM_STATUSES = new Set(["warm", "stale", "partial"]);

function isWarmStatus(
  status: FullCacheStatus,
): status is "warm" | "stale" | "partial" {
  return WARM_STATUSES.has(status);
}

export function resolveWatchlistWarmRows({
  symbol = "",
  interval = "",
  marketType = "spot",
  exchange = "binance",
}: {
  symbol?: string;
  interval?: string;
  marketType?: string;
  exchange?: string;
} = {}): WarmRowsResolution | null {
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

  if (isWarmStatus(warm.status)) {
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
  symbol = "",
  interval = "",
  marketType = "spot",
  exchange = "binance",
  getMemoryRows,
}: {
  symbol?: string;
  interval?: string;
  marketType?: string;
  exchange?: string;
  getMemoryRows?: ((symbol: string, interval: string) => KlineBar[] | null | undefined) | null;
} = {}): InitialRowsResolution | null {
  const warm = resolveWatchlistWarmRows({
    symbol,
    interval,
    marketType,
    exchange,
  });
  if (warm) {
    recordFrontendCacheAccess({
      owner: "watchlist-full-cache",
      key: warm.symbolKey || symbolKey(symbol, marketType, exchange),
      exchange,
      marketType,
      symbol,
      interval,
      action: "frontend-full-cache-hit",
      source: warm.source || "watchlist-full",
    });
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
