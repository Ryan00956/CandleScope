import type {
  CacheDiagnostics,
  CacheDiagnosticsEntry,
  CacheTier,
  GcCandidate,
  GcPlan,
  GcPolicy,
  GcPressure,
  GcRelief,
  GcVictim,
} from "./cacheGcTypes.js";

interface NormalizedGcEntry extends CacheDiagnosticsEntry {
  owner: string;
  key: string;
  tier: CacheTier;
  category: "kline" | "indicator";
  bars: number;
  points: number;
  items: number;
  estimatedBytes: number;
  orphan?: boolean;
}

const DEFAULT_POLICY: GcPolicy = {
  maxEstimatedBytes: 64 * 1024 * 1024,
  maxIndicatorPoints: 500_000,
  maxKlineBars: 200_000,
  maxVictims: 50,
  preserveActive: true,
  preserveSubscribed: true,
  planTtlMs: 60_000,
  heapHighWatermarkRatio: 0.8,
  heapHardWatermarkRatio: 0.9,
};

const TIER_PRIORITY: Record<CacheTier, number> = {
  cold: 0,
  warm: 1,
  visible: 2,
  subscribed: 3,
  active: 4,
};

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function nonNegative(value: unknown): number {
  return Math.max(0, number(value));
}

function positiveOrDefault(value: unknown, fallback: number): number {
  const parsed = number(value);
  return parsed > 0 ? parsed : fallback;
}

function ratioOrDefault(value: unknown, fallback: number): number {
  const parsed = number(value);
  return parsed > 0 && parsed < 1 ? parsed : fallback;
}

function latestTimestamp(entry: CacheDiagnosticsEntry): number {
  return Math.max(
    0,
    number(entry.lastAccessMs),
    number(entry.lastUpdatedMs),
    number(entry.lastRealtimeMs),
  );
}

function ageMs(entry: CacheDiagnosticsEntry, nowMs: number): number | null {
  const timestamp = latestTimestamp(entry);
  return timestamp > 0 ? Math.max(0, nowMs - timestamp) : null;
}

function inferTier(entry: CacheDiagnosticsEntry, nowMs: number): CacheTier {
  if (entry.tier === "active") return "active";
  if (entry.tier === "subscribed" || entry.status === "live") return "subscribed";
  if (entry.tier === "visible") return "visible";
  if (entry.tier === "cold" || entry.status === "error" || entry.status === "stale") return "cold";
  const idleMs = ageMs(entry, nowMs);
  if (idleMs != null && idleMs > 10 * 60 * 1000) return "cold";
  return "warm";
}

function flattenDiagnostics(
  diagnostics: CacheDiagnostics = {},
  nowMs: number,
): NormalizedGcEntry[] {
  const owners = diagnostics.owners || {};
  const chartEntries = owners.chart?.entries || [];
  const watchlistEntries = owners.watchlist?.entries || [];
  const indicatorEntries = owners.indicators?.entries || [];

  return [
    ...chartEntries.map((entry): NormalizedGcEntry => ({
      ...entry,
      owner: entry.owner || "chart-data-cache",
      key: String(entry.key || ""),
      category: "kline" as const,
      tier: inferTier(entry, nowMs),
      bars: nonNegative(entry.bars),
      estimatedBytes: nonNegative(entry.estimatedBytes),
      points: 0,
      items: 0,
    })),
    ...watchlistEntries.map((entry): NormalizedGcEntry => ({
      ...entry,
      owner: entry.owner || "watchlist-full-cache",
      key: String(entry.key || ""),
      category: "kline" as const,
      tier: inferTier(entry, nowMs),
      bars: nonNegative(entry.bars),
      estimatedBytes: nonNegative(entry.estimatedBytes),
      points: 0,
      items: 0,
    })),
    ...indicatorEntries.map((entry): NormalizedGcEntry => ({
      ...entry,
      owner: entry.owner || "indicator-result-cache",
      key: String(entry.key || ""),
      category: "indicator" as const,
      tier: inferTier(entry, nowMs),
      orphan: Boolean(entry.dependencyState?.orphan),
      bars: 0,
      estimatedBytes: nonNegative(entry.estimatedBytes),
      points: nonNegative(entry.points),
      items: nonNegative(entry.items),
    })),
  ];
}

