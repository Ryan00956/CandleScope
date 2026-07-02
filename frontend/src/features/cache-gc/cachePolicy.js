const DEFAULT_POLICY = {
  maxEstimatedBytes: 64 * 1024 * 1024,
  maxIndicatorPoints: 500_000,
  maxKlineBars: 200_000,
  maxVictims: 50,
  preserveActive: true,
  preserveSubscribed: true,
};

const TIER_PRIORITY = {
  cold: 0,
  warm: 1,
  visible: 2,
  subscribed: 3,
  active: 4,
};

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveOrDefault(value, fallback) {
  const parsed = number(value);
  return parsed > 0 ? parsed : fallback;
}

function ageMs(entry, nowMs) {
  const timestamp = number(entry.lastAccessMs || entry.lastUpdatedMs || entry.lastRealtimeMs);
  return timestamp > 0 ? Math.max(0, nowMs - timestamp) : null;
}

function inferTier(entry, nowMs) {
  if (entry.tier === "active") return "active";
  if (entry.tier === "subscribed" || entry.status === "live") return "subscribed";
  if (entry.tier === "visible") return "visible";
  if (entry.tier === "cold" || entry.status === "error" || entry.status === "stale") return "cold";
  const idleMs = ageMs(entry, nowMs);
  if (idleMs != null && idleMs > 10 * 60 * 1000) return "cold";
  return "warm";
}

function flattenDiagnostics(diagnostics = {}, nowMs) {
  const owners = diagnostics.owners || {};
  const chartEntries = owners.chart?.entries || [];
  const watchlistEntries = owners.watchlist?.entries || [];
  const indicatorEntries = owners.indicators?.entries || [];

  return [
    ...chartEntries.map((entry) => ({
      ...entry,
      owner: entry.owner || "chart-data-cache",
      category: "kline",
      tier: inferTier(entry, nowMs),
      bars: number(entry.bars),
      estimatedBytes: number(entry.estimatedBytes),
      points: 0,
      items: 0,
    })),
    ...watchlistEntries.map((entry) => ({
      ...entry,
      owner: entry.owner || "watchlist-full-cache",
      category: "kline",
      tier: inferTier(entry, nowMs),
      bars: number(entry.bars),
      estimatedBytes: number(entry.estimatedBytes),
      points: 0,
      items: 0,
    })),
    ...indicatorEntries.map((entry) => ({
      ...entry,
      owner: entry.owner || "indicator-result-cache",
      category: "indicator",
      tier: inferTier(entry, nowMs),
      orphan: Boolean(entry.dependencyState?.orphan),
      bars: 0,
      estimatedBytes: number(entry.estimatedBytes),
      points: number(entry.points),
      items: number(entry.items),
    })),
  ];
}

function shouldProtect(entry, policy) {
  if (policy.preserveActive && entry.tier === "active") {
    return "protected-active";
  }
  if (policy.preserveSubscribed && entry.tier === "subscribed") {
    return "protected-subscribed";
  }
  return "";
}

function reasonFor(entry, pressure) {
  if (entry.orphan) return "missing-kline-dependency";
  if (entry.tier === "cold") return "cold-cache-over-budget";
  if (entry.category === "indicator" && pressure.indicatorPoints > 0) return "indicator-points-over-budget";
  if (entry.category === "kline" && pressure.klineBars > 0) return "kline-bars-over-budget";
  if (pressure.estimatedBytes > 0) return "estimated-bytes-over-budget";
  return "warm-cache-over-budget";
}

function sortCandidates(left, right) {
  const smartDiff = number(right.scores?.finalEvictScore) - number(left.scores?.finalEvictScore);
  if (smartDiff !== 0) return smartDiff;
  const tierDiff = (TIER_PRIORITY[left.tier] ?? 9) - (TIER_PRIORITY[right.tier] ?? 9);
  if (tierDiff !== 0) return tierDiff;
  const byteDiff = number(right.estimatedBytes) - number(left.estimatedBytes);
  if (byteDiff !== 0) return byteDiff;
  return String(left.key || "").localeCompare(String(right.key || ""));
}

