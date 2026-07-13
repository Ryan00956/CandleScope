import { trimIndicatorResultCacheEntries } from "../indicators/indicatorResultCacheStore.js";
import { trimWatchlistFullCacheEntries } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import type {
  CacheTrimOwnerResult,
  FrontendGcExecutionResult,
  GcPlan,
  GcVictim,
} from "./cacheGcTypes.js";

type ChartTrimFunction = (victims: GcVictim[]) => CacheTrimOwnerResult;

function byOwner(victims: GcVictim[] = []): Record<string, GcVictim[]> {
  return victims.reduce<Record<string, GcVictim[]>>((groups, victim) => {
    if (!victim?.owner) return groups;
    if (!groups[victim.owner]) groups[victim.owner] = [];
    groups[victim.owner].push(victim);
    return groups;
  }, {});
}

export function executeFrontendGcPlan(plan: GcPlan | null | undefined, {
  trimChartDataCacheEntries = null,
}: { trimChartDataCacheEntries?: ChartTrimFunction | null } = {}): FrontendGcExecutionResult {
  const victims = plan?.victims || [];
  const groups = byOwner(victims);
  const chartResult: CacheTrimOwnerResult = typeof trimChartDataCacheEntries === "function"
    ? trimChartDataCacheEntries(groups["chart-data-cache"] || [])
    : {
        owner: "chart-data-cache",
        removedCount: 0,
        removedBars: 0,
        removedEstimatedBytes: 0,
        skipped: groups["chart-data-cache"]?.map((victim) => ({
          key: victim.key,
          reason: "chart-trim-unavailable",
        })) || [],
        removed: [],
      };
  const watchlistResult: CacheTrimOwnerResult = trimWatchlistFullCacheEntries(
    groups["watchlist-full-cache"] || [],
  );
  const indicatorResult: CacheTrimOwnerResult = trimIndicatorResultCacheEntries(
    groups["indicator-result-cache"] || [],
  );
  const ownerResults: CacheTrimOwnerResult[] = [chartResult, watchlistResult, indicatorResult];

  return {
    generatedAtMs: Date.now(),
    mode: "execute",
    sourcePlanGeneratedAtMs: plan?.generatedAtMs || null,
    removedCount: ownerResults.reduce((total, result) => total + (result.removedCount || 0), 0),
    removedBars: ownerResults.reduce((total, result) => total + (result.removedBars || 0), 0),
    removedIndicatorPoints: ownerResults.reduce((total, result) => total + (result.removedIndicatorPoints || 0), 0),
    removedIndicatorItems: ownerResults.reduce((total, result) => total + (result.removedIndicatorItems || 0), 0),
    removedEstimatedBytes: ownerResults.reduce((total, result) => total + (result.removedEstimatedBytes || 0), 0),
    ownerResults,
  };
}