function normalizePolicy(policyPatch: Partial<GcPolicy>): GcPolicy {
  const policy: GcPolicy = { ...DEFAULT_POLICY, ...policyPatch };
  policy.maxEstimatedBytes = positiveOrDefault(
    policy.frontendCacheBudgetBytes
      ?? policy.frontend_cache_budget_bytes
      ?? policy.maxEstimatedBytes,
    DEFAULT_POLICY.maxEstimatedBytes,
  );
  policy.maxIndicatorPoints = nonNegative(policy.maxIndicatorPoints);
  policy.maxKlineBars = nonNegative(policy.maxKlineBars);
  policy.maxVictims = Math.max(0, Math.floor(number(policy.maxVictims)));
  policy.planTtlMs = positiveOrDefault(policy.planTtlMs, number(DEFAULT_POLICY.planTtlMs));
  policy.heapHighWatermarkRatio = ratioOrDefault(
    policy.heapHighWatermarkRatio,
    number(DEFAULT_POLICY.heapHighWatermarkRatio),
  );
  policy.heapHardWatermarkRatio = ratioOrDefault(
    policy.heapHardWatermarkRatio,
    number(DEFAULT_POLICY.heapHardWatermarkRatio),
  );
  if (policy.heapHardWatermarkRatio <= policy.heapHighWatermarkRatio) {
    policy.heapHardWatermarkRatio = number(DEFAULT_POLICY.heapHardWatermarkRatio);
  }
  return policy;
}

function shouldProtect(entry: NormalizedGcEntry, policy: GcPolicy): string {
  if (policy.preserveActive && entry.tier === "active") return "protected-active";
  if (
    policy.preserveSubscribed
    && entry.tier === "subscribed"
    && !(entry.owner === "watchlist-full-cache" && exactTrimRelief(entry))
  ) return "protected-subscribed";
  return "";
}

function reasonFor(entry: NormalizedGcEntry, pressure: GcPressure): string {
  if (entry.orphan) return "missing-kline-dependency";
  if (entry.category === "indicator" && pressure.indicatorPoints > 0) {
    return "indicator-points-over-budget";
  }
  if (entry.category === "kline" && pressure.klineBars > 0) {
    return "kline-bars-over-budget";
  }
  if (pressure.estimatedBytes > 0 && nonNegative(pressure.heapEstimatedBytes) > 0) {
    return "browser-heap-high-watermark";
  }
  if (pressure.estimatedBytes > 0) return "estimated-bytes-over-budget";
  if (entry.tier === "cold") return "cold-cache-over-budget";
  return "warm-cache-over-budget";
}

function sortCandidates(left: GcCandidate, right: GcCandidate): number {
  const smartDiff = number(right.scores?.finalEvictScore) - number(left.scores?.finalEvictScore);
  if (smartDiff !== 0) return smartDiff;
  const tierDiff = (TIER_PRIORITY[left.tier] ?? 9) - (TIER_PRIORITY[right.tier] ?? 9);
  if (tierDiff !== 0) return tierDiff;
  const byteDiff = number(right.estimatedBytes) - number(left.estimatedBytes);
  if (byteDiff !== 0) return byteDiff;
  return String(left.key || "").localeCompare(String(right.key || ""));
}

function pressureScore(pressure: GcPressure): number {
  let score = 0;
  if (pressure.klineBars > 0) score += 20;
  if (pressure.indicatorPoints > 0) score += 20;
  if (pressure.estimatedBytes > 0) score += 20;
  if (pressure.level === "hard" && nonNegative(pressure.heapEstimatedBytes) > 0) score += 20;
  return score;
}

function restoreCost(entry: NormalizedGcEntry): { score: number; reason: string } {
  if (entry.orphan) return { score: 0, reason: "orphan" };
  if (entry.owner === "watchlist-full-cache" && exactTrimRelief(entry)) {
    return { score: 25, reason: "watchlist-safe-tail-trim" };
  }
  if (entry.category === "indicator") {
    if (exactTrimRelief(entry)) {
      return { score: 45, reason: "indicator-safe-range-trim" };
    }
    return { score: 75, reason: "indicator-recompute" };
  }
  if (entry.owner === "watchlist-full-cache") return { score: 50, reason: "watchlist-full-refetch" };
  return { score: 20, reason: "memory-or-sqlite-reload" };
}

