export type CacheTier = "cold" | "warm" | "visible" | "subscribed" | "active";

export interface CacheAccessEvent extends Record<string, unknown> {
  owner: string;
  key: string;
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
  action: string;
  source: string;
  weight: unknown;
  detail: Record<string, unknown>;
  occurredAtMs: number;
}

export interface CacheResource extends Record<string, unknown> {
  id: string;
  owner: string;
  key: string;
  registeredAtMs: number;
  lastSeenMs: number;
  type?: string;
  dependencyKey?: string;
  bars?: unknown;
}

export interface CacheLease extends Record<string, unknown> {
  owner: string;
  key: string;
  leaseId: string;
  detail: Record<string, unknown>;
  acquiredAtMs: number;
  lastSeenMs: number;
}

export interface CacheRegistrySnapshot {
  resources: CacheResource[];
  dependencies: Array<{ id: string; dependencies: string[] }>;
  leases: CacheLease[];
}

export interface BrowserHeapPressure extends Record<string, unknown> {
  available: boolean;
  source: string;
  estimatedBytes?: number;
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
  error?: string;
}

export interface BrowserStoragePressure extends Record<string, unknown> {
  available: boolean;
  source: string;
  usageBytes?: number;
  quotaBytes?: number;
  usageRatio?: number;
  error?: string;
}

export interface BrowserRuntimePressure {
  browserHeap: BrowserHeapPressure;
  browserStorage: BrowserStoragePressure;
}

export interface CacheDiagnosticsEntry extends Record<string, unknown> {
  owner?: string;
  key?: string;
  tier?: CacheTier | string;
  status?: string;
  bars?: unknown;
  points?: unknown;
  items?: unknown;
  estimatedBytes?: unknown;
  lastAccessMs?: unknown;
  lastUpdatedMs?: unknown;
  lastRealtimeMs?: unknown;
  dependencyState?: { orphan?: unknown; missingDependencies?: unknown };
  trimSafety?: { safeRangeTrim?: unknown };
  coverage?: { firstTime?: unknown; lastTime?: unknown };
  scores?: Partial<GcScores>;
}

export interface CacheDiagnostics extends Record<string, unknown> {
  generatedAtMs?: number;
  mode?: string;
  estimatedBytes?: unknown;
  klineBars?: unknown;
  indicatorPoints?: unknown;
  runtimePressure?: Partial<BrowserRuntimePressure>;
  owners?: {
    chart?: {
      entries?: CacheDiagnosticsEntry[];
      totalBars?: number;
      seriesCount?: number;
    };
    watchlist?: {
      entries?: CacheDiagnosticsEntry[];
      totalBars?: number;
      seriesCount?: number;
    };
    indicators?: {
      entries?: CacheDiagnosticsEntry[];
      totalPoints?: number;
      entryCount?: number;
    };
  };
}

export interface GcPolicy extends Record<string, unknown> {
  maxEstimatedBytes: number;
  maxIndicatorPoints: number;
  maxKlineBars: number;
  maxVictims: number;
  preserveActive: boolean;
  preserveSubscribed: boolean;
  nowMs?: unknown;
  frontendCacheBudgetBytes?: unknown;
  frontend_cache_budget_bytes?: unknown;
}

export interface GcPressure {
  klineBars: number;
  indicatorPoints: number;
  estimatedBytes: number;
}

export interface GcScores {
  gcValueScore: number;
  restoreCostScore: number;
  reuseProbabilityScore: number;
  pressureScore: number;
  finalEvictScore: number;
}

export interface GcCandidate extends CacheDiagnosticsEntry {
  owner: string;
  key: string;
  tier: CacheTier;
  category: "kline" | "indicator";
  bars: number;
  points: number;
  items: number;
  estimatedBytes: number;
  orphan?: boolean;
  scores: GcScores;
  matchedIntents: unknown[];
  restoreCostReason: string;
  reuseReason: string;
}

export interface GcVictim extends Record<string, unknown> {
  owner: string;
  key: string;
  tier: CacheTier;
  category: "kline" | "indicator";
  bars: number;
  points: number;
  items: number;
  estimatedBytes: number;
  action: "trim-range" | "delete-entry";
  keepStart: number | null;
  reason: string;
  scores: GcScores;
  matchedIntents: unknown[];
  lastAccessMs?: unknown;
  lastUpdatedMs?: unknown;
  lastRealtimeMs?: unknown;
  trimSafety?: { safeRangeTrim?: unknown };
  rangeSegments?: unknown;
}

export interface GcPlan extends Record<string, unknown> {
  generatedAtMs: number;
  mode: string;
  policy: GcPolicy;
  pressure: GcPressure;
  victims: GcVictim[];
  wouldFreeBars: number;
  wouldFreeIndicatorPoints: number;
  wouldFreeIndicatorItems: number;
  wouldFreeEstimatedBytes: number;
}

export interface CacheTrimOwnerResult extends Record<string, unknown> {
  owner?: string;
  removedCount?: number;
  removedBars?: number;
  removedIndicatorPoints?: number;
  removedIndicatorItems?: number;
  removedEstimatedBytes?: number;
}

export interface FrontendGcExecutionResult extends Record<string, unknown> {
  generatedAtMs: number;
  mode: "execute";
  status?: "skipped";
  sourcePlanGeneratedAtMs: number | null;
  removedCount: number;
  removedBars: number;
  removedIndicatorPoints: number;
  removedIndicatorItems: number;
  removedEstimatedBytes: number;
  ownerResults: CacheTrimOwnerResult[];
}

export interface AutoGcPolicy extends Record<string, unknown> {
  enabled: boolean;
  mode: string;
  cooldownMs: number;
  maxBytesPerRun: number;
  maxEntriesPerRun: number;
  minFinalEvictScore: number;
  neverEvictActiveWithinMs: number;
  neverEvictAccessedWithinMs: number;
  nowMs?: unknown;
}

export interface AutoGcPlan extends GcPlan {
  autoPolicy: AutoGcPolicy;
  victims: GcVictim[];
  autoSkipped: Array<{ key: string; reason: string; score: number }>;
}

export interface AutoGcRun {
  plan: AutoGcPlan;
  result: FrontendGcExecutionResult;
}
