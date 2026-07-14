export const DRAWING_PERFORMANCE_SCHEMA_VERSION = "drawing-engine-v2-perf/v1";
export const DEFAULT_DRAWING_REPEAT_COUNT = 5;
export const DEFAULT_DRAWING_WARMUP_RUNS = 1;
export const DEFAULT_LONG_TASK_THRESHOLD_MS = 50;

export const DRAWING_METRIC_KEYS = Object.freeze([
  "drawingMainThreadMs",
  "inputToNextPaintMs",
  "eventTimingMs",
  "sceneProjectPaintMs",
  "frameIntervalMs",
  "hitQueryMs",
  "mouseupSyncMs",
  "workerFinalizeMs",
  "persistenceMs",
  "exactRenderMs",
  "activeOverlayCpuMs",
  "scriptDurationMs",
]);

export const DRAWING_COUNTER_KEYS = Object.freeze([
  "rawPoints",
  "renderedPoints",
  "visibleEntities",
  "culledEntities",
  "lodRatio",
  "anchorResolveCount",
  "finalProjectionCount",
  "staticProjectionCount",
  "sceneRebuildCount",
  "requestUpdateCount",
  "requestUpdatePerFrame",
  "surfacePrimitiveCount",
  "workerQueueDepth",
]);

const METRIC_ALIASES = Object.freeze({
  drawingMainThreadMs: ["drawingMainThreadMs", "drawingMainThread", "drawingCpuMs"],
  inputToNextPaintMs: [
    "inputToNextPaintMs",
    "pointerToNextPaintMs",
  ],
  eventTimingMs: ["eventTimingMs", "browserEventTimingMs"],
  sceneProjectPaintMs: ["sceneProjectPaintMs", "projectPaintMs", "zoomPanMs"],
  frameIntervalMs: [
    "frameIntervalMs",
    "rafIntervalsMs",
    "rafIntervalMs",
    "rafIntervals",
  ],
  hitQueryMs: ["hitQueryMs", "hitTestMs"],
  mouseupSyncMs: ["mouseupSyncMs", "mouseUpSyncMs"],
  workerFinalizeMs: ["workerFinalizeMs"],
  persistenceMs: ["persistenceMs", "persistMs"],
  exactRenderMs: ["exactRenderMs", "viewportExactRenderMs"],
  activeOverlayCpuMs: ["activeOverlayCpuMs", "overlayCpuMs"],
  scriptDurationMs: ["scriptDurationMs", "scriptDuration"],
});

const COUNTER_ALIASES = Object.freeze({
  rawPoints: ["rawPoints"],
  renderedPoints: ["renderedPoints"],
  visibleEntities: ["visibleEntities"],
  culledEntities: ["culledEntities"],
  lodRatio: ["lodRatio"],
  anchorResolveCount: ["anchorResolveCount"],
  finalProjectionCount: ["finalProjectionCount"],
  staticProjectionCount: ["staticProjectionCount"],
  sceneRebuildCount: ["sceneRebuildCount"],
  requestUpdateCount: ["requestUpdateCount"],
  requestUpdatePerFrame: ["requestUpdatePerFrame", "requestUpdatePerFrameMax"],
  surfacePrimitiveCount: ["surfacePrimitiveCount", "surfacePrimitiveMax"],
  workerQueueDepth: ["workerQueueDepth", "workerQueueDepthMax"],
});

