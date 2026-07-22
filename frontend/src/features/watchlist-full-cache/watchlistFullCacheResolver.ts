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
  const memoryRows = getMemoryRows?.(symbol, interval);
  const warm = resolveWatchlistWarmRows({
    symbol,
    interval,
    marketType,
    exchange,
  });
  const memoryLastTime = Number(memoryRows?.at(-1)?.time);
  const warmLastTime = Number(warm?.rows?.at(-1)?.time);
  const warmCanSupersedeMemory = Boolean(
    memoryRows?.length
    && warm?.rows?.length
    && !warm.needsRepair
    && warm.rows.length > memoryRows.length
    && Number.isFinite(memoryLastTime)
    && Number.isFinite(warmLastTime)
    && warmLastTime >= memoryLastTime
  );

  // The chart-owned window is the highest-fidelity hot-switch source. A
  // watchlist entry is often only a short keepalive tail; replacing a complete
  // chart window with that sparse tail makes A -> B -> A look like a cold load.
  // Still allow a materially fuller watchlist window to seed/repair a sparse
  // chart cache.
  if (memoryRows?.length && !warmCanSupersedeMemory) {
    return {
      rows: memoryRows,
      tier: "market-data-memory",
      cacheState: "memory",
      source: "memory-cache-hit",
      needsRepair: false,
    };
  }

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