function reuseProbability(entry: NormalizedGcEntry): number {
  const behaviorHeat = entry.behaviorHeat && typeof entry.behaviorHeat === "object"
    ? entry.behaviorHeat as Record<string, unknown>
    : null;
  const explicit = number(entry.heatScore ?? behaviorHeat?.heat_score);
  const access = number(entry.accessCount ?? behaviorHeat?.access_count_24h);
  const switches = number(entry.switchCount ?? behaviorHeat?.switch_count_24h);
  const tierBoost = { active: 100, subscribed: 75, visible: 55, warm: 20, cold: 0 }[entry.tier] ?? 0;
  return Math.min(100, tierBoost + explicit * 8 + access * 3 + switches * 10);
}

function attachScores(
  entry: NormalizedGcEntry,
  pressure: GcPressure,
): GcCandidate {
  const restore = restoreCost(entry);
  const reuse = reuseProbability(entry);
  const pScore = pressureScore(pressure);
  let gcValue = Math.min(100, nonNegative(entry.estimatedBytes) / (1024 * 1024) * 8);
  gcValue += Math.min(30, nonNegative(entry.bars + entry.points + entry.items) / 10_000);
  gcValue += { cold: 30, warm: 0, visible: -20, subscribed: -40, active: -80 }[entry.tier] ?? 0;
  if (entry.orphan) gcValue += 100;
  const final = Math.max(0, gcValue + pScore - restore.score - reuse);
  return {
    ...entry,
    restoreCostReason: restore.reason,
    reuseReason: reuse >= 60 ? "hot-series" : reuse >= 20 ? "recently-reused" : "no-recent-heat",
    matchedIntents: Array.isArray(entry.matchedIntents) ? entry.matchedIntents : [],
    scores: {
      gcValueScore: Number(gcValue.toFixed(3)),
      restoreCostScore: Number(restore.score.toFixed(3)),
      reuseProbabilityScore: Number(reuse.toFixed(3)),
      pressureScore: Number(pScore.toFixed(3)),
      finalEvictScore: Number(final.toFixed(3)),
    },
  };
}

function exactTrimRelief(
  candidate: NormalizedGcEntry,
): { keepStart: number | null; relief: GcRelief } | null {
  if (!candidate.trimSafety?.safeRangeTrim || !candidate.trimPlan) return null;
  const keepStart = number(candidate.trimPlan.keepStart);
  const bars = nonNegative(candidate.trimPlan.removedBars);
  const indicatorPoints = nonNegative(candidate.trimPlan.removedPoints);
  const indicatorItems = nonNegative(candidate.trimPlan.removedItems);
  const estimatedBytes = nonNegative(candidate.trimPlan.removedEstimatedBytes);
  if (estimatedBytes <= 0) return null;
  if (candidate.category === "kline") {
    if (candidate.owner !== "watchlist-full-cache" || bars <= 0 || bars > candidate.bars) return null;
    if (estimatedBytes > candidate.estimatedBytes) return null;
    return {
      keepStart: keepStart > 0 ? keepStart : null,
      relief: { bars, indicatorPoints: 0, indicatorItems: 0, estimatedBytes },
    };
  }
  if (keepStart <= 0 || indicatorPoints + indicatorItems <= 0) return null;
  if (
    indicatorPoints > candidate.points
    || indicatorItems > candidate.items
    || estimatedBytes > candidate.estimatedBytes
  ) return null;
  return {
    keepStart,
    relief: { bars: 0, indicatorPoints, indicatorItems, estimatedBytes },
  };
}

function victimFrom(candidate: GcCandidate, remaining: GcPressure): GcVictim {
  const trim = exactTrimRelief(candidate);
  const relief: GcRelief = trim?.relief || {
    bars: candidate.bars,
    indicatorPoints: candidate.points,
    indicatorItems: candidate.items,
    estimatedBytes: candidate.estimatedBytes,
  };
  return {
    owner: candidate.owner,
    key: candidate.key,
    tier: candidate.tier,
    category: candidate.category,
    bars: relief.bars,
    points: relief.indicatorPoints,
    items: relief.indicatorItems,
    estimatedBytes: relief.estimatedBytes,
    relief,
    resourceTotals: {
      bars: candidate.bars,
      indicatorPoints: candidate.points,
      indicatorItems: candidate.items,
      estimatedBytes: candidate.estimatedBytes,
    },
    ...(candidate.lastAccessMs === undefined ? {} : { lastAccessMs: candidate.lastAccessMs }),
    ...(candidate.lastUpdatedMs === undefined ? {} : { lastUpdatedMs: candidate.lastUpdatedMs }),
    ...(candidate.lastRealtimeMs === undefined ? {} : { lastRealtimeMs: candidate.lastRealtimeMs }),
    ...(candidate.generation === undefined ? {} : { generation: candidate.generation }),
    ...(candidate.revision === undefined ? {} : { expectedRevision: candidate.revision }),
    ...(candidate.metaRevision === undefined
      ? {}
      : { expectedMetaRevision: candidate.metaRevision }),
    action: trim ? "trim-range" : "delete-entry",
    keepStart: trim?.keepStart ?? null,
    reason: reasonFor(candidate, remaining),
    scores: candidate.scores,
    matchedIntents: candidate.matchedIntents,
    restoreCostReason: candidate.restoreCostReason,
    reuseReason: candidate.reuseReason,
    ...(candidate.trimSafety === undefined ? {} : { trimSafety: candidate.trimSafety }),
    ...(candidate.trimPlan === undefined ? {} : { trimPlan: candidate.trimPlan }),
    ...(candidate.rangeSegments === undefined ? {} : { rangeSegments: candidate.rangeSegments }),
  };
}