export const DRAWING_PERFORMANCE_HARD_GATES = Object.freeze([
  Object.freeze({
    id: "drawing-main-thread-p95",
    path: "metrics.drawingMainThreadMs.p95",
    operator: "<=",
    expected: 4,
  }),
  Object.freeze({
    id: "drawing-main-thread-p99",
    path: "metrics.drawingMainThreadMs.p99",
    operator: "<=",
    expected: 8,
  }),
  Object.freeze({
    id: "input-to-next-paint-p95",
    path: "metrics.inputToNextPaintMs.p95",
    operator: "<=",
    expected: 20,
  }),
  Object.freeze({
    id: "input-to-next-paint-p99",
    path: "metrics.inputToNextPaintMs.p99",
    operator: "<=",
    expected: 33,
  }),
  Object.freeze({
    id: "scene-project-paint-p95",
    path: "metrics.sceneProjectPaintMs.p95",
    operator: "<=",
    expected: 10,
  }),
  Object.freeze({
    id: "scene-project-paint-p99",
    path: "metrics.sceneProjectPaintMs.p99",
    operator: "<=",
    expected: 16,
  }),
  Object.freeze({
    id: "frame-interval-p95",
    path: "metrics.frameIntervalMs.p95",
    operator: "<=",
    expected: 20,
  }),
  Object.freeze({
    id: "frame-interval-p99",
    path: "metrics.frameIntervalMs.p99",
    operator: "<=",
    expected: 33.4,
  }),
  Object.freeze({
    id: "hit-query-p95",
    path: "metrics.hitQueryMs.p95",
    operator: "<=",
    expected: 1,
  }),
  Object.freeze({
    id: "hit-query-p99",
    path: "metrics.hitQueryMs.p99",
    operator: "<=",
    expected: 2,
  }),
  Object.freeze({
    id: "hit-query-max",
    path: "metrics.hitQueryMs.max",
    operator: "<=",
    expected: 4,
  }),
  Object.freeze({
    id: "mouseup-sync-p95",
    path: "metrics.mouseupSyncMs.p95",
    operator: "<=",
    expected: 8,
  }),
  Object.freeze({
    id: "mouseup-sync-p99",
    path: "metrics.mouseupSyncMs.p99",
    operator: "<=",
    expected: 16,
  }),
  Object.freeze({
    id: "worker-finalize-p95",
    path: "metrics.workerFinalizeMs.p95",
    operator: "<=",
    expected: 150,
  }),
  Object.freeze({
    id: "persistence-p95",
    path: "metrics.persistenceMs.p95",
    operator: "<=",
    expected: 500,
  }),
  Object.freeze({
    id: "exact-render-max",
    path: "metrics.exactRenderMs.max",
    operator: "<=",
    expected: 120,
  }),
  Object.freeze({
    id: "drawing-long-task-count",
    path: "longTasks.attributableCount",
    operator: "===",
    expected: 0,
  }),
  Object.freeze({
    id: "active-overlay-cpu-p95",
    path: "metrics.activeOverlayCpuMs.p95",
    operator: "<=",
    expected: 2,
  }),
  Object.freeze({
    id: "static-projection-count",
    path: "counters.staticProjectionCount.max",
    operator: "===",
    expected: 0,
  }),
  Object.freeze({
    id: "scene-rebuild-count",
    path: "counters.sceneRebuildCount.max",
    operator: "===",
    expected: 0,
  }),
  Object.freeze({
    id: "surface-primitive-count",
    path: "counters.surfacePrimitiveCount.max",
    operator: "===",
    expected: 1,
  }),
  Object.freeze({
    id: "request-update-per-frame",
    path: "counters.requestUpdatePerFrame.max",
    operator: "<=",
    expected: 1,
  }),
  Object.freeze({
    id: "worker-queue-depth",
    path: "counters.workerQueueDepth.max",
    operator: "<=",
    expected: 2,
  }),
]);