function pressureScore(diagnostics, pressure) {
  let score = 0;
  if (pressure.klineBars > 0) score += 20;
  if (pressure.indicatorPoints > 0) score += 20;
  if (pressure.estimatedBytes > 0) score += 20;
  const heap = diagnostics.runtimePressure?.browserHeap || {};
  const used = number(heap.usedJSHeapSize || heap.estimatedBytes);
  const limit = number(heap.jsHeapSizeLimit || heap.totalJSHeapSize);
  if (limit > 0 && used / limit > 0.8) score += 40;
  const storage = diagnostics.runtimePressure?.browserStorage || {};
  if (number(storage.usageRatio) > 0.8) score += 15;
  return score;
}

function restoreCost(entry) {
  if (entry.orphan) return { score: 0, reason: "orphan" };
  if (entry.category === "indicator") {
    if (entry.trimSafety?.safeRangeTrim) return { score: 45, reason: "indicator-safe-range-trim" };
    return { score: 75, reason: "indicator-recompute" };
  }
  if (entry.owner === "watchlist-full-cache") return { score: 50, reason: "watchlist-full-refetch" };
  return { score: 20, reason: "memory-or-sqlite-reload" };
}

function reuseProbability(entry) {
  const explicit = number(entry.heatScore || entry.behaviorHeat?.heat_score);
  const access = number(entry.accessCount || entry.behaviorHeat?.access_count_24h);
  const switches = number(entry.switchCount || entry.behaviorHeat?.switch_count_24h);
  const tierBoost = { active: 100, subscribed: 75, visible: 55, warm: 20, cold: 0 }[entry.tier] ?? 0;
  return Math.min(100, tierBoost + explicit * 8 + access * 3 + switches * 10);
}

function attachScores(entry, diagnostics, pressure) {
  const restore = restoreCost(entry);
  const reuse = reuseProbability(entry);
  const pScore = pressureScore(diagnostics, pressure);
  let gcValue = Math.min(100, number(entry.estimatedBytes) / (1024 * 1024) * 8);
  gcValue += Math.min(30, number(entry.bars + entry.points + entry.items) / 10_000);
  gcValue += { cold: 30, warm: 0, visible: -20, subscribed: -40, active: -80 }[entry.tier] ?? 0;
  if (entry.orphan) gcValue += 100;
  const final = Math.max(0, gcValue + pScore - restore.score - reuse);
  return {
    ...entry,
    restoreCostReason: restore.reason,
    reuseReason: reuse >= 60 ? "hot-series" : reuse >= 20 ? "recently-reused" : "no-recent-heat",
    matchedIntents: entry.matchedIntents || [],
    scores: {
      gcValueScore: Number(gcValue.toFixed(3)),
      restoreCostScore: Number(restore.score.toFixed(3)),
      reuseProbabilityScore: Number(reuse.toFixed(3)),
      pressureScore: Number(pScore.toFixed(3)),
      finalEvictScore: Number(final.toFixed(3)),
    },
  };
}

function victimFrom(candidate, remaining) {
  const canTrimRange = candidate.category === "indicator"
    && candidate.trimSafety?.safeRangeTrim
    && candidate.coverage?.firstTime != null
    && candidate.coverage?.lastTime != null
    && number(candidate.points) > 2;
  const keepStart = canTrimRange
    ? Math.floor((number(candidate.coverage.firstTime) + number(candidate.coverage.lastTime)) / 2)
    : null;
  return {
    owner: candidate.owner,
    key: candidate.key,
    tier: candidate.tier,
    category: candidate.category,
    bars: candidate.bars,
    points: candidate.points,
    items: candidate.items,
    estimatedBytes: candidate.estimatedBytes,
    lastAccessMs: candidate.lastAccessMs,
    lastUpdatedMs: candidate.lastUpdatedMs,
    lastRealtimeMs: candidate.lastRealtimeMs,
    action: canTrimRange ? "trim-range" : "delete-entry",
    keepStart,
    reason: reasonFor(candidate, remaining),
    scores: candidate.scores,
    matchedIntents: candidate.matchedIntents || [],
    restoreCostReason: candidate.restoreCostReason,
    reuseReason: candidate.reuseReason,
    trimSafety: candidate.trimSafety,
    rangeSegments: candidate.rangeSegments,
  };
}

