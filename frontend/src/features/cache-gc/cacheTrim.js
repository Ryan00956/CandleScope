import { trimIndicatorResultCacheEntries } from "../indicators/indicatorResultCacheStore.js";
import { trimWatchlistFullCacheEntries } from "../watchlist-full-cache/watchlistFullCacheStore.js";

function byOwner(victims = []) {
  return victims.reduce((groups, victim) => {
    if (!victim?.owner) return groups;
    if (!groups[victim.owner]) groups[victim.owner] = [];
    groups[victim.owner].push(victim);
    return groups;
  }, {});
}

export function executeFrontendGcPlan(plan, {
  trimChartDataCacheEntries = null,
} = {}) {
  const victims = plan?.victims || [];
  const groups = byOwner(victims);
  const chartResult = typeof trimChartDataCacheEntries === "function"
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
  const watchlistResult = trimWatchlistFullCacheEntries(groups["watchlist-full-cache"] || []);
  const indicatorResult = trimIndicatorResultCacheEntries(groups["indicator-result-cache"] || []);
  const ownerResults = [chartResult, watchlistResult, indicatorResult];

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