function numericValue(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function numericSamples(values) {
  if (!Array.isArray(values)) return [];
  return values.map(numericValue).filter((value) => value != null);
}

export function percentile(values = [], requestedPercentile = 50) {
  const valid = numericSamples(values);
  const rank = numericValue(requestedPercentile);
  if (valid.length === 0 || rank == null || rank < 0 || rank > 100) return null;
  const sorted = [...valid].sort((left, right) => left - right);
  if (rank === 0) return sorted[0];
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function summarizeSamples(values = []) {
  const sourceCount = Array.isArray(values) ? values.length : 0;
  const valid = numericSamples(values);
  if (valid.length === 0) {
    return {
      valid: false,
      samples: 0,
      invalidSamples: sourceCount,
      min: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
      stddev: null,
    };
  }

  const total = valid.reduce((sum, value) => sum + value, 0);
  const mean = total / valid.length;
  const variance = valid.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / valid.length;

  return {
    valid: true,
    samples: valid.length,
    invalidSamples: sourceCount - valid.length,
    min: Math.min(...valid),
    p50: percentile(valid, 50),
    p90: percentile(valid, 90),
    p95: percentile(valid, 95),
    p99: percentile(valid, 99),
    max: Math.max(...valid),
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
  };
}

export const summarizeDistribution = summarizeSamples;

function sampleTimestamp(sample) {
  if (sample == null || typeof sample !== "object") return null;
  return numericValue(sample.atMs ?? sample.startTime ?? sample.timestampMs ?? sample.timeMs);
}

export function discardWarmup(samples = [], options = {}) {
  if (!Array.isArray(samples)) return [];
  const normalizedOptions = typeof options === "number"
    ? { warmupSamples: options }
    : (options ?? {});
  const warmupSamples = Math.max(
    0,
    Math.floor(numericValue(
      normalizedOptions.warmupSamples
      ?? normalizedOptions.warmupRuns
      ?? normalizedOptions.count
      ?? 0,
    ) ?? 0),
  );
  const warmupMs = Math.max(0, numericValue(normalizedOptions.warmupMs) ?? 0);
  const firstTimestamp = samples.map(sampleTimestamp).find((value) => value != null) ?? null;
  const cutoff = firstTimestamp == null ? null : firstTimestamp + warmupMs;

  return samples.filter((sample, index) => {
    if (index < warmupSamples) return false;
    if (cutoff == null || warmupMs === 0) return true;
    const timestamp = sampleTimestamp(sample);
    return timestamp != null && timestamp >= cutoff;
  });
}

function normalizeInterval(value) {
  if (value == null || typeof value !== "object") return null;
  const startTime = numericValue(value.startTime ?? value.atMs ?? value.timestampMs);
  const explicitEnd = numericValue(value.endTime ?? value.endMs);
  const duration = numericValue(value.duration ?? value.durationMs);
  const endTime = explicitEnd ?? (startTime != null && duration != null ? startTime + duration : null);
  if (startTime == null || endTime == null || endTime <= startTime) return null;
  return { startTime, endTime, duration: endTime - startTime };
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((left, right) => left.startTime - right.startTime);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startTime > previous.endTime) {
      merged.push({ ...interval });
    } else {
      previous.endTime = Math.max(previous.endTime, interval.endTime);
      previous.duration = previous.endTime - previous.startTime;
    }
  }
  return merged;
}

function overlapDuration(interval, windows) {
  const overlaps = [];
  for (const window of windows) {
    const startTime = Math.max(interval.startTime, window.startTime);
    const endTime = Math.min(interval.endTime, window.endTime);
    if (endTime > startTime) overlaps.push({ startTime, endTime, duration: endTime - startTime });
  }
  return mergeIntervals(overlaps).reduce((sum, overlap) => sum + overlap.duration, 0);
}

function containsDrawingAttribution(value) {
  if (typeof value === "string") return /drawing|candlescope/i.test(value);
  if (Array.isArray(value)) return value.some(containsDrawingAttribution);
  if (value == null || typeof value !== "object") return false;
  return [
    value.name,
    value.source,
    value.category,
    value.containerName,
    value.containerType,
  ].some(containsDrawingAttribution);
}