function buildPressure(diagnostics, policy) {
  const totalKlineBars = number(diagnostics.klineBars);
  const totalIndicatorPoints = number(diagnostics.indicatorPoints);
  const estimatedBytes = number(diagnostics.estimatedBytes);
  const maxEstimatedBytes = positiveOrDefault(
    policy.frontendCacheBudgetBytes || policy.frontend_cache_budget_bytes || policy.maxEstimatedBytes,
    DEFAULT_POLICY.maxEstimatedBytes,
  );
  return {
    klineBars: Math.max(0, totalKlineBars - policy.maxKlineBars),
    indicatorPoints: Math.max(0, totalIndicatorPoints - policy.maxIndicatorPoints),
    estimatedBytes: Math.max(0, estimatedBytes - maxEstimatedBytes),
  };
}

function hasPressure(pressure) {
  return pressure.klineBars > 0 || pressure.indicatorPoints > 0 || pressure.estimatedBytes > 0;
}

function pressureSatisfied(remaining) {
  return remaining.klineBars <= 0 && remaining.indicatorPoints <= 0 && remaining.estimatedBytes <= 0;
}

export function planFrontendGc(diagnostics = {}, policyPatch = {}) {
  const policy = { ...DEFAULT_POLICY, ...policyPatch };
  policy.maxEstimatedBytes = positiveOrDefault(
    policy.frontendCacheBudgetBytes || policy.frontend_cache_budget_bytes || policy.maxEstimatedBytes,
    DEFAULT_POLICY.maxEstimatedBytes,
  );
  const nowMs = number(policy.nowMs) || Date.now();
  const entries = flattenDiagnostics(diagnostics, nowMs);
  const pressure = buildPressure(diagnostics, policy);
  const protectedEntries = [];
  const candidates = [];

  for (const entry of entries) {
    const protectedReason = shouldProtect(entry, policy);
    if (protectedReason) {
      protectedEntries.push({ ...entry, reason: protectedReason });
      continue;
    }
    if (entry.estimatedBytes <= 0 && entry.bars <= 0 && entry.points <= 0 && entry.items <= 0) {
      continue;
    }
    candidates.push(attachScores(entry, diagnostics, pressure));
  }

  const victims = [];
  const remaining = { ...pressure };
  if (hasPressure(pressure)) {
    for (const candidate of [...candidates].sort(sortCandidates)) {
      if (victims.length >= policy.maxVictims || pressureSatisfied(remaining)) break;
      victims.push(victimFrom(candidate, remaining));
      remaining.klineBars -= candidate.bars;
      remaining.indicatorPoints -= candidate.points;
      remaining.estimatedBytes -= candidate.estimatedBytes;
    }
  } else {
    for (const candidate of [...candidates].filter((entry) => entry.orphan).sort(sortCandidates)) {
      if (victims.length >= policy.maxVictims) break;
      victims.push(victimFrom(candidate, remaining));
    }
  }

  return {
    generatedAtMs: nowMs,
    mode: "dry-run",
    scoringVersion: 1,
    policy,
    pressure,
    runtimePressure: diagnostics.runtimePressure || {},
    wouldFreeBars: victims.reduce((total, entry) => total + entry.bars, 0),
    wouldFreeIndicatorPoints: victims.reduce((total, entry) => total + entry.points, 0),
    wouldFreeIndicatorItems: victims.reduce((total, entry) => total + entry.items, 0),
    wouldFreeEstimatedBytes: victims.reduce((total, entry) => total + entry.estimatedBytes, 0),
    candidateCount: candidates.length,
    protectedCount: protectedEntries.length,
    victims,
  };
}

export { DEFAULT_POLICY as FRONTEND_GC_DEFAULT_POLICY };