function heapUsageRatio(diagnostics: CacheDiagnostics): { ratio: number; used: number; limit: number } {
  const heap = diagnostics.runtimePressure?.browserHeap;
  const used = nonNegative(heap?.usedJSHeapSize);
  const limit = nonNegative(heap?.jsHeapSizeLimit);
  const explicit = nonNegative(heap?.usageRatio);
  return {
    ratio: explicit > 0 ? explicit : limit > 0 ? used / limit : 0,
    used,
    limit,
  };
}

function buildPressure(diagnostics: CacheDiagnostics, policy: GcPolicy): GcPressure {
  const totalKlineBars = nonNegative(diagnostics.klineBars);
  const totalIndicatorPoints = nonNegative(diagnostics.indicatorPoints);
  const estimatedBytes = nonNegative(diagnostics.estimatedBytes);
  const klineBars = Math.max(0, totalKlineBars - nonNegative(policy.maxKlineBars));
  const indicatorPoints = Math.max(0, totalIndicatorPoints - nonNegative(policy.maxIndicatorPoints));
  const budgetEstimatedBytes = Math.max(0, estimatedBytes - nonNegative(policy.maxEstimatedBytes));
  const heap = heapUsageRatio(diagnostics);
  const highWatermark = number(policy.heapHighWatermarkRatio);
  const hardWatermark = number(policy.heapHardWatermarkRatio);
  let heapEstimatedBytes = 0;
  if (heap.ratio > highWatermark && estimatedBytes > 0) {
    const measuredExcess = heap.limit > 0
      ? Math.max(0, heap.used - heap.limit * highWatermark)
      : estimatedBytes * Math.min(1, (heap.ratio - highWatermark) / Math.max(0.01, 1 - highWatermark));
    heapEstimatedBytes = Math.min(estimatedBytes, Math.ceil(measuredExcess));
  }
  const reasons: string[] = [];
  if (klineBars > 0) reasons.push("kline-bars-over-budget");
  if (indicatorPoints > 0) reasons.push("indicator-points-over-budget");
  if (budgetEstimatedBytes > 0) reasons.push("estimated-bytes-over-budget");
  if (heapEstimatedBytes > 0) reasons.push("browser-heap-high-watermark");
  const budgetHard = klineBars > 0 || indicatorPoints > 0 || budgetEstimatedBytes > 0;
  const level: GcPressure["level"] = budgetHard || heap.ratio >= hardWatermark
    ? "hard"
    : heapEstimatedBytes > 0
      ? "high"
      : "normal";
  return {
    klineBars,
    indicatorPoints,
    estimatedBytes: Math.max(budgetEstimatedBytes, heapEstimatedBytes),
    heapEstimatedBytes,
    heapUsageRatio: heap.ratio,
    level,
    reasons,
  };
}

export function gcVictimRelief(victim: GcVictim): GcRelief {
  return {
    bars: nonNegative(victim.relief?.bars ?? victim.bars),
    indicatorPoints: nonNegative(victim.relief?.indicatorPoints ?? victim.points),
    indicatorItems: nonNegative(victim.relief?.indicatorItems ?? victim.items),
    estimatedBytes: nonNegative(victim.relief?.estimatedBytes ?? victim.estimatedBytes),
  };
}

export function gcPressureSatisfied(pressure: GcPressure): boolean {
  return pressure.klineBars <= 0
    && pressure.indicatorPoints <= 0
    && pressure.estimatedBytes <= 0;
}