export function attributeLongTasks(longTasks = [], drawingWindows = [], options = {}) {
  const thresholdMs = Math.max(
    0,
    numericValue(options.thresholdMs) ?? DEFAULT_LONG_TASK_THRESHOLD_MS,
  );
  const minimumOverlapMs = Math.max(0, numericValue(options.minimumOverlapMs) ?? 0);
  const windows = Array.isArray(drawingWindows)
    ? drawingWindows.map(normalizeInterval).filter(Boolean)
    : [];
  const tasks = Array.isArray(longTasks) ? longTasks : [];
  const entries = [];
  let observedCount = 0;

  tasks.forEach((task, index) => {
    const interval = normalizeInterval(task);
    if (!interval) return;
    observedCount += 1;
    if (interval.duration <= thresholdMs) return;

    const overlapMs = overlapDuration(interval, windows);
    const explicit = task.drawingAttributable === true;
    const namedAttribution = containsDrawingAttribution(
      task.attribution ?? task.source ?? task.category ?? task.name,
    );
    const overlapAttribution = overlapMs > minimumOverlapMs;
    const attributable = explicit || namedAttribution || overlapAttribution;
    const reason = explicit
      ? "explicit"
      : namedAttribution
        ? "attribution"
        : overlapAttribution
          ? "overlap"
          : "none";

    entries.push({
      index,
      startTime: interval.startTime,
      duration: interval.duration,
      endTime: interval.endTime,
      overlapMs: round(overlapMs),
      attributable,
      reason,
    });
  });

  const attributableEntries = entries.filter((entry) => entry.attributable);
  const unattributedEntries = entries.filter((entry) => !entry.attributable);
  const sumDuration = (values) => round(
    values.reduce((sum, entry) => sum + entry.duration, 0),
  );

  return {
    thresholdMs,
    observedCount,
    overThresholdCount: entries.length,
    attributableCount: attributableEntries.length,
    unattributedCount: unattributedEntries.length,
    attributableDurationMs: sumDuration(attributableEntries),
    unattributedDurationMs: sumDuration(unattributedEntries),
    maxAttributableDurationMs: attributableEntries.length
      ? Math.max(...attributableEntries.map((entry) => entry.duration))
      : null,
    entries,
  };
}

function readAliasedValue(source, aliases) {
  if (source == null || typeof source !== "object") return undefined;
  for (const alias of aliases) {
    if (Object.hasOwn(source, alias)) return source[alias];
  }
  return undefined;
}

function metricSamplesForRun(run, key) {
  const aliases = METRIC_ALIASES[key];
  const fromSamples = readAliasedValue(run?.samples, aliases);
  const fromMetrics = readAliasedValue(run?.metrics, aliases);
  const value = fromSamples ?? fromMetrics ?? readAliasedValue(run, aliases);
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.raw)) return value.raw;
  return value === undefined ? [] : [value];
}

function counterValuesForRun(run, key) {
  const value = readAliasedValue(run?.counters, COUNTER_ALIASES[key]);
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

export function summarizeRun(run = {}, options = {}) {
  const metrics = {};
  const counters = {};
  let metricSamples = 0;
  for (const key of DRAWING_METRIC_KEYS) {
    metrics[key] = summarizeSamples(metricSamplesForRun(run, key));
    metricSamples += metrics[key].samples;
  }
  for (const key of DRAWING_COUNTER_KEYS) {
    counters[key] = summarizeSamples(counterValuesForRun(run, key));
  }

  const longTasks = attributeLongTasks(
    run.longTasks,
    run.drawingWindows ?? run.drawingSpans,
    { thresholdMs: options.longTaskThresholdMs },
  );

  return {
    id: run.id ?? run.runId ?? null,
    iteration: numericValue(run.iteration) ?? null,
    warmup: run.warmup === true,
    valid: metricSamples > 0,
    metricSamples,
    metrics,
    counters,
    longTasks,
    scriptDurationMs: numericValue(run.scriptDurationMs),
    heap: run.heap ?? null,
    worker: run.worker ?? null,
  };
}

function summarizeVariability(runSummaries, key) {
  const runP95 = runSummaries
    .map((run) => run.metrics[key].p95)
    .filter((value) => value != null);
  const summary = summarizeSamples(runP95);
  const relativeRangePct = summary.valid && summary.mean !== 0
    ? round(((summary.max - summary.min) / Math.abs(summary.mean)) * 100, 3)
    : summary.valid && summary.max === summary.min
      ? 0
      : null;
  const coefficientOfVariationPct = summary.valid && summary.mean !== 0
    ? round((summary.stddev / Math.abs(summary.mean)) * 100, 3)
    : summary.valid && summary.stddev === 0
      ? 0
      : null;

  return {
    measuredRuns: runSummaries.length,
    runsWithSamples: runP95.length,
    runP95,
    minP95: summary.min,
    maxP95: summary.max,
    meanP95: summary.mean,
    stddevP95: summary.stddev,
    relativeRangePct,
    coefficientOfVariationPct,
  };
}

function getPath(source, path) {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value?.[key], source);
}

function normalizeGateDefinitions(gates) {
  if (Array.isArray(gates)) return gates;
  if (gates == null || typeof gates !== "object") return [];
  return Object.entries(gates).map(([path, definition]) => {
    if (definition != null && typeof definition === "object") {
      return { path, ...definition };
    }
    return { path, operator: "<=", expected: definition };
  });
}

