import { trimIndicatorResultCacheEntries } from "../indicators/indicatorResultCacheStore.js";
import { trimWatchlistFullCacheEntries } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import { gcVictimRelief } from "./cachePolicy.js";
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
    const ownerVictims = groups[victim.owner] ?? [];
    ownerVictims.push(victim);
    groups[victim.owner] = ownerVictims;
    return groups;
  }, {});
}

export function executeFrontendGcPlan(plan: GcPlan | null | undefined, {
  trimChartDataCacheEntries = null,
}: { trimChartDataCacheEntries?: ChartTrimFunction | null } = {}): FrontendGcExecutionResult {
  const victims = plan?.victims || [];
  const planned = victims.reduce((total, victim) => {
    const relief = gcVictimRelief(victim);
    return {
      bars: total.bars + relief.bars,
      indicatorPoints: total.indicatorPoints + relief.indicatorPoints,
      indicatorItems: total.indicatorItems + relief.indicatorItems,
      estimatedBytes: total.estimatedBytes + relief.estimatedBytes,
    };
  }, { bars: 0, indicatorPoints: 0, indicatorItems: 0, estimatedBytes: 0 });
  const expiresAtMs = Number(plan?.expiresAtMs);
  if (Number.isFinite(expiresAtMs) && expiresAtMs > 0 && Date.now() > expiresAtMs) {
    return {
      generatedAtMs: Date.now(),
      mode: "execute",
      status: "skipped",
      skipReason: "plan-expired",
      sourcePlanGeneratedAtMs: plan?.generatedAtMs ?? null,
      sourcePlanRevision: plan?.planRevision ?? null,
      removedCount: 0,
      removedBars: 0,
      removedIndicatorPoints: 0,
      removedIndicatorItems: 0,
      removedEstimatedBytes: 0,
      plannedBars: planned.bars,
      plannedIndicatorPoints: planned.indicatorPoints,
      plannedIndicatorItems: planned.indicatorItems,
      plannedEstimatedBytes: planned.estimatedBytes,
      accountingMatchesPlan: false,
      ownerResults: [],
    };
  }
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
  const removedBars = ownerResults.reduce((total, result) => total + (result.removedBars || 0), 0);
  const removedIndicatorPoints = ownerResults.reduce(
    (total, result) => total + (result.removedIndicatorPoints || 0),
    0,
  );
  const removedIndicatorItems = ownerResults.reduce(
    (total, result) => total + (result.removedIndicatorItems || 0),
    0,
  );
  const removedEstimatedBytes = ownerResults.reduce(
    (total, result) => total + (result.removedEstimatedBytes || 0),
    0,
  );

  return {
    generatedAtMs: Date.now(),
    mode: "execute",
    status: victims.length ? "executed" : "skipped",
    ...(victims.length ? {} : { skipReason: "no-victims" }),
    sourcePlanGeneratedAtMs: plan?.generatedAtMs ?? null,
    sourcePlanRevision: plan?.planRevision ?? null,
    removedCount: ownerResults.reduce((total, result) => total + (result.removedCount || 0), 0),
    removedBars,
    removedIndicatorPoints,
    removedIndicatorItems,
    removedEstimatedBytes,
    plannedBars: planned.bars,
    plannedIndicatorPoints: planned.indicatorPoints,
    plannedIndicatorItems: planned.indicatorItems,
    plannedEstimatedBytes: planned.estimatedBytes,
    accountingMatchesPlan:
      removedBars === planned.bars
      && removedIndicatorPoints === planned.indicatorPoints
      && removedIndicatorItems === planned.indicatorItems
      && removedEstimatedBytes === planned.estimatedBytes,
    ownerResults,
  };
}
