import { executeFrontendGcPlan } from "./cacheTrim.js";
import {
  applyGcRelief,
  gcPressureSatisfied,
  gcVictimRelief,
  gcVictimRelievesPressure,
  planFrontendGc,
} from "./cachePolicy.js";
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

export type AutoGcPolicyPatch = Partial<AutoGcPolicy & GcPolicy>;
export type ChartTrimFunction = (victims: GcVictim[]) => CacheTrimOwnerResult;

const DEFAULT_AUTO_GC_POLICY: AutoGcPolicy = {
  enabled: true,
  mode: "conservative",
  cooldownMs: 60_000,
  maxBytesPerRun: 32 * 1024 * 1024,
  maxEntriesPerRun: 200,
  minFinalEvictScore: 70,
  neverEvictAccessedWithinMs: 2 * 60_000,
};

const FRONTEND_AUDIT_KEY = "candlescope:auto-gc-audit";
const FRONTEND_AUDIT_LIMIT = 50;
const AUTO_POLICY_KEYS = [
  "enabled",
  "mode",
  "cooldownMs",
  "maxBytesPerRun",
  "maxEntriesPerRun",
  "minFinalEvictScore",
  "neverEvictAccessedWithinMs",
  "nowMs",
] as const;
const GC_PLAN_POLICY_KEYS = [
  "maxEstimatedBytes",
  "maxIndicatorPoints",
  "maxKlineBars",
  "maxVictims",
  "preserveActive",
  "preserveSubscribed",
  "planTtlMs",
  "heapHighWatermarkRatio",
  "heapHardWatermarkRatio",
  "nowMs",
  "frontendCacheBudgetBytes",
  "frontend_cache_budget_bytes",
] as const;
const SUPPORTED_POLICY_KEYS = new Set<string>([
  ...AUTO_POLICY_KEYS,
  ...GC_PLAN_POLICY_KEYS,
]);

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function assertSupportedPolicyPatch(policyPatch: AutoGcPolicyPatch): void {
  for (const key of Object.keys(policyPatch)) {
    if (!SUPPORTED_POLICY_KEYS.has(key)) {
      throw new TypeError(`Unsupported frontend auto GC policy field: ${key}`);
    }
  }
}

function normalizeAutoPolicy(policyPatch: AutoGcPolicyPatch): AutoGcPolicy {
  const cooldownMs = number(policyPatch.cooldownMs);
  const policy: AutoGcPolicy = {
    enabled: typeof policyPatch.enabled === "boolean"
      ? policyPatch.enabled
      : DEFAULT_AUTO_GC_POLICY.enabled,
    mode: typeof policyPatch.mode === "string" && policyPatch.mode.trim()
      ? policyPatch.mode.trim()
      : DEFAULT_AUTO_GC_POLICY.mode,
    cooldownMs: cooldownMs > 0 ? cooldownMs : DEFAULT_AUTO_GC_POLICY.cooldownMs,
    maxBytesPerRun: Math.max(
      0,
      policyPatch.maxBytesPerRun === undefined
        ? DEFAULT_AUTO_GC_POLICY.maxBytesPerRun
        : number(policyPatch.maxBytesPerRun),
    ),
    maxEntriesPerRun: Math.max(
      0,
      Math.floor(
        policyPatch.maxEntriesPerRun === undefined
          ? DEFAULT_AUTO_GC_POLICY.maxEntriesPerRun
          : number(policyPatch.maxEntriesPerRun),
      ),
    ),
    minFinalEvictScore: Math.max(
      0,
      policyPatch.minFinalEvictScore === undefined
        ? DEFAULT_AUTO_GC_POLICY.minFinalEvictScore
        : number(policyPatch.minFinalEvictScore),
    ),
    neverEvictAccessedWithinMs: Math.max(
      0,
      policyPatch.neverEvictAccessedWithinMs === undefined
        ? DEFAULT_AUTO_GC_POLICY.neverEvictAccessedWithinMs
        : number(policyPatch.neverEvictAccessedWithinMs),
    ),
    ...(policyPatch.nowMs === undefined ? {} : { nowMs: policyPatch.nowMs }),
  };
  return policy;
}