function normalizeGate(gate, index) {
  if (gate == null || typeof gate !== "object") {
    return { id: `gate-${index + 1}`, path: null, operator: null, expected: null };
  }
  let operator = gate.operator ?? gate.op ?? null;
  let expected = gate.expected ?? gate.threshold ?? gate.limit;
  if (operator == null && Object.hasOwn(gate, "max")) {
    operator = "<=";
    expected = gate.max;
  } else if (operator == null && Object.hasOwn(gate, "lessThan")) {
    operator = "<";
    expected = gate.lessThan;
  } else if (operator == null && Object.hasOwn(gate, "min")) {
    operator = ">=";
    expected = gate.min;
  } else if (operator == null && Object.hasOwn(gate, "equals")) {
    operator = "===";
    expected = gate.equals;
  }
  return {
    id: String(gate.id ?? gate.name ?? gate.path ?? `gate-${index + 1}`),
    path: gate.path ?? gate.metric ?? null,
    operator: operator ?? "<=",
    expected: expected ?? null,
    note: gate.note ?? null,
  };
}

function compareGate(actual, operator, expected) {
  if (actual == null || (typeof actual === "number" && !Number.isFinite(actual))) {
    return { passed: false, reason: "missing-or-non-finite-actual" };
  }
  if (expected == null || (typeof expected === "number" && !Number.isFinite(expected))) {
    return { passed: false, reason: "missing-or-non-finite-expected" };
  }

  let passed;
  if (operator === "<") passed = actual < expected;
  else if (operator === "<=") passed = actual <= expected;
  else if (operator === ">") passed = actual > expected;
  else if (operator === ">=") passed = actual >= expected;
  else if (operator === "==" || operator === "===") passed = actual === expected;
  else if (operator === "!=" || operator === "!==") passed = actual !== expected;
  else return { passed: false, reason: "unsupported-operator" };

  return { passed, reason: passed ? "passed" : "comparison-failed" };
}

export function evaluateGates(source, gates = []) {
  const definitions = normalizeGateDefinitions(gates);
  const results = definitions.map((gate, index) => {
    const normalized = normalizeGate(gate, index);
    const actual = getPath(source, normalized.path);
    const comparison = normalized.path
      ? compareGate(actual, normalized.operator, normalized.expected)
      : { passed: false, reason: "missing-path" };
    return {
      ...normalized,
      actual: actual ?? null,
      passed: comparison.passed,
      reason: comparison.reason,
    };
  });
  const failedCount = results.filter((result) => !result.passed).length;
  return {
    passed: failedCount === 0,
    evaluated: results.length,
    passedCount: results.length - failedCount,
    failedCount,
    results,
  };
}

export const evaluatePerformanceGates = evaluateGates;

function aggregateLongTasks(runSummaries) {
  const entries = runSummaries.flatMap((run, runIndex) => run.longTasks.entries.map((entry) => ({
    runIndex,
    ...entry,
  })));
  const attributable = entries.filter((entry) => entry.attributable);
  const unattributed = entries.filter((entry) => !entry.attributable);
  return {
    thresholdMs: runSummaries[0]?.longTasks.thresholdMs ?? DEFAULT_LONG_TASK_THRESHOLD_MS,
    observedCount: runSummaries.reduce((sum, run) => sum + run.longTasks.observedCount, 0),
    overThresholdCount: entries.length,
    attributableCount: attributable.length,
    unattributedCount: unattributed.length,
    attributableDurationMs: round(
      attributable.reduce((sum, entry) => sum + entry.duration, 0),
    ),
    unattributedDurationMs: round(
      unattributed.reduce((sum, entry) => sum + entry.duration, 0),
    ),
    maxAttributableDurationMs: attributable.length
      ? Math.max(...attributable.map((entry) => entry.duration))
      : null,
    entries,
  };
}

function classifyRuns(runs, warmupRuns) {
  const hasExplicitWarmup = runs.some((run) => typeof run?.warmup === "boolean");
  if (hasExplicitWarmup) {
    return {
      warmup: runs.filter((run) => run?.warmup === true),
      measured: runs.filter((run) => run?.warmup !== true),
    };
  }
  return {
    warmup: runs.slice(0, warmupRuns),
    measured: runs.slice(warmupRuns),
  };
}

