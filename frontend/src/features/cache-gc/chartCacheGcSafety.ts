import type { GcVictim } from "./cacheGcTypes.js";

export interface ChartCacheGcSnapshot {
  key: string;
  activeKey: string;
  generation: number;
  revision: number;
  metaRevision: number;
  lastAccessMs: number | null;
  lastUpdatedMs: number | null;
  bars: number;
  estimatedBytes: number;
}

export interface ChartCacheGcValidation {
  allowed: boolean;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function timestampMatches(value: unknown, current: number | null): boolean {
  return current == null ? value === null : isFiniteNumber(value) && value === current;
}

function changedTimestampReason(
  planned: unknown,
  current: number | null,
  changedReason: string,
): string {
  if (isFiniteNumber(planned) && current != null && current > planned) return changedReason;
  return "delete-plan-stale-or-invalid";
}

/**
 * Fail-closed validation at the chart-cache mutation boundary. A GC plan may
 * only delete the exact store snapshot that the planner inspected.
 */
export function validateChartCacheGcVictim(
  victim: GcVictim,
  current: ChartCacheGcSnapshot | null,
): ChartCacheGcValidation {
  if (
    victim.owner !== "chart-data-cache"
    || victim.category !== "kline"
    || victim.action !== "delete-entry"
    || typeof victim.key !== "string"
    || !victim.key
  ) {
    return { allowed: false, reason: "delete-plan-stale-or-invalid" };
  }
  if (!current) return { allowed: false, reason: "entry-missing" };
  if (victim.key !== current.key) {
    return { allowed: false, reason: "delete-plan-stale-or-invalid" };
  }
  if (current.key === current.activeKey) {
    return { allowed: false, reason: "active-entry-protected" };
  }
  if (!timestampMatches(victim.lastAccessMs, current.lastAccessMs)) {
    return {
      allowed: false,
      reason: changedTimestampReason(
        victim.lastAccessMs,
        current.lastAccessMs,
        "accessed-after-plan",
      ),
    };
  }
  if (!timestampMatches(victim.lastUpdatedMs, current.lastUpdatedMs)) {
    return {
      allowed: false,
      reason: changedTimestampReason(
        victim.lastUpdatedMs,
        current.lastUpdatedMs,
        "updated-after-plan",
      ),
    };
  }
  if (
    !isFiniteNumber(victim.generation)
    || victim.generation !== current.generation
  ) {
    return { allowed: false, reason: "generation-changed" };
  }
  if (
    !isFiniteNumber(victim.expectedRevision)
    || victim.expectedRevision !== current.revision
  ) {
    return { allowed: false, reason: "revision-changed" };
  }
  if (
    !isFiniteNumber(victim.expectedMetaRevision)
    || victim.expectedMetaRevision <= 0
    || current.metaRevision <= 0
    || victim.expectedMetaRevision !== current.metaRevision
  ) {
    return { allowed: false, reason: "access-or-meta-changed" };
  }

  const resourceTotals = isRecord(victim.resourceTotals) ? victim.resourceTotals : null;
  const relief = isRecord(victim.relief) ? victim.relief : null;
  const exactResourceSnapshot = resourceTotals != null
    && resourceTotals.bars === current.bars
    && resourceTotals.indicatorPoints === 0
    && resourceTotals.indicatorItems === 0
    && resourceTotals.estimatedBytes === current.estimatedBytes
    && victim.bars === current.bars
    && victim.points === 0
    && victim.items === 0
    && victim.estimatedBytes === current.estimatedBytes
    && relief != null
    && relief.bars === current.bars
    && relief.indicatorPoints === 0
    && relief.indicatorItems === 0
    && relief.estimatedBytes === current.estimatedBytes;
  if (!exactResourceSnapshot) {
    return { allowed: false, reason: "resource-totals-changed" };
  }

  return { allowed: true, reason: "exact-planned-snapshot" };
}
