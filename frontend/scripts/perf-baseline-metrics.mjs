export const DEFAULT_HEAP_MIN_WARMUP_MS = 60 * 1000;
export const DEFAULT_HEAP_MAX_WARMUP_MS = 5 * 60 * 1000;
export const DEFAULT_HEAP_COMPARISON_WINDOW_MS = 5 * 60 * 1000;

function median(values = []) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeHeapSamples(samples = [], durationMs = 0, options = {}) {
  const validSamples = samples
    .map((sample) => ({
      atMs: Number(sample.atMs),
      usedJSHeapSize: Number(sample.usedJSHeapSize),
    }))
    .filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.usedJSHeapSize))
    .sort((left, right) => left.atMs - right.atMs);
  const rawFirst = validSamples[0] ?? null;
  const duration = Math.max(0, Number(durationMs) || 0);
  const minWarmupMs = Math.max(0, Number(options.minWarmupMs) || DEFAULT_HEAP_MIN_WARMUP_MS);
  const maxWarmupMs = Math.max(minWarmupMs, Number(options.maxWarmupMs) || DEFAULT_HEAP_MAX_WARMUP_MS);
  const warmupMs = Math.min(
    maxWarmupMs,
    duration / 2,
    Math.max(minWarmupMs, duration * 0.1),
  );
  const warmupCutoffMs = rawFirst ? rawFirst.atMs + warmupMs : null;
  const stabilizedSamples = warmupCutoffMs == null
    ? []
    : validSamples.filter((sample) => sample.atMs >= warmupCutoffMs);
  const measuredSamples = stabilizedSamples.length > 0 ? stabilizedSamples : validSamples.slice(-1);
  const firstMeasured = measuredSamples[0] ?? null;
  const lastMeasured = measuredSamples[measuredSamples.length - 1] ?? null;
  const observedDurationMs = firstMeasured && lastMeasured
    ? Math.max(0, lastMeasured.atMs - firstMeasured.atMs)
    : 0;
  const maxComparisonWindowMs = Math.max(
    0,
    Number(options.comparisonWindowMs) || DEFAULT_HEAP_COMPARISON_WINDOW_MS,
  );
  const comparisonWindowMs = Math.min(maxComparisonWindowMs, observedDurationMs / 5);
  const firstWindow = firstMeasured
    ? measuredSamples.filter((sample) => sample.atMs <= firstMeasured.atMs + comparisonWindowMs)
    : [];
  const lastWindow = lastMeasured
    ? measuredSamples.filter((sample) => sample.atMs >= lastMeasured.atMs - comparisonWindowMs)
    : [];
  const baselineBytes = median(firstWindow.map((sample) => sample.usedJSHeapSize));
  const lastBytes = median(lastWindow.map((sample) => sample.usedJSHeapSize));
  const used = measuredSamples.map((sample) => sample.usedJSHeapSize);

  return {
    samples: validSamples.length,
    measuredSamples: measuredSamples.length,
    warmupMs,
    comparisonWindowMs,
    baselineWindowSamples: firstWindow.length,
    finalWindowSamples: lastWindow.length,
    rawFirstUsedJSHeapSize: rawFirst?.usedJSHeapSize ?? null,
    baselineUsedJSHeapSize: baselineBytes,
    lastUsedJSHeapSize: lastBytes,
    maxUsedJSHeapSize: used.length ? Math.max(...used) : null,
    deltaBytes: baselineBytes != null && lastBytes != null ? lastBytes - baselineBytes : null,
    deltaPct: baselineBytes > 0 && lastBytes != null
      ? Number((((lastBytes - baselineBytes) / baselineBytes) * 100).toFixed(3))
      : null,
    observedDurationMs,
  };
}

export function buildHeapAcceptance(
  heap,
  { requiredDurationMs = 60 * 60 * 1000, maxDeltaPct = 10 } = {},
) {
  const observedDurationMs = Number(heap?.observedDurationMs) || 0;
  const actual = heap?.deltaPct;
  const evaluated = observedDurationMs >= requiredDurationMs;
  return {
    actual,
    expected: `< ${maxDeltaPct}`,
    evaluated,
    requiredDurationMs,
    observedDurationMs,
    passed: evaluated ? Number.isFinite(actual) && actual < maxDeltaPct : null,
    note: evaluated
      ? "Compared with medians from the first and final stabilized heap windows."
      : "Reported only; the stabilized heap observation window is shorter than required.",
  };
}