function runSampleCaptureIsComplete(run, key) {
  const completeness = run?.sampleCompleteness?.[key];
  if (completeness === undefined) return true;
  if (typeof completeness === "boolean") return completeness;
  return completeness?.complete === true
    && Number(completeness?.dropped ?? 0) === 0
    && Number(completeness?.retained ?? 0) === Number(completeness?.observed ?? 0);
}

function runDiagnosticsAreClean(run) {
  if (run?.valid === false || run?.validity?.passed === false) return false;
  const diagnostics = run?.diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return true;
  return ["consoleErrors", "runtimeExceptions", "networkFailures"].every((key) => (
    !Array.isArray(diagnostics[key]) || diagnostics[key].length === 0
  ));
}

export function summarizeScenarioRuns(runs = [], options = {}) {
  const inputRuns = Array.isArray(runs) ? runs : [];
  const warmupRuns = Math.max(
    0,
    Math.floor(numericValue(options.warmupRuns) ?? DEFAULT_DRAWING_WARMUP_RUNS),
  );
  const requiredMeasuredRuns = Math.max(
    1,
    Math.floor(numericValue(options.requiredMeasuredRuns ?? options.minimumRuns)
      ?? DEFAULT_DRAWING_REPEAT_COUNT),
  );
  const classified = classifyRuns(inputRuns, warmupRuns);
  const warmupSummaries = classified.warmup.map((run) => summarizeRun(run, options));
  const measuredSummaries = classified.measured.map((run) => summarizeRun(run, options));
  const metrics = {};
  const counters = {};
  const variability = {};

  for (const key of DRAWING_METRIC_KEYS) {
    const samples = classified.measured.flatMap((run) => metricSamplesForRun(run, key));
    metrics[key] = summarizeSamples(samples);
    variability[key] = summarizeVariability(measuredSummaries, key);
  }
  for (const key of DRAWING_COUNTER_KEYS) {
    const values = classified.measured.flatMap((run) => counterValuesForRun(run, key));
    counters[key] = summarizeSamples(values);
  }

  const discoveredMetrics = DRAWING_METRIC_KEYS.filter((key) => (
    measuredSummaries.some((run) => run.metrics[key].samples > 0)
  ));
  const requiredMetrics = Array.isArray(options.requiredMetrics)
    ? options.requiredMetrics.filter((key) => DRAWING_METRIC_KEYS.includes(key))
    : discoveredMetrics;
  const hasSamples = discoveredMetrics.length > 0;
  const rawSamplesComplete = hasSamples && requiredMetrics.every((key) => (
    measuredSummaries.every((run) => (
      run.metrics[key].samples > 0 && run.metrics[key].invalidSamples === 0
    )) && classified.measured.every((run) => runSampleCaptureIsComplete(run, key))
  ));
  const repetitionsComplete = measuredSummaries.length >= requiredMeasuredRuns;
  const warmupComplete = warmupSummaries.length >= warmupRuns;
  // Warm-up is discarded from statistics, not from correctness evidence.
  // Initialization-only console/runtime/network failures must still invalidate
  // a benchmark rather than disappearing with the warm-up samples.
  const diagnosticsClean = [...classified.warmup, ...classified.measured]
    .every(runDiagnosticsAreClean);
  const measurementValid = repetitionsComplete
    && warmupComplete
    && rawSamplesComplete
    && diagnosticsClean;
  const summary = {
    id: options.id ?? options.scenarioId ?? null,
    fixture: {
      bars: numericValue(options.fixture?.bars ?? options.bars),
      entities: numericValue(options.fixture?.entities ?? options.entities),
      points: numericValue(options.fixture?.points ?? options.points),
      mode: options.fixture?.mode ?? options.mode ?? null,
      dpr: numericValue(options.fixture?.dpr ?? options.dpr),
    },
    repetitions: {
      totalRuns: inputRuns.length,
      warmupRuns: warmupSummaries.length,
      measuredRuns: measuredSummaries.length,
      requiredMeasuredRuns,
      repetitionsComplete,
      warmupComplete,
      requiredMetrics,
      rawSamplesComplete,
      diagnosticsClean,
      valid: measurementValid,
    },
    metrics,
    counters,
    variability,
    longTasks: aggregateLongTasks(measuredSummaries),
    runs: {
      warmup: warmupSummaries,
      measured: measuredSummaries,
    },
  };
  const gates = evaluateGates(summary, options.gates ?? []);

  return {
    ...summary,
    gates,
    passed: measurementValid && gates.passed,
    rawRuns: inputRuns,
  };
}