function buildGcPlanPolicyPatch(
  policyPatch: AutoGcPolicyPatch,
  autoPolicy: AutoGcPolicy,
): Partial<GcPolicy> {
  const gcPolicy: Partial<GcPolicy> = {};
  for (const key of GC_PLAN_POLICY_KEYS) {
    if (Object.hasOwn(policyPatch, key)) {
      Reflect.set(gcPolicy, key, Reflect.get(policyPatch, key));
    }
  }
  const requestedMaxVictims = Math.max(0, Math.floor(number(policyPatch.maxVictims)));
  gcPolicy.maxVictims = requestedMaxVictims > 0
    ? Math.min(autoPolicy.maxEntriesPerRun, requestedMaxVictims)
    : autoPolicy.maxEntriesPerRun;
  if (autoPolicy.nowMs !== undefined) gcPolicy.nowMs = autoPolicy.nowMs;
  return gcPolicy;
}

function score(victim: GcVictim): number {
  return number(victim?.scores?.finalEvictScore);
}

function lastAccessMs(victim: GcVictim): number {
  return Math.max(
    0,
    number(victim?.lastAccessMs),
    number(victim?.lastUpdatedMs),
    number(victim?.lastRealtimeMs),
  );
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
  return used + number(victim.estimatedBytes) <= policy.maxBytesPerRun;
}

export function buildAutoFrontendGcPlan(
  diagnostics: Parameters<typeof planFrontendGc>[0] = {},
  policyPatch: AutoGcPolicyPatch = {},
): AutoGcPlan {
  assertSupportedPolicyPatch(policyPatch);
  const policy = normalizeAutoPolicy(policyPatch);
  const basePlan = planFrontendGc(
    diagnostics,
    buildGcPlanPolicyPatch(policyPatch, policy),
  );
  const nowMs = number(policy.nowMs) || Date.now();
  const candidateVictims = basePlan.candidateVictims || basePlan.victims;
  if (!policy.enabled) {
    return {
      ...basePlan,
      mode: "auto-plan",
      autoPolicy: policy,
      victims: [],
      autoSkipped: candidateVictims.map((victim) => ({
        key: victim.key,
        reason: "disabled",
        score: score(victim),
      })),
    };
  }

  const selected: GcVictim[] = [];
  const skipped: AutoGcPlan["autoSkipped"] = [];
  let remaining = { ...basePlan.pressure };
  const pressureActive = !gcPressureSatisfied(basePlan.pressure);
  for (const victim of candidateVictims) {
    if (pressureActive && gcPressureSatisfied(remaining)) break;
    if (pressureActive && !gcVictimRelievesPressure(victim, remaining)) continue;
    let reason = "";
    if (
      victim.tier === "active"
      || (
        victim.tier === "subscribed"
        && !(victim.action === "trim-range" && victim.trimSafety?.safeRangeTrim)
      )
    ) {
      reason = "active-or-subscribed";
    } else if (!isAlwaysSafe(victim) && isRecentlyAccessed(victim, nowMs, policy)) {
      reason = "recently-accessed";
    } else if (
      basePlan.pressure.level !== "hard"
      && !isAlwaysSafe(victim)
      && score(victim) < policy.minFinalEvictScore
    ) {
      reason = "score-below-threshold";
    } else if (!withinLimits(selected, victim, policy)) {
      reason = "per-run-limit";
    }

    if (reason) {
      skipped.push({ key: victim.key, reason, score: score(victim) });
      continue;
    }
    selected.push(victim);
    remaining = applyGcRelief(remaining, victim);
  }

  const relief = selected.reduce((total, item) => {
    const next = gcVictimRelief(item);
    return {
      bars: total.bars + next.bars,
      indicatorPoints: total.indicatorPoints + next.indicatorPoints,
      indicatorItems: total.indicatorItems + next.indicatorItems,
      estimatedBytes: total.estimatedBytes + next.estimatedBytes,
    };
  }, { bars: 0, indicatorPoints: 0, indicatorItems: 0, estimatedBytes: 0 });

  return {
    ...basePlan,
    mode: "auto-plan",
    autoPolicy: policy,
    victims: selected,
    remainingPressure: remaining,
    autoSkipped: skipped,
    wouldFreeBars: relief.bars,
    wouldFreeIndicatorPoints: relief.indicatorPoints,
    wouldFreeIndicatorItems: relief.indicatorItems,
    wouldFreeEstimatedBytes: relief.estimatedBytes,
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
