import { executeFrontendGcPlan } from "./cacheTrim.js";
import { planFrontendGc } from "./cachePolicy.js";
import type {
  AutoGcPlan,
  AutoGcPolicy,
  AutoGcRun,
  CacheTrimOwnerResult,
  FrontendGcExecutionResult,
  GcPolicy,
  GcVictim,
} from "./cacheGcTypes.js";

interface FrontendAutoGcAuditEntry {
  tsMs: number;
  mode: "auto-gc";
  victimCount: number;
  skippedCount: number;
  removedCount: number;
  removedEstimatedBytes: number;
}

type AutoGcPolicyPatch = Partial<AutoGcPolicy & GcPolicy>;
type ChartTrimFunction = (victims: GcVictim[]) => CacheTrimOwnerResult;

const DEFAULT_AUTO_GC_POLICY: AutoGcPolicy = {
  enabled: true,
  mode: "conservative",
  cooldownMs: 60_000,
  maxBytesPerRun: 32 * 1024 * 1024,
  maxEntriesPerRun: 200,
  minFinalEvictScore: 70,
  neverEvictActiveWithinMs: 10 * 60_000,
  neverEvictAccessedWithinMs: 2 * 60_000,
};

const FRONTEND_AUDIT_KEY = "candlescope:auto-gc-audit";
const FRONTEND_AUDIT_LIMIT = 50;

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function score(victim: GcVictim): number {
  return number(victim?.scores?.finalEvictScore);
}

function lastAccessMs(victim: GcVictim): number {
  return number(victim?.lastAccessMs || victim?.lastUpdatedMs || victim?.lastRealtimeMs);
}

function isRecentlyAccessed(victim: GcVictim, nowMs: number, policy: AutoGcPolicy): boolean {
  const last = lastAccessMs(victim);
  return last > 0 && nowMs - last < policy.neverEvictAccessedWithinMs;
}

function isAlwaysSafe(victim: GcVictim): boolean {
  return victim?.reason === "missing-kline-dependency"
    || (victim?.action === "trim-range" && Boolean(victim?.trimSafety?.safeRangeTrim));
}

function withinLimits(
  selected: GcVictim[],
  victim: GcVictim,
  policy: AutoGcPolicy,
): boolean {
  if (selected.length >= policy.maxEntriesPerRun) return false;
  const used = selected.reduce((total, item) => total + number(item.estimatedBytes), 0);
  return used + number(victim.estimatedBytes) <= policy.maxBytesPerRun || selected.length === 0;
}

export function buildAutoFrontendGcPlan(
  diagnostics: Parameters<typeof planFrontendGc>[0] = {},
  policyPatch: AutoGcPolicyPatch = {},
): AutoGcPlan {
  const policy: AutoGcPolicy = { ...DEFAULT_AUTO_GC_POLICY, ...policyPatch };
  const basePlan = planFrontendGc(diagnostics, {
    ...policyPatch,
    maxVictims: policy.maxEntriesPerRun,
    nowMs: policy.nowMs,
  });
  const nowMs = number(policy.nowMs) || Date.now();
  if (!policy.enabled) {
    return {
      ...basePlan,
      mode: "auto-plan",
      autoPolicy: policy,
      victims: [],
      autoSkipped: basePlan.victims.map((victim) => ({
        key: victim.key,
        reason: "disabled",
        score: score(victim),
      })),
    };
  }

  const selected: GcVictim[] = [];
  const skipped: AutoGcPlan["autoSkipped"] = [];
  for (const victim of basePlan.victims) {
    let reason = "";
    if (victim.tier === "active" || victim.tier === "subscribed") {
      reason = "active-or-subscribed";
    } else if (isRecentlyAccessed(victim, nowMs, policy)) {
      reason = "recently-accessed";
    } else if (!isAlwaysSafe(victim) && score(victim) < policy.minFinalEvictScore) {
      reason = "score-below-threshold";
    } else if (!withinLimits(selected, victim, policy)) {
      reason = "per-run-limit";
    }

    if (reason) {
      skipped.push({ key: victim.key, reason, score: score(victim) });
      continue;
    }
    selected.push(victim);
  }

  return {
    ...basePlan,
    mode: "auto-plan",
    autoPolicy: policy,
    victims: selected,
    autoSkipped: skipped,
    wouldFreeBars: selected.reduce((total, item) => total + number(item.bars), 0),
    wouldFreeIndicatorPoints: selected.reduce((total, item) => total + number(item.points), 0),
    wouldFreeIndicatorItems: selected.reduce((total, item) => total + number(item.items), 0),
    wouldFreeEstimatedBytes: selected.reduce((total, item) => total + number(item.estimatedBytes), 0),
  };
}

export function runAutoFrontendGc(diagnostics: Parameters<typeof planFrontendGc>[0] = {}, {
  policy = {},
  trimChartDataCacheEntries = null,
}: {
  policy?: AutoGcPolicyPatch;
  trimChartDataCacheEntries?: ChartTrimFunction | null;
} = {}): AutoGcRun {
  const plan = buildAutoFrontendGcPlan(diagnostics, policy);
  if (!plan.victims.length) {
    const skippedResult: FrontendGcExecutionResult = {
      generatedAtMs: Date.now(),
      mode: "execute",
      status: "skipped",
      sourcePlanGeneratedAtMs: plan.generatedAtMs,
      removedCount: 0,
      removedBars: 0,
      removedIndicatorPoints: 0,
      removedIndicatorItems: 0,
      removedEstimatedBytes: 0,
      ownerResults: [],
    };
    const skipped: AutoGcRun = {
      plan,
      result: skippedResult,
    };
    appendFrontendAutoGcAudit(skipped);
    return skipped;
  }
  const executed: AutoGcRun = {
    plan,
    result: executeFrontendGcPlan(plan, { trimChartDataCacheEntries }),
  };
  appendFrontendAutoGcAudit(executed);
  return executed;
}

function finiteAuditCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseFrontendAutoGcAudit(raw: string | null): FrontendAutoGcAuditEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      if (record.mode !== "auto-gc"
        || typeof record.tsMs !== "number"
        || !Number.isFinite(record.tsMs)) return [];
      return [{
        tsMs: record.tsMs,
        mode: "auto-gc" as const,
        victimCount: finiteAuditCount(record.victimCount),
        skippedCount: finiteAuditCount(record.skippedCount),
        removedCount: finiteAuditCount(record.removedCount),
        removedEstimatedBytes: finiteAuditCount(record.removedEstimatedBytes),
      }];
    });
  } catch {
    return [];
  }
}

export function appendFrontendAutoGcAudit(entry: AutoGcRun): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const current = parseFrontendAutoGcAudit(storage.getItem(FRONTEND_AUDIT_KEY));
    const next: FrontendAutoGcAuditEntry[] = [
      {
        tsMs: Date.now(),
        mode: "auto-gc" as const,
        victimCount: entry?.plan?.victims?.length || 0,
        skippedCount: entry?.plan?.autoSkipped?.length || 0,
        removedCount: entry?.result?.removedCount || 0,
        removedEstimatedBytes: entry?.result?.removedEstimatedBytes || 0,
      },
      ...current,
    ].slice(0, FRONTEND_AUDIT_LIMIT);
    storage.setItem(FRONTEND_AUDIT_KEY, JSON.stringify(next));
  } catch {
    // Diagnostics must never block UI cleanup.
  }
}

export { DEFAULT_AUTO_GC_POLICY as FRONTEND_AUTO_GC_DEFAULT_POLICY };