export const summarizeRepeatedRuns = summarizeScenarioRuns;

function normalizeBrowser(value) {
  if (typeof value === "string") return { name: value, version: null, userAgent: null };
  return {
    name: value?.name ?? null,
    version: value?.version ?? null,
    userAgent: value?.userAgent ?? null,
  };
}

function normalizeMachine(value) {
  return {
    platform: value?.platform ?? null,
    release: value?.release ?? null,
    arch: value?.arch ?? null,
    cpu: value?.cpu ?? null,
    logicalCores: numericValue(value?.logicalCores),
    memoryBytes: numericValue(value?.memoryBytes),
  };
}

export function buildDrawingPerformanceReport(input = {}) {
  const scenarioInputs = Array.isArray(input.scenarios) ? input.scenarios : [];
  const defaultConfiguration = {
    requiredMeasuredRuns: Math.max(
      1,
      Math.floor(numericValue(input.configuration?.requiredMeasuredRuns)
        ?? DEFAULT_DRAWING_REPEAT_COUNT),
    ),
    warmupRuns: Math.max(
      0,
      Math.floor(numericValue(input.configuration?.warmupRuns)
        ?? DEFAULT_DRAWING_WARMUP_RUNS),
    ),
    longTaskThresholdMs: Math.max(
      0,
      numericValue(input.configuration?.longTaskThresholdMs)
        ?? DEFAULT_LONG_TASK_THRESHOLD_MS,
    ),
    seed: input.configuration?.seed ?? null,
  };
  const scenarios = scenarioInputs.map((scenario, index) => summarizeScenarioRuns(
    scenario.runs,
    {
      ...defaultConfiguration,
      ...scenario,
      id: scenario.id ?? `scenario-${index + 1}`,
      fixture: scenario.fixture,
      gates: scenario.gates ?? input.gatesByScenario?.[scenario.id] ?? [],
    },
  ));
  const failedScenarioIds = scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => scenario.id);
  const invalidScenarioIds = scenarios
    .filter((scenario) => !scenario.repetitions.valid)
    .map((scenario) => scenario.id);

  return {
    schemaVersion: DRAWING_PERFORMANCE_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    context: {
      commit: input.context?.commit ?? input.metadata?.commit ?? null,
      browser: normalizeBrowser(input.context?.browser ?? input.metadata?.browser),
      machine: normalizeMachine(input.context?.machine ?? input.metadata?.machine),
      mode: input.context?.mode ?? input.metadata?.mode ?? null,
    },
    environment: {
      viewport: {
        width: numericValue(input.environment?.viewport?.width),
        height: numericValue(input.environment?.viewport?.height),
      },
      dpr: numericValue(input.environment?.dpr),
      refreshRateHz: numericValue(input.environment?.refreshRateHz),
      productionBuild: input.environment?.productionBuild === true,
    },
    configuration: defaultConfiguration,
    scenarios,
    acceptance: {
      passed: scenarios.length > 0 && failedScenarioIds.length === 0,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.length - failedScenarioIds.length,
      failedScenarioIds,
      invalidScenarioIds,
    },
  };
}

export const createDrawingPerformanceReport = buildDrawingPerformanceReport;

function stableJsonValue(value, ancestors = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) throw new TypeError("Cannot serialize a circular performance report");

  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => stableJsonValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = stableJsonValue(value[key], ancestors);
    if (normalized !== undefined) result[key] = normalized;
  }
  ancestors.delete(value);
  return result;
}

export function stableStringify(value, space = 2) {
  return JSON.stringify(stableJsonValue(value), null, space);
}

export const serializePerformanceReport = stableStringify;