export function gcVictimRelievesPressure(victim: GcVictim, pressure: GcPressure): boolean {
  const relief = gcVictimRelief(victim);
  return (pressure.klineBars > 0 && relief.bars > 0)
    || (pressure.indicatorPoints > 0 && relief.indicatorPoints > 0)
    || (pressure.estimatedBytes > 0 && relief.estimatedBytes > 0);
}

export function applyGcRelief(pressure: GcPressure, victim: GcVictim): GcPressure {
  const relief = gcVictimRelief(victim);
  return {
    ...pressure,
    klineBars: Math.max(0, pressure.klineBars - relief.bars),
    indicatorPoints: Math.max(0, pressure.indicatorPoints - relief.indicatorPoints),
    estimatedBytes: Math.max(0, pressure.estimatedBytes - relief.estimatedBytes),
  };
}

function hasPressure(pressure: GcPressure): boolean {
  return !gcPressureSatisfied(pressure);
}

function revisionHash(entries: NormalizedGcEntry[]): string {
  let hash = 2166136261;
  for (const entry of entries) {
    const value = `${entry.owner}:${entry.key}:${number(entry.generation)}:${number(entry.metaRevision)}:${latestTimestamp(entry)};`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sumRelief(victims: GcVictim[]): GcRelief {
  return victims.reduce<GcRelief>((total, victim) => {
    const relief = gcVictimRelief(victim);
    return {
      bars: total.bars + relief.bars,
      indicatorPoints: total.indicatorPoints + relief.indicatorPoints,
      indicatorItems: total.indicatorItems + relief.indicatorItems,
      estimatedBytes: total.estimatedBytes + relief.estimatedBytes,
    };
  }, { bars: 0, indicatorPoints: 0, indicatorItems: 0, estimatedBytes: 0 });
}

export function planFrontendGc(
  diagnostics: CacheDiagnostics = {},
  policyPatch: Partial<GcPolicy> = {},
): GcPlan {
  const policy = normalizePolicy(policyPatch);
  const nowMs = number(policy.nowMs) || Date.now();
  const entries = flattenDiagnostics(diagnostics, nowMs);
  const pressure = buildPressure(diagnostics, policy);
  const protectedEntries: Array<NormalizedGcEntry & { reason: string }> = [];
  const candidates: GcCandidate[] = [];

  for (const entry of entries) {
    const protectedReason = shouldProtect(entry, policy);
    if (protectedReason) {
      protectedEntries.push({ ...entry, reason: protectedReason });
      continue;
    }
    if (entry.estimatedBytes <= 0 && entry.bars <= 0 && entry.points <= 0 && entry.items <= 0) continue;
    candidates.push(attachScores(entry, pressure));
  }

  const ranked = [...candidates].sort(sortCandidates);
  const candidateVictims = ranked
    .map((candidate) => victimFrom(candidate, pressure))
    .filter((victim) => hasPressure(pressure)
      ? gcVictimRelievesPressure(victim, pressure)
      : victim.reason === "missing-kline-dependency");
  const victims: GcVictim[] = [];
  let remaining = { ...pressure };
  for (const victim of candidateVictims) {
    if (victims.length >= policy.maxVictims) break;
    if (hasPressure(pressure) && !gcVictimRelievesPressure(victim, remaining)) continue;
    victims.push(victim);
    remaining = applyGcRelief(remaining, victim);
    if (hasPressure(pressure) && gcPressureSatisfied(remaining)) break;
  }

  const wouldFree = sumRelief(victims);
  const diagnosticsGeneratedAtMs = number(diagnostics.generatedAtMs) || null;
  return {
    generatedAtMs: nowMs,
    diagnosticsGeneratedAtMs,
    expiresAtMs: nowMs + number(policy.planTtlMs),
    planRevision: `frontend-gc-v2:${diagnosticsGeneratedAtMs ?? "na"}:${nowMs}:${revisionHash(entries)}`,
    mode: "dry-run",
    scoringVersion: 2,
    policy,
    pressure,
    remainingPressure: remaining,
    runtimePressure: diagnostics.runtimePressure || {},
    wouldFreeBars: wouldFree.bars,
    wouldFreeIndicatorPoints: wouldFree.indicatorPoints,
    wouldFreeIndicatorItems: wouldFree.indicatorItems,
    wouldFreeEstimatedBytes: wouldFree.estimatedBytes,
    candidateCount: candidates.length,
    protectedCount: protectedEntries.length,
    candidateVictims,
    victims,
  };
}

export { DEFAULT_POLICY as FRONTEND_GC_DEFAULT_POLICY };
