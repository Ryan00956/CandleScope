import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  IntervalCandidate,
  SubscriptionTier,
  WatchlistGroup,
} from "../watchlist/watchlistTypes.js";

export type FullCacheStatus = "idle" | "loading" | "warm" | "stale" | "partial" | "live" | "error";

export interface FullCacheCoverage {
  firstTime: number | null;
  lastTime: number | null;
  bars: number;
}

export interface FullCacheEntry {
  key: string;
  symbolKey: string;
  interval: string;
  rows: KlineBar[];
  status: FullCacheStatus;
  source: string;
  lastUpdatedMs: number;
  lastAccessMs: number | null;
  lastRealtimeMs: number | null;
  lastError: string | null;
  coverage: FullCacheCoverage | null;
}

export interface WarmCacheRow {
  rows: KlineBar[];
  status: FullCacheStatus;
  source: string;
  coverage: FullCacheCoverage | null;
  lastUpdatedMs: number;
}

export interface WatchlistSession {
  exchange?: string | null;
  marketType?: string | null;
  symbol?: string | null;
  symbolKey?: string | null;
  interval?: string | null;
}

export interface ExchangeIntervalCatalogEntry {
  nativeIntervals?: IntervalCandidate[];
}

export interface FullCacheTargetOptions {
  watchlists?: WatchlistGroup[];
  subscriptionTiers?: Record<string, SubscriptionTier>;
  exchangeCatalog?: Record<string, ExchangeIntervalCatalogEntry> | null;
  nativeIntervals?: IntervalCandidate[];
  customIntervalRecords?: IntervalCandidate[];
  currentSession?: WatchlistSession;
}

export interface FullCacheTarget {
  symbolKey: string;
  symbol: string;
  exchange: string;
  marketType: string;
  intervals: string[];
  preloadIntervals: string[];
}

export type FullCacheSocketTarget = Omit<FullCacheTarget, "preloadIntervals">;

export interface FullCachePreloadJob extends FullCacheTarget {
  interval: string;
}

export interface WarmRowsResolution extends WarmCacheRow {
  symbolKey: string;
  cacheState: "live" | "warm" | "stale" | "partial";
  source: string;
  needsRepair: boolean;
  tier?: "watchlist-full";
}

export interface InitialRowsResolution {
  rows: KlineBar[];
  tier: "watchlist-full" | "market-data-memory";
  cacheState: string;
  source: string;
  needsRepair: boolean;
  symbolKey?: string;
  status?: FullCacheStatus;
  coverage?: FullCacheCoverage | null;
  lastUpdatedMs?: number;
}
