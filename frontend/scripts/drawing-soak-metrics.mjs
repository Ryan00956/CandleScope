export const DRAWING_SOAK_DEFAULTS = Object.freeze({
  durationMs: 66 * 60 * 1_000,
  warmupMs: 5 * 60 * 1_000,
  requiredMeasuredDurationMs: 60 * 60 * 1_000,
  sampleIntervalMs: 5_000,
  gcIntervalMs: 5 * 60 * 1_000,
  workloadIntervalMs: 15_000,
  comparisonWindowMs: 5 * 60 * 1_000,
  minSampleCoverage: 0.95,
  maxSampleGapMs: 15_000,
  maxHeapDeltaPct: 10,
  maxHeapSlopePctPerHour: 2,
  heapSlopeNoiseFloorBytesPerHour: 1024 * 1024,
  terminalPlateauPct: 2,
  terminalPlateauNoiseFloorBytes: 1024 * 1024,
  minGcCheckpoints: 13,
  plateauWindowSize: 3,
  minDistinctViewportRevisions: 4,
  maxWorkerQueueDepth: 2,
  maxWorkerInFlight: 1,
  frameIntervalP95Ms: 20,
  frameIntervalP99Ms: 33.4,
  inputToNextPaintP95Ms: 20,
  inputToNextPaintP99Ms: 33,
});

export const DRAWING_SOAK_FIXED_CONTRACT = Object.freeze({
  bars: 10_000,
  dpr: 1.5,
  seed: 0x0cada5c0,
  intervalSeconds: 3_600,
  mockEndTime: 1_783_987_200,
  fixtureName: "freehand64x512",
  fixtureEntities: 64,
  fixturePoints: 32_768,
  fixtureRawSha256: "7922bfb77f07fc73d0be17480480b36088abb4efebfc58293107793afb29e422",
  refreshRateHzMin: 55,
  refreshRateHzMax: 65,
  maxInstrumentationWindowMs: 10_000,
});

const DRAWING_EVENT_LATENCY_INPUT_TYPES = Object.freeze([
  "pointerdown",
  "pointermove",
  "pointerup",
  "wheel",
]);

const DRAWING_EVENT_LATENCY_TRACE_CATEGORIES = Object.freeze([
  "benchmark",
  "input",
  "input.scrolling",
  "latency",
  "latencyInfo",
]);

const DRAWING_EVENT_LATENCY_CONFIGURATION = Object.freeze({
  dispatchesPerType: 128,
  maxAttempts: 2,
  p95ThresholdMs: 20,
  p99ThresholdMs: 33,
  p95MinimumSamples: 20,
  p99MinimumSamples: 100,
  maxTraceBytes: 64 * 1024 * 1024,
  categories: DRAWING_EVENT_LATENCY_TRACE_CATEGORIES,
});

export const DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT = Object.freeze({
  schemaVersion: "drawing-event-latency-calibration/v1",
  window: "post-formal-soak",
  scenarioId: "freehand-64x512-viewport",
  inputTypes: DRAWING_EVENT_LATENCY_INPUT_TYPES,
  configuration: DRAWING_EVENT_LATENCY_CONFIGURATION,
});

export function phase9MeasuredWorkloadDeadline(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("Phase 9 measured-window elapsed time must be finite and non-negative");
  }
  return elapsedMs;
}

export function selectPhase9SoakDueAction({
  elapsedMs,
  nextWorkloadAtMs,
  nextSampleAtMs,
  nextGcAtMs,
}) {
  const deadlines = [
    ["workload", nextWorkloadAtMs],
    ["sample", nextSampleAtMs],
    ["gc", nextGcAtMs],
  ];
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0
    || deadlines.some(([, deadline]) => !Number.isFinite(deadline) || deadline < 0)) {
    throw new TypeError("Phase 9 scheduler deadlines must be finite and non-negative");
  }
  return deadlines.find(([, deadline]) => elapsedMs >= deadline)?.[0] ?? null;
}

const DRAWING_SOAK_CONFIGURATION_KEYS = Object.freeze(Object.keys(DRAWING_SOAK_DEFAULTS));
const DRAWING_SOAK_INTEGER_CONFIGURATION_KEYS = Object.freeze(new Set([
  "durationMs",
  "warmupMs",
  "requiredMeasuredDurationMs",
  "sampleIntervalMs",
  "gcIntervalMs",
  "workloadIntervalMs",
  "comparisonWindowMs",
  "maxSampleGapMs",
  "heapSlopeNoiseFloorBytesPerHour",
  "terminalPlateauNoiseFloorBytes",
  "minGcCheckpoints",
  "plateauWindowSize",
  "minDistinctViewportRevisions",
  "maxWorkerQueueDepth",
  "maxWorkerInFlight",
]));

function drawingSoakConfigurationEvidence(configuration) {
  return configuration !== null
    && typeof configuration === "object"
    && !Array.isArray(configuration)
    && DRAWING_SOAK_CONFIGURATION_KEYS.every((key) => (
      Object.hasOwn(configuration, key)
        && typeof configuration[key] === "number"
        && Number.isFinite(configuration[key])
        && (!DRAWING_SOAK_INTEGER_CONFIGURATION_KEYS.has(key)
          || Number.isSafeInteger(configuration[key]))
    ));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function median(values) {
  const sorted = values
    .map(finiteNumber)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const STAMP_REVISION_KEYS = Object.freeze([
  "documentRevision",
  "surfaceGeneration",
  "dataRevision",
  "projectionRevision",
  "lineageIndexRevision",
  "viewportRevision",
  "themeRevision",
]);

function validStamp(stamp) {
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return false;
  if (typeof stamp.scopeKey !== "string" || stamp.scopeKey.length === 0) return false;
  return STAMP_REVISION_KEYS.every(
    (key) => Number.isSafeInteger(stamp[key]) && stamp[key] >= 0,
  )
    && nonNegativeNumber(stamp.widthCssPx) > 0
    && nonNegativeNumber(stamp.heightCssPx) > 0
    && nonNegativeNumber(stamp.dpr) > 0;
}

function sameStamp(left, right) {
  return validStamp(left)
    && validStamp(right)
    && left.scopeKey === right.scopeKey
    && STAMP_REVISION_KEYS.every((key) => left[key] === right[key])
    && left.widthCssPx === right.widthCssPx
    && left.heightCssPx === right.heightCssPx
    && left.dpr === right.dpr;
}

function heapEvidence(heap) {
  const workers = Array.isArray(heap?.workers) ? heap.workers : [];
  const componentEvidence = (componentKey, aggregateKey) => {
    const pageValue = nonNegativeNumber(heap?.page?.[componentKey]);
    const aggregateValue = nonNegativeNumber(heap?.[aggregateKey]);
    const workerValues = workers.map((worker) => nonNegativeNumber(worker?.[componentKey]));
    const componentTotal = pageValue !== null && workerValues.every((value) => value !== null)
      ? pageValue + workerValues.reduce((total, value) => total + value, 0)
      : null;
    return Object.freeze({
      valid: pageValue !== null
        && aggregateValue !== null
        && workerValues.every((value) => value !== null)
        && aggregateValue === componentTotal,
      pageValue,
      aggregateValue,
      workerValues,
      componentTotal,
    });
  };
  const used = componentEvidence("usedSize", "aggregateUsedSize");
  const backing = componentEvidence("backingStorageSize", "aggregateBackingStorageSize");
  const embedder = componentEvidence(
    "embedderHeapUsedSize",
    "aggregateEmbedderHeapUsedSize",
  );
  return Object.freeze({
    valid: workers.length === 1 && used.valid && backing.valid && embedder.valid,
    workerCount: workers.length,
    used,
    backing,
    embedder,
  });
}

function domEvidence(dom) {
  return ["documents", "nodes", "jsEventListeners"]
    .every((key) => nonNegativeNumber(dom?.[key]) !== null);
}

function performanceEvidence(performance) {
  return ["Timestamp", "TaskDuration", "ScriptDuration"]
    .every((key) => nonNegativeNumber(performance?.[key]) !== null);
}

const REQUIRED_BROWSER_TIMING_METRICS = Object.freeze([
  "frameIntervalMs",
  "inputToNextPaintMs",
  "eventTimingMs",
  "mouseupSyncMs",
]);

const BROWSER_TIMING_CAPTURE_KEYS = Object.freeze({
  frameIntervalMs: "rafIntervalsMs",
  inputToNextPaintMs: "inputToNextPaintMs",
  eventTimingMs: "eventTimingMs",
  mouseupSyncMs: "mouseupSyncMs",
});

const DRAWING_INPUT_TYPES = Object.freeze([
  "pointerdown",
  "pointermove",
  "pointerup",
  "wheel",
]);
const DRAWING_INPUT_POST_RAF_TASK_SCHEMA_VERSION = "drawing-input-post-raf-task/v2";
const DRAWING_INPUT_PAINT_FENCE_CAPACITY = 64;
const DRAWING_INPUT_P95_MINIMUM_SAMPLES = 20;
const DRAWING_INPUT_P99_MINIMUM_SAMPLES = 100;

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function histogramPercentile(metric, percentile) {
  const counts = metric?.bucketCounts;
  const totalCount = nonNegativeNumber(metric?.totalCount);
  const bucketWidthMs = nonNegativeNumber(metric?.bucketWidthMs);
  const maxMs = nonNegativeNumber(metric?.maxMs);
  if (!Array.isArray(counts)
    || !Number.isSafeInteger(totalCount)
    || totalCount <= 0
    || bucketWidthMs === null
    || bucketWidthMs <= 0
    || maxMs === null) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * totalCount));
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    cumulative += counts[index];
    if (cumulative < rank) continue;
    if (index === counts.length - 1) return maxMs;
    return Math.min(maxMs, (index + 1) * bucketWidthMs);
  }
  return null;
}

function browserTimingMetricEvidence(metric, capture, { requireBuckets = false } = {}) {
  const totalCount = nonNegativeNumber(metric?.totalCount);
  const invalidCount = nonNegativeNumber(metric?.invalidCount);
  const captureObserved = nonNegativeNumber(metric?.captureObserved);
  const bucketWidthMs = nonNegativeNumber(metric?.bucketWidthMs);
  const histogramMaxMs = nonNegativeNumber(metric?.histogramMaxMs);
  const bucketCount = nonNegativeNumber(metric?.bucketCount);
  const overflowCount = nonNegativeNumber(metric?.overflowCount);
  const p50Ms = nonNegativeNumber(metric?.p50Ms);
  const p95Ms = nonNegativeNumber(metric?.p95Ms);
  const p99Ms = nonNegativeNumber(metric?.p99Ms);
  const maxMs = nonNegativeNumber(metric?.maxMs);
  const captureCount = nonNegativeNumber(capture?.observed);
  const buckets = metric?.bucketCounts;
  const bucketsValid = !requireBuckets || (Array.isArray(buckets)
    && Number.isSafeInteger(bucketCount)
    && buckets.length === bucketCount
    && buckets.every((count) => Number.isSafeInteger(count) && count >= 0)
    && buckets.reduce((sum, count) => sum + count, 0) === totalCount
    && buckets.at(-1) === overflowCount
    && histogramPercentile(metric, 50) === p50Ms
    && histogramPercentile(metric, 95) === p95Ms
    && histogramPercentile(metric, 99) === p99Ms);
  return Number.isSafeInteger(totalCount)
    && totalCount > 0
    && Number.isSafeInteger(invalidCount)
    && invalidCount === 0
    && Number.isSafeInteger(captureObserved)
    && captureObserved === totalCount
    && Number.isSafeInteger(captureCount)
    && captureCount === totalCount
    && bucketWidthMs !== null
    && bucketWidthMs > 0
    && histogramMaxMs !== null
    && histogramMaxMs > 0
    && Number.isSafeInteger(bucketCount)
    && bucketCount > 1
    && Number.isSafeInteger(overflowCount)
    && overflowCount <= totalCount
    && p50Ms !== null
    && p95Ms !== null
    && p99Ms !== null
    && maxMs !== null
    && p50Ms <= p95Ms
    && p95Ms <= p99Ms
    && p99Ms <= maxMs
    && bucketsValid;
}

function browserTypedInputEvidence(timing, { requireBuckets = false } = {}) {
  if (!hasExactKeys(timing?.inputEventCounts, DRAWING_INPUT_TYPES)
    || !hasExactKeys(timing?.inputPaintFenceStats, DRAWING_INPUT_TYPES)
    || !hasExactKeys(timing?.inputToNextPaintByType, DRAWING_INPUT_TYPES)) return false;

  const overall = timing?.inputFenceOverall;
  const overallIntegerKeys = [
    "eventCount",
    "completedEventCount",
    "droppedEventCount",
    "pendingEventCount",
    "frozenEventCount",
    "fenceCount",
    "typeFenceCount",
    "postRafInputCount",
    "inputWhileFrozenCount",
    "unattributedEventCount",
    "unattributedFenceCount",
    "frozenFenceCount",
    "staleFrameCallbackCount",
    "stalePostRafTaskCallbackCount",
  ];
  if (overall === null
    || typeof overall !== "object"
    || Array.isArray(overall)
    || !overallIntegerKeys.every((key) => (
      Number.isSafeInteger(overall[key]) && overall[key] >= 0
    ))
    || typeof overall.frameScheduled !== "boolean"
    || overall.countConservationPassed !== true) return false;

  let inputEventTotal = 0;
  let completedEventTotal = 0;
  let droppedEventTotal = 0;
  let pendingEventTotal = 0;
  let frozenEventTotal = 0;
  let typeFenceTotal = 0;
  let postRafInputTotal = 0;
  let inputWhileFrozenTotal = 0;
  let unattributedEventTotal = 0;
  let unattributedFenceTotal = 0;
  for (const type of DRAWING_INPUT_TYPES) {
    const eventCount = timing.inputEventCounts[type];
    const stats = timing.inputPaintFenceStats[type];
    const histogram = timing.inputToNextPaintByType[type];
    const integerStats = [
      "eventCount",
      "completedEventCount",
      "droppedEventCount",
      "pendingEventCount",
      "frozenEventCount",
      "fenceCount",
      "coalescedEventCount",
      "maxEventsPerFence",
      "postRafInputCount",
      "inputWhileFrozenCount",
      "unattributedEventCount",
      "unattributedFenceCount",
    ];
    if (!Number.isSafeInteger(eventCount)
      || eventCount <= 0
      || stats === null
      || typeof stats !== "object"
      || Array.isArray(stats)
      || !integerStats.every((key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0)
      || stats.countConservationPassed !== true
      || stats.eventCount !== eventCount
      || stats.completedEventCount !== eventCount
      || stats.droppedEventCount !== 0
      || stats.pendingEventCount !== 0
      || stats.frozenEventCount !== 0
      || stats.eventCount !== stats.fenceCount + stats.coalescedEventCount
      || stats.postRafInputCount !== 0
      || stats.unattributedEventCount > stats.eventCount
      || stats.unattributedFenceCount > stats.fenceCount
      || (requireBuckets
        && (stats.unattributedEventCount !== 0 || stats.unattributedFenceCount !== 0))
      || stats.maxEventsPerFence < 1
      || stats.maxEventsPerFence > stats.eventCount
      || (stats.coalescedEventCount === 0 && stats.maxEventsPerFence !== 1)
      || (stats.coalescedEventCount > 0 && stats.maxEventsPerFence < 2)
      || !browserTimingMetricEvidence(
        histogram,
        { observed: histogram?.totalCount },
        { requireBuckets },
      )
      || histogram.totalCount !== stats.fenceCount) return false;
    inputEventTotal += eventCount;
    completedEventTotal += stats.completedEventCount;
    droppedEventTotal += stats.droppedEventCount;
    pendingEventTotal += stats.pendingEventCount;
    frozenEventTotal += stats.frozenEventCount;
    typeFenceTotal += stats.fenceCount;
    postRafInputTotal += stats.postRafInputCount;
    inputWhileFrozenTotal += stats.inputWhileFrozenCount;
    unattributedEventTotal += stats.unattributedEventCount;
    unattributedFenceTotal += stats.unattributedFenceCount;
  }
  return inputEventTotal === timing.inputEvents
    && overall.eventCount === inputEventTotal
    && overall.completedEventCount === completedEventTotal
    && overall.droppedEventCount === droppedEventTotal
    && overall.pendingEventCount === pendingEventTotal
    && overall.frozenEventCount === frozenEventTotal
    && overall.eventCount === overall.completedEventCount
      + overall.droppedEventCount + overall.pendingEventCount + overall.frozenEventCount
    && overall.typeFenceCount === typeFenceTotal
    && overall.postRafInputCount === postRafInputTotal
    && overall.inputWhileFrozenCount === inputWhileFrozenTotal
    && overall.unattributedEventCount === unattributedEventTotal
    && overall.unattributedFenceCount === unattributedFenceTotal
    && overall.fenceCount > 0
    && overall.fenceCount <= overall.typeFenceCount
    && (!requireBuckets || (
      overall.droppedEventCount === 0
        && overall.pendingEventCount === 0
        && overall.frozenEventCount === 0
        && overall.postRafInputCount === 0
        && overall.unattributedEventCount === 0
        && overall.unattributedFenceCount === 0
        && overall.frameScheduled === false
        && overall.frozenFenceCount === 0
    ));
}

function browserTimingEvidence(timing, options = {}) {
  const longTaskCounts = timing?.longTaskCounts;
  const longTaskCountsValid = options.requireLongTaskCounts !== true || (
    Number.isSafeInteger(longTaskCounts?.total)
      && longTaskCounts.total >= 0
      && Number.isSafeInteger(longTaskCounts?.retained)
      && longTaskCounts.retained >= 0
      && Number.isSafeInteger(longTaskCounts?.dropped)
      && longTaskCounts.dropped === 0
      && Number.isSafeInteger(longTaskCounts?.excluded)
      && longTaskCounts.excluded >= 0
      && Number.isSafeInteger(longTaskCounts?.attributable)
      && longTaskCounts.attributable >= 0
      && longTaskCounts.total === longTaskCounts.retained + longTaskCounts.dropped
      && longTaskCounts.retained
        === longTaskCounts.excluded + longTaskCounts.attributable
      && Array.isArray(timing?.rawLongTasks)
      && timing.rawLongTasks.length === longTaskCounts.retained
      && timing.rawLongTasks.every((task) => (
        nonNegativeNumber(task?.startTime) !== null
          && nonNegativeNumber(task?.duration) !== null
          && task.duration > 50
      ))
      && Array.isArray(timing?.instrumentationWindows)
      && timing.instrumentationWindows.every((window) => (
        typeof window?.name === "string"
          && window.name.length > 0
          && nonNegativeNumber(window?.startTime) !== null
          && nonNegativeNumber(window?.endTime) !== null
          && window.endTime >= window.startTime
      ))
  );
  return timing !== null
    && typeof timing === "object"
    && !Array.isArray(timing)
    && nonNegativeNumber(timing.windowDurationMs) !== null
    && Number.isSafeInteger(timing.inputEvents)
    && timing.inputEvents > 0
    && timing.eventTimingSupported === true
    && timing.longTaskSupported === true
    && longTaskCountsValid
    && browserTypedInputEvidence(timing, options)
    && REQUIRED_BROWSER_TIMING_METRICS.every(
      (key) => browserTimingMetricEvidence(
        timing.metrics?.[key],
        timing.captureStats?.[BROWSER_TIMING_CAPTURE_KEYS[key]],
        options,
      ),
    );
}

function compareSlowInputPaintFences(left, right) {
  const latencyDelta = right.conservativeTotalMs - left.conservativeTotalMs;
  if (latencyDelta !== 0) return latencyDelta;
  if (left.fenceId !== right.fenceId) return left.fenceId - right.fenceId;
  if (left.eventType === right.eventType) return 0;
  return left.eventType < right.eventType ? -1 : 1;
}

function slowInputPostRafTaskFenceEvidence(timing, cycles) {
  const evidence = timing?.slowInputPostRafTaskFences;
  const entries = evidence?.entries;
  const cycleIds = new Set();
  let cyclesValid = Array.isArray(cycles) && cycles.length > 0;
  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    if (!Number.isSafeInteger(cycle?.cycle) || cycle.cycle <= 0 || cycleIds.has(cycle.cycle)) {
      cyclesValid = false;
      continue;
    }
    cycleIds.add(cycle.cycle);
  }
  const observedFenceCount = evidence?.observedFenceCount;
  const retainedFenceCount = evidence?.retainedFenceCount;
  const omittedFenceCount = evidence?.omittedFenceCount;
  const typeFenceCount = DRAWING_INPUT_TYPES.reduce(
    (total, type) => total + (timing?.inputPaintFenceStats?.[type]?.fenceCount ?? Number.NaN),
    0,
  );
  const countEvidenceValid = Number.isSafeInteger(observedFenceCount)
    && observedFenceCount > 0
    && Number.isSafeInteger(retainedFenceCount)
    && retainedFenceCount > 0
    && Number.isSafeInteger(omittedFenceCount)
    && omittedFenceCount >= 0
    && evidence?.countConservationPassed === true
    && retainedFenceCount <= DRAWING_INPUT_PAINT_FENCE_CAPACITY
    && retainedFenceCount === Math.min(observedFenceCount, DRAWING_INPUT_PAINT_FENCE_CAPACITY)
    && retainedFenceCount + omittedFenceCount === observedFenceCount
    && observedFenceCount === typeFenceCount
    && Array.isArray(entries)
    && entries.length === retainedFenceCount;
  const invalidEntryIndexes = [];
  const identities = new Set();
  if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      const timestamps = [
        entry?.eventTimeStampMs,
        entry?.handlerAtMs,
        entry?.rafAtMs,
        entry?.postRafTaskAtMs,
        entry?.eventToHandlerMs,
        entry?.handlerToRafMs,
        entry?.rafToPostRafTaskMs,
        entry?.handlerToPostRafTaskMs,
        entry?.eventToPostRafTaskMs,
        entry?.conservativeTotalMs,
      ];
      const identity = `${entry?.fenceId}:${entry?.eventType}`;
      const valid = Number.isSafeInteger(entry?.fenceId)
        && entry.fenceId > 0
        && Number.isSafeInteger(entry?.cycle)
        && entry.cycle > 0
        && cycleIds.has(entry.cycle)
        && DRAWING_INPUT_TYPES.includes(entry?.eventType)
        && Number.isSafeInteger(entry?.eventCount)
        && entry.eventCount > 0
        && timestamps.every((value) => nonNegativeNumber(value) !== null)
        && entry.eventTimeStampMs <= entry.handlerAtMs
        && (entry.lastRafAtMs === null
          || (nonNegativeNumber(entry.lastRafAtMs) !== null
            && entry.lastRafAtMs <= entry.handlerAtMs))
        && entry.handlerAtMs <= entry.rafAtMs
        && entry.rafAtMs <= entry.postRafTaskAtMs
        && entry.eventToHandlerMs === entry.handlerAtMs - entry.eventTimeStampMs
        && entry.handlerToRafMs === entry.rafAtMs - entry.handlerAtMs
        && entry.rafToPostRafTaskMs === entry.postRafTaskAtMs - entry.rafAtMs
        && entry.handlerToPostRafTaskMs
          === entry.postRafTaskAtMs - entry.handlerAtMs
        && entry.eventToPostRafTaskMs
          === entry.postRafTaskAtMs - entry.eventTimeStampMs
        && entry.conservativeTotalMs === entry.eventToPostRafTaskMs
        && !identities.has(identity);
      if (!valid) invalidEntryIndexes.push(index);
      identities.add(identity);
    });
  }
  const orderValid = Array.isArray(entries) && entries.every((entry, index) => (
    index === 0 || compareSlowInputPaintFences(entries[index - 1], entry) <= 0
  ));
  const passed = evidence !== null
    && typeof evidence === "object"
    && !Array.isArray(evidence)
    && evidence.schemaVersion === DRAWING_INPUT_POST_RAF_TASK_SCHEMA_VERSION
    && evidence.endpoint === "post-rAF-task"
    && evidence.timestampAggregation === "per-type-cohort-earliest-independent"
    && evidence.rankingMetric === "conservativeTotalMs"
    && evidence.capacity === DRAWING_INPUT_PAINT_FENCE_CAPACITY
    && nonNegativeNumber(evidence.performanceTimeOriginMs) !== null
    && cyclesValid
    && countEvidenceValid
    && invalidEntryIndexes.length === 0
    && orderValid;
  return Object.freeze({
    passed,
    actual: Object.freeze({
      schemaVersion: evidence?.schemaVersion ?? null,
      capacity: evidence?.capacity ?? null,
      observedFenceCount: Number.isSafeInteger(observedFenceCount) ? observedFenceCount : null,
      retainedFenceCount: Number.isSafeInteger(retainedFenceCount) ? retainedFenceCount : null,
      omittedFenceCount: Number.isSafeInteger(omittedFenceCount) ? omittedFenceCount : null,
      typeFenceCount: Number.isSafeInteger(typeFenceCount) ? typeFenceCount : null,
      invalidEntryIndexes,
      orderValid,
      cyclesValid,
    }),
  });
}

function sampleEvidence(sample) {
  return heapEvidence(sample?.heap).valid
    && sample?.workerVisible === true
    && domEvidence(sample?.dom)
    && performanceEvidence(sample?.performance)
    && browserTimingEvidence(sample?.browserTiming)
    && sample?.visibility?.visibilityState === "visible"
    && sample?.visibility?.hidden === false
    && sample?.runtime !== null
    && typeof sample?.runtime === "object"
    && !Array.isArray(sample.runtime);
}

function normalizedConfig(overrides = {}) {
  const config = { ...DRAWING_SOAK_DEFAULTS, ...overrides };
  const positive = [
    "durationMs",
    "requiredMeasuredDurationMs",
    "sampleIntervalMs",
    "gcIntervalMs",
    "workloadIntervalMs",
    "comparisonWindowMs",
    "maxSampleGapMs",
    "heapSlopeNoiseFloorBytesPerHour",
    "terminalPlateauNoiseFloorBytes",
    "minGcCheckpoints",
    "plateauWindowSize",
    "minDistinctViewportRevisions",
    "maxWorkerQueueDepth",
    "maxWorkerInFlight",
    "frameIntervalP95Ms",
    "frameIntervalP99Ms",
    "inputToNextPaintP95Ms",
    "inputToNextPaintP99Ms",
  ];
  for (const key of positive) {
    const value = finiteNumber(config[key]);
    if (value === null || value <= 0) {
      throw new TypeError(`drawing soak ${key} must be a finite positive number`);
    }
    config[key] = value;
  }
  config.warmupMs = nonNegativeNumber(config.warmupMs);
  if (config.warmupMs === null) {
    throw new TypeError("drawing soak warmupMs must be a finite non-negative number");
  }
  for (const key of [
    "minSampleCoverage",
    "maxHeapDeltaPct",
    "maxHeapSlopePctPerHour",
    "terminalPlateauPct",
  ]) {
    const value = nonNegativeNumber(config[key]);
    if (value === null) throw new TypeError(`drawing soak ${key} must be finite and non-negative`);
    config[key] = value;
  }
  if (config.minSampleCoverage > 1) {
    throw new RangeError("drawing soak minSampleCoverage must be <= 1");
  }
  if (config.durationMs < config.warmupMs + config.requiredMeasuredDurationMs) {
    throw new RangeError("drawing soak duration must cover warmup plus the required measured window");
  }
  return Object.freeze(config);
}

function sampleElapsedMs(sample) {
  return nonNegativeNumber(sample?.elapsedMs);
}

function aggregateHeapBytes(sample, aggregateKey = "aggregateUsedSize") {
  if (aggregateKey === "aggregateUsedSize") {
    return nonNegativeNumber(
      sample?.heap?.aggregateUsedSize
        ?? sample?.aggregateUsedSize
        ?? sample?.usedJSHeapSize,
    );
  }
  return nonNegativeNumber(sample?.heap?.[aggregateKey] ?? sample?.[aggregateKey]);
}

function stableWindowSummary(samples, config, aggregateKey = "aggregateUsedSize") {
  const valid = samples
    .map((sample) => ({
      elapsedMs: sampleElapsedMs(sample),
      bytes: aggregateHeapBytes(sample, aggregateKey),
    }))
    .filter((sample) => sample.elapsedMs !== null && sample.bytes !== null)
    .sort((left, right) => left.elapsedMs - right.elapsedMs);
  const first = valid[0] ?? null;
  const last = valid.at(-1) ?? null;
  const observedDurationMs = first && last ? Math.max(0, last.elapsedMs - first.elapsedMs) : 0;
  const windowMs = Math.min(config.comparisonWindowMs, observedDurationMs / 5);
  const firstWindow = first
    ? valid.filter((sample) => sample.elapsedMs <= first.elapsedMs + windowMs)
    : [];
  const finalWindow = last
    ? valid.filter((sample) => sample.elapsedMs >= last.elapsedMs - windowMs)
    : [];
  const baselineBytes = median(firstWindow.map((sample) => sample.bytes));
  const finalBytes = median(finalWindow.map((sample) => sample.bytes));
  return Object.freeze({
    sampleCount: valid.length,
    observedDurationMs,
    comparisonWindowMs: windowMs,
    baselineWindowSamples: firstWindow.length,
    finalWindowSamples: finalWindow.length,
    baselineBytes,
    finalBytes,
    maxBytes: valid.length > 0 ? Math.max(...valid.map((sample) => sample.bytes)) : null,
    deltaBytes: baselineBytes !== null && finalBytes !== null ? finalBytes - baselineBytes : null,
    deltaPct: baselineBytes !== null && baselineBytes > 0 && finalBytes !== null
      ? ((finalBytes - baselineBytes) / baselineBytes) * 100
      : null,
  });
}

export function theilSenSlopeBytesPerHour(samples = [], aggregateKey = "aggregateUsedSize") {
  const points = samples
    .map((sample) => ({
      elapsedMs: sampleElapsedMs(sample),
      bytes: aggregateHeapBytes(sample, aggregateKey),
    }))
    .filter((sample) => sample.elapsedMs !== null && sample.bytes !== null)
    .sort((left, right) => left.elapsedMs - right.elapsedMs);
  const slopes = [];
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const elapsedMs = points[rightIndex].elapsedMs - points[leftIndex].elapsedMs;
      if (elapsedMs <= 0) continue;
      slopes.push(((points[rightIndex].bytes - points[leftIndex].bytes) / elapsedMs) * 3_600_000);
    }
  }
  return median(slopes);
}

function gcSummary(checkpoints, config, aggregateKey = "aggregateUsedSize") {
  const valid = checkpoints
    .filter((checkpoint) => checkpoint?.ok === true)
    .map((checkpoint) => ({
      elapsedMs: sampleElapsedMs(checkpoint),
      heap: {
        [aggregateKey]: nonNegativeNumber(
          checkpoint?.after?.[aggregateKey]
            ?? checkpoint?.heap?.[aggregateKey]
            ?? checkpoint?.[aggregateKey],
        ),
      },
    }))
    .filter((checkpoint) => checkpoint.elapsedMs !== null
      && checkpoint.heap[aggregateKey] !== null)
    .sort((left, right) => left.elapsedMs - right.elapsedMs);
  const windowSize = Math.max(1, Math.floor(config.plateauWindowSize));
  const firstWindow = valid.slice(0, windowSize);
  const finalWindow = valid.slice(-windowSize);
  const precedingWindow = valid.slice(-windowSize * 2, -windowSize);
  const baselineBytes = median(firstWindow.map(
    (sample) => aggregateHeapBytes(sample, aggregateKey),
  ));
  const finalBytes = median(finalWindow.map(
    (sample) => aggregateHeapBytes(sample, aggregateKey),
  ));
  const precedingBytes = median(precedingWindow.map(
    (sample) => aggregateHeapBytes(sample, aggregateKey),
  ));
  const slopeBytesPerHour = theilSenSlopeBytesPerHour(valid, aggregateKey);
  const slopePctPerHour = baselineBytes !== null && baselineBytes > 0
    && slopeBytesPerHour !== null
    ? (slopeBytesPerHour / baselineBytes) * 100
    : null;
  const observedDurationMs = valid.length > 1
    ? valid.at(-1).elapsedMs - valid[0].elapsedMs
    : 0;
  const deltaBytes = baselineBytes !== null && finalBytes !== null
    ? finalBytes - baselineBytes
    : null;
  const deltaPct = baselineBytes !== null && baselineBytes > 0 && finalBytes !== null
    ? (deltaBytes / baselineBytes) * 100
    : null;
  const slopeLimitBytesPerHour = baselineBytes !== null
    ? Math.max(
      config.heapSlopeNoiseFloorBytesPerHour,
      baselineBytes * (config.maxHeapSlopePctPerHour / 100),
    )
    : null;
  const plateauAllowanceBytes = baselineBytes !== null
    ? Math.max(
      config.terminalPlateauNoiseFloorBytes,
      baselineBytes * (config.terminalPlateauPct / 100),
    )
    : null;
  return Object.freeze({
    checkpoints: valid.length,
    observedDurationMs,
    windowSize,
    baselineBytes,
    precedingBytes,
    finalBytes,
    deltaBytes,
    deltaPct,
    slopeBytesPerHour,
    slopePctPerHour,
    slopeLimitBytesPerHour,
    plateauAllowanceBytes,
    plateauDeltaBytes: precedingBytes !== null && finalBytes !== null
      ? finalBytes - precedingBytes
      : null,
  });
}

function check(actual, expected, passed, extra = {}) {
  return Object.freeze({ actual, expected, passed: passed === true, ...extra });
}

function maximum(values) {
  const finite = values.map(nonNegativeNumber).filter((value) => value !== null);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function runtimeStampCurrent(runtime) {
  const requested = runtime?.lastRequestedStamp ?? null;
  const published = runtime?.lastPublishedStamp ?? null;
  const painted = runtime?.lastPaintedStamp ?? null;
  return validStamp(requested)
    && validStamp(published)
    && validStamp(painted)
    && sameStamp(requested, published)
    && sameStamp(requested, painted);
}

export function normalizeDrawingSoakRuntimeEvidence(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return null;
  return Object.freeze({
    ...runtime,
    stalePublishDelta: finiteNumber(runtime.stalePublishDelta)
      ?? finiteNumber(runtime.stalePublishCount),
    lastPublishedStamp: runtime.lastPublishedStamp ?? null,
    lastPaintedStamp: runtime.lastPaintedStamp ?? runtime.lastPublishedStamp ?? null,
  });
}

export function isFormalDrawingSoakConfiguration(configuration = {}) {
  if (!drawingSoakConfigurationEvidence(configuration)) return false;
  let config;
  try {
    config = normalizedConfig(configuration);
  } catch {
    return false;
  }
  return config.durationMs >= DRAWING_SOAK_DEFAULTS.durationMs
    && config.warmupMs >= DRAWING_SOAK_DEFAULTS.warmupMs
    && config.requiredMeasuredDurationMs >= DRAWING_SOAK_DEFAULTS.requiredMeasuredDurationMs
    && config.sampleIntervalMs <= DRAWING_SOAK_DEFAULTS.sampleIntervalMs
    && config.gcIntervalMs <= DRAWING_SOAK_DEFAULTS.gcIntervalMs
    && config.workloadIntervalMs <= DRAWING_SOAK_DEFAULTS.workloadIntervalMs
    && config.comparisonWindowMs >= DRAWING_SOAK_DEFAULTS.comparisonWindowMs
    && config.minSampleCoverage >= DRAWING_SOAK_DEFAULTS.minSampleCoverage
    && config.maxSampleGapMs <= DRAWING_SOAK_DEFAULTS.maxSampleGapMs
    && config.maxHeapDeltaPct <= DRAWING_SOAK_DEFAULTS.maxHeapDeltaPct
    && config.maxHeapSlopePctPerHour <= DRAWING_SOAK_DEFAULTS.maxHeapSlopePctPerHour
    && config.heapSlopeNoiseFloorBytesPerHour
      <= DRAWING_SOAK_DEFAULTS.heapSlopeNoiseFloorBytesPerHour
    && config.terminalPlateauPct <= DRAWING_SOAK_DEFAULTS.terminalPlateauPct
    && config.terminalPlateauNoiseFloorBytes
      <= DRAWING_SOAK_DEFAULTS.terminalPlateauNoiseFloorBytes
    && config.minGcCheckpoints >= DRAWING_SOAK_DEFAULTS.minGcCheckpoints
    && config.plateauWindowSize >= DRAWING_SOAK_DEFAULTS.plateauWindowSize
    && config.minDistinctViewportRevisions
      >= DRAWING_SOAK_DEFAULTS.minDistinctViewportRevisions
    && config.maxWorkerQueueDepth <= DRAWING_SOAK_DEFAULTS.maxWorkerQueueDepth
    && config.maxWorkerInFlight <= DRAWING_SOAK_DEFAULTS.maxWorkerInFlight
    && config.frameIntervalP95Ms <= DRAWING_SOAK_DEFAULTS.frameIntervalP95Ms
    && config.frameIntervalP99Ms <= DRAWING_SOAK_DEFAULTS.frameIntervalP99Ms
    && config.inputToNextPaintP95Ms <= DRAWING_SOAK_DEFAULTS.inputToNextPaintP95Ms
    && config.inputToNextPaintP99Ms <= DRAWING_SOAK_DEFAULTS.inputToNextPaintP99Ms;
}

function diagnosticCount(diagnostics, key) {
  const value = diagnostics?.[key];
  if (Array.isArray(value)) return value.length;
  return nonNegativeNumber(value);
}

const EVENT_LATENCY_DIAGNOSTIC_KEYS = Object.freeze([
  "orphanEnds",
  "openBegins",
  "invalidEvents",
  "nonMonotonicEvents",
  "unknownTypes",
  "countMismatches",
]);

const EVENT_LATENCY_PROVENANCE_KEYS = Object.freeze([
  "gitCommit",
  "buildInputFingerprint",
  "productionBuildVerification",
  "browserProduct",
  "userAgent",
  "fixtureRawSha256",
  "scenarioId",
  "viewport",
  "dpr",
  "formalWindowEndedAt",
]);

const EVENT_LATENCY_TRACE_KEYS = Object.freeze([
  "byteLength",
  "chunkCount",
  "sha256",
  "eventCount",
  "dataLossOccurred",
  "maxBufferUsage",
]);

const EVENT_LATENCY_ACQUISITION_KEYS = Object.freeze([
  "passed",
  "attemptCount",
  "startedAt",
  "completedAt",
  "failureReason",
]);

const EVENT_LATENCY_ATTEMPT_KEYS = Object.freeze([
  "attempt",
  "passed",
  "startedAt",
  "completedAt",
  "failureReason",
]);

function exactIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function exactEventLatencyDispatchCounts(value) {
  return hasExactKeys(value, DRAWING_EVENT_LATENCY_INPUT_TYPES)
    && DRAWING_EVENT_LATENCY_INPUT_TYPES.every((type) => (
      value[type] === DRAWING_EVENT_LATENCY_CONFIGURATION.dispatchesPerType
    ));
}

function exactEventLatencyConfiguration(value) {
  const expected = DRAWING_EVENT_LATENCY_CONFIGURATION;
  const keys = Object.keys(expected);
  return hasExactKeys(value, keys)
    && value.dispatchesPerType === expected.dispatchesPerType
    && value.maxAttempts === expected.maxAttempts
    && value.p95ThresholdMs === expected.p95ThresholdMs
    && value.p99ThresholdMs === expected.p99ThresholdMs
    && value.p95MinimumSamples === expected.p95MinimumSamples
    && value.p99MinimumSamples === expected.p99MinimumSamples
    && value.maxTraceBytes === expected.maxTraceBytes
    && Array.isArray(value.categories)
    && value.categories.length === expected.categories.length
    && value.categories.every((category, index) => category === expected.categories[index]);
}

function nearestRankPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values
    .map(nonNegativeNumber)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (sorted.length !== values.length) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function exactNumericSamples(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => (
      nonNegativeNumber(value) !== null && value === right[index]
    ));
}

function eventLatencyMetricEvidence(metric, expectedCount, canonicalSamples) {
  const samplesMs = metric?.samplesMs;
  const count = metric?.count;
  const p50Ms = nonNegativeNumber(metric?.p50Ms);
  const p95Ms = nonNegativeNumber(metric?.p95Ms);
  const p99Ms = nonNegativeNumber(metric?.p99Ms);
  return Number.isSafeInteger(count)
    && count === expectedCount
    && Array.isArray(samplesMs)
    && samplesMs.length === count
    && exactNumericSamples(samplesMs, canonicalSamples)
    && p50Ms !== null
    && p95Ms !== null
    && p99Ms !== null
    && p50Ms <= p95Ms
    && p95Ms <= p99Ms
    && nearestRankPercentile(samplesMs, 50) === p50Ms
    && nearestRankPercentile(samplesMs, 95) === p95Ms
    && nearestRankPercentile(samplesMs, 99) === p99Ms;
}

function emptyEventLatencyMetricEvidence(metric) {
  return metric?.count === 0
    && Array.isArray(metric?.samplesMs)
    && metric.samplesMs.length === 0
    && metric.p50Ms === null
    && metric.p95Ms === null
    && metric.p99Ms === null;
}

function eventLatencyCalibrationEvidence(report) {
  const calibration = report?.eventLatencyCalibration;
  const configuration = calibration?.configuration;
  const provenance = calibration?.provenance;
  const trace = calibration?.trace;
  const parser = calibration?.parser;
  const acquisition = calibration?.acquisition;
  const attempts = calibration?.attempts;
  const expectedCount = DRAWING_EVENT_LATENCY_CONFIGURATION.dispatchesPerType;

  const configurationPassed = exactEventLatencyConfiguration(configuration);
  const expectedCountsPassed = exactEventLatencyDispatchCounts(
    calibration?.expectedDispatchCounts,
  );
  const actualCountsPassed = exactEventLatencyDispatchCounts(
    calibration?.actualDispatchCounts,
  );

  const reportViewport = report?.environment?.viewport;
  const provenanceViewport = provenance?.viewport;
  const formalWindowEndedAt = exactIsoTimestamp(provenance?.formalWindowEndedAt);
  const acquisitionStartedAt = exactIsoTimestamp(acquisition?.startedAt);
  const acquisitionCompletedAt = exactIsoTimestamp(acquisition?.completedAt);
  const provenancePassed = hasExactKeys(provenance, EVENT_LATENCY_PROVENANCE_KEYS)
    && provenance.gitCommit === report?.context?.git?.commit
    && /^[0-9a-f]{40}$/.test(provenance.gitCommit ?? "")
    && provenance.buildInputFingerprint === report?.context?.git?.buildInputFingerprint
    && /^[0-9a-f]{64}$/.test(provenance.buildInputFingerprint ?? "")
    && provenance.productionBuildVerification
      === report?.environment?.productionBuildVerification
    && provenance.browserProduct === report?.context?.browser?.version
    && provenance.browserProduct === report?.context?.browser?.name
    && typeof provenance.browserProduct === "string"
    && provenance.browserProduct.length > 0
    && provenance.userAgent === report?.context?.browser?.userAgent
    && typeof provenance.userAgent === "string"
    && provenance.userAgent.length > 0
    && provenance.fixtureRawSha256 === report?.fixture?.rawSha256
    && /^[0-9a-f]{64}$/.test(provenance.fixtureRawSha256 ?? "")
    && provenance.scenarioId === DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.scenarioId
    && hasExactKeys(provenanceViewport, ["width", "height"])
    && hasExactKeys(reportViewport, ["width", "height"])
    && Number.isSafeInteger(provenanceViewport.width)
    && provenanceViewport.width > 0
    && Number.isSafeInteger(provenanceViewport.height)
    && provenanceViewport.height > 0
    && provenanceViewport.width === reportViewport.width
    && provenanceViewport.height === reportViewport.height
    && provenance.dpr === report?.environment?.dpr
    && provenance.dpr === report?.configuration?.dpr
    && provenance.dpr === DRAWING_SOAK_FIXED_CONTRACT.dpr
    && formalWindowEndedAt !== null;

  const tracePassed = hasExactKeys(trace, EVENT_LATENCY_TRACE_KEYS)
    && Number.isSafeInteger(trace.byteLength)
    && trace.byteLength > 0
    && trace.byteLength <= DRAWING_EVENT_LATENCY_CONFIGURATION.maxTraceBytes
    && Number.isSafeInteger(trace.chunkCount)
    && trace.chunkCount > 0
    && /^[0-9a-f]{64}$/.test(trace.sha256 ?? "")
    && Number.isSafeInteger(trace.eventCount)
    && trace.eventCount > 0
    && trace.dataLossOccurred === false
    && nonNegativeNumber(trace.maxBufferUsage) !== null
    && trace.maxBufferUsage <= 1;

  const parserDiagnosticsPassed = hasExactKeys(
    parser?.diagnostics,
    EVENT_LATENCY_DIAGNOSTIC_KEYS,
  ) && EVENT_LATENCY_DIAGNOSTIC_KEYS.every((key) => (
    Array.isArray(parser.diagnostics[key]) && parser.diagnostics[key].length === 0
  ));
  const parserSamples = Array.isArray(parser?.samples) ? parser.samples : [];
  const canonicalSamplesByType = Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((type) => [
      type,
      parserSamples
        .filter((sample) => sample?.inputType === type)
        .map((sample) => sample?.generationToPresentationMs),
    ]),
  );
  const parserSamplesPassed = Array.isArray(parser?.samples)
    && parserSamples.length === expectedCount * DRAWING_EVENT_LATENCY_INPUT_TYPES.length
    && DRAWING_EVENT_LATENCY_INPUT_TYPES.every((type) => (
      canonicalSamplesByType[type].length === expectedCount
    ))
    && parserSamples.every((sample) => (
      DRAWING_EVENT_LATENCY_INPUT_TYPES.includes(sample?.inputType)
        && nonNegativeNumber(sample?.generationToPresentationMs) !== null
    ));
  const parserInputTypes = parser?.inputTypes;
  const inputTypeSummaries = Object.fromEntries(DRAWING_EVENT_LATENCY_INPUT_TYPES.map((type) => {
    const metric = parserInputTypes?.[type];
    const canonicalSamples = canonicalSamplesByType[type];
    const canonicalCount = canonicalSamples.length;
    const canonicalP95Ms = nearestRankPercentile(canonicalSamples, 95);
    const canonicalP99Ms = nearestRankPercentile(canonicalSamples, 99);
    const metricPassed = eventLatencyMetricEvidence(metric, expectedCount, canonicalSamples);
    const p95Eligible = canonicalCount
      >= DRAWING_EVENT_LATENCY_CONFIGURATION.p95MinimumSamples;
    const p99Eligible = canonicalCount
      >= DRAWING_EVENT_LATENCY_CONFIGURATION.p99MinimumSamples;
    const p95Passed = p95Eligible
      && canonicalP95Ms !== null
      && canonicalP95Ms <= DRAWING_EVENT_LATENCY_CONFIGURATION.p95ThresholdMs;
    const p99Passed = p99Eligible
      && canonicalP99Ms !== null
      && canonicalP99Ms <= DRAWING_EVENT_LATENCY_CONFIGURATION.p99ThresholdMs;
    return [type, Object.freeze({
      count: canonicalCount,
      p95Ms: canonicalP95Ms,
      p99Ms: canonicalP99Ms,
      p95Eligible,
      p99Eligible,
      p95Passed,
      p99Passed,
      passed: metricPassed && p95Passed && p99Passed,
    })];
  }));
  const inputTypesPassed = hasExactKeys(parserInputTypes, DRAWING_EVENT_LATENCY_INPUT_TYPES)
    && Object.values(inputTypeSummaries).every((summary) => summary.passed);
  const excludedHoverPassed = hasExactKeys(parser?.excluded, ["hover"])
    && emptyEventLatencyMetricEvidence(parser.excluded.hover);
  const eventLatency = parser?.eventLatency;
  const eventLatencyCountsPassed = [
    "beginCount",
    "endCount",
    "pairedCount",
    "presentedPairCount",
    "terminationOnlyPairCount",
    "partialPresentationPairCount",
  ].every((key) => Number.isSafeInteger(eventLatency?.[key]) && eventLatency[key] >= 0)
    && eventLatency.beginCount === eventLatency.endCount
    && eventLatency.beginCount === eventLatency.pairedCount
    && eventLatency.partialPresentationPairCount === 0
    && eventLatency.presentedPairCount === expectedCount
      * DRAWING_EVENT_LATENCY_INPUT_TYPES.length
    && eventLatency.presentedPairCount
      + eventLatency.terminationOnlyPairCount
      + eventLatency.partialPresentationPairCount === eventLatency.pairedCount
    && (!tracePassed || trace.eventCount >= eventLatency.beginCount + eventLatency.endCount);

  const eiaf = parser?.eventsInAnimationFrame;
  const eiafInputTypes = eiaf?.inputTypes;
  const eiafPassed = eiaf?.supported === true
    && eiaf?.passed === true
    && eiaf?.reason === null
    && Number.isSafeInteger(eiaf?.frameCount)
    && eiaf.frameCount >= expectedCount * 2
    && Number.isSafeInteger(eiaf?.excludedFrameCount)
    && eiaf.excludedFrameCount >= 0
    && hasExactKeys(eiafInputTypes, ["pointerdown", "pointerup"])
    && eventLatencyMetricEvidence(
      eiafInputTypes.pointerdown,
      expectedCount,
      canonicalSamplesByType.pointerdown,
    )
    && eventLatencyMetricEvidence(
      eiafInputTypes.pointerup,
      expectedCount,
      canonicalSamplesByType.pointerup,
    )
    && Array.isArray(eiaf.mismatches)
    && eiaf.mismatches.length === 0
    && Array.isArray(eiaf.schemaErrors)
    && eiaf.schemaErrors.length === 0;
  const parserPassed = parser?.schemaVersion === "drawing-event-latency-trace/v1"
    && parser?.passed === true
    && Array.isArray(parser?.failureReasons)
    && parser.failureReasons.length === 0
    && exactEventLatencyDispatchCounts(parser?.expectedDispatchCounts)
    && parserDiagnosticsPassed
    && inputTypesPassed
    && excludedHoverPassed
    && parserSamplesPassed
    && eventLatencyCountsPassed
    && eiafPassed;

  const acquisitionPassed = hasExactKeys(acquisition, EVENT_LATENCY_ACQUISITION_KEYS)
    && acquisition.passed === true
    && Number.isSafeInteger(acquisition.attemptCount)
    && acquisition.attemptCount >= 1
    && acquisition.attemptCount <= DRAWING_EVENT_LATENCY_CONFIGURATION.maxAttempts
    && acquisitionStartedAt !== null
    && acquisitionCompletedAt !== null
    && acquisitionCompletedAt >= acquisitionStartedAt
    && formalWindowEndedAt !== null
    && acquisitionStartedAt >= formalWindowEndedAt
    && acquisition.failureReason === null;
  const attemptsPassed = Array.isArray(attempts)
    && acquisitionPassed
    && attempts.length === acquisition.attemptCount
    && attempts.every((attempt, index) => {
      const startedAt = exactIsoTimestamp(attempt?.startedAt);
      const completedAt = exactIsoTimestamp(attempt?.completedAt);
      const previousCompletedAt = index > 0
        ? exactIsoTimestamp(attempts[index - 1]?.completedAt)
        : null;
      const isFinal = index === attempts.length - 1;
      return hasExactKeys(attempt, EVENT_LATENCY_ATTEMPT_KEYS)
        && attempt.attempt === index + 1
        && startedAt !== null
        && completedAt !== null
        && completedAt >= startedAt
        && (index === 0 || startedAt >= previousCompletedAt)
        && (isFinal
          ? attempt.passed === true && attempt.failureReason === null
          : attempt.passed === false
            && typeof attempt.failureReason === "string"
            && ["technical: ", "conservation: ", "schema: "]
              .some((prefix) => attempt.failureReason.startsWith(prefix)));
    })
    && attempts[0]?.startedAt === acquisition?.startedAt
    && attempts.at(-1)?.completedAt === acquisition?.completedAt;

  const actual = Object.freeze({
    schemaVersion: calibration?.schemaVersion ?? null,
    window: calibration?.window ?? null,
    configurationPassed,
    provenancePassed,
    expectedDispatchCounts: calibration?.expectedDispatchCounts ?? null,
    actualDispatchCounts: calibration?.actualDispatchCounts ?? null,
    trace: trace === null || typeof trace !== "object" ? null : Object.freeze({
      byteLength: trace.byteLength ?? null,
      chunkCount: trace.chunkCount ?? null,
      eventCount: trace.eventCount ?? null,
      dataLossOccurred: trace.dataLossOccurred ?? null,
      maxBufferUsage: trace.maxBufferUsage ?? null,
      sha256: trace.sha256 ?? null,
      passed: tracePassed,
    }),
    parser: Object.freeze({
      schemaVersion: parser?.schemaVersion ?? null,
      passed: parserPassed,
      diagnosticsPassed: parserDiagnosticsPassed,
      excludedHoverCount: Number.isSafeInteger(parser?.excluded?.hover?.count)
        ? parser.excluded.hover.count
        : null,
      inputTypes: Object.freeze(inputTypeSummaries),
      eventsInAnimationFrame: Object.freeze({
        supported: eiaf?.supported ?? null,
        passed: eiafPassed,
        pointerdownCount: Number.isSafeInteger(eiafInputTypes?.pointerdown?.count)
          ? eiafInputTypes.pointerdown.count
          : null,
        pointerupCount: Number.isSafeInteger(eiafInputTypes?.pointerup?.count)
          ? eiafInputTypes.pointerup.count
          : null,
      }),
    }),
    acquisition: acquisition ?? null,
    attemptsPassed,
  });
  return Object.freeze({
    passed: calibration?.schemaVersion
        === DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.schemaVersion
      && calibration?.window === DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.window
      && configurationPassed
      && provenancePassed
      && expectedCountsPassed
      && actualCountsPassed
      && tracePassed
      && parserPassed
      && acquisitionPassed
      && attemptsPassed,
    actual,
  });
}

/**
 * Build a fail-closed Phase 9 heavy-scene soak assessment. Missing evidence is
 * always a failed check; callers must never reinterpret an unevaluated metric
 * as success.
 */
export function assessDrawingSoak(report = {}, overrides = {}) {
  const effectiveConfiguration = { ...(report.configuration ?? {}), ...overrides };
  let configurationError = null;
  let config = normalizedConfig();
  try {
    config = normalizedConfig(effectiveConfiguration);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : String(error);
  }
  const configurationEvidencePassed = drawingSoakConfigurationEvidence(effectiveConfiguration)
    && configurationError === null;
  const formalEligible = configurationEvidencePassed
    && isFormalDrawingSoakConfiguration(effectiveConfiguration);
  const allSamples = Array.isArray(report.samples) ? report.samples : [];
  const allowedEndMs = config.durationMs + config.maxSampleGapMs;
  const measuredSampleCandidates = allSamples
    .filter((sample) => {
      const elapsedMs = sampleElapsedMs(sample);
      return elapsedMs !== null && elapsedMs >= config.warmupMs && elapsedMs <= allowedEndMs;
    });
  const invalidSampleIndexes = allSamples.reduce((indexes, sample, index) => {
    const elapsedMs = sampleElapsedMs(sample);
    if (elapsedMs === null
      || elapsedMs > allowedEndMs
      || (elapsedMs >= config.warmupMs && !sampleEvidence(sample))) {
      indexes.push(index);
    }
    return indexes;
  }, []);
  const duplicateSampleTimestamps = measuredSampleCandidates.length
    - new Set(measuredSampleCandidates.map(sampleElapsedMs)).size;
  const measuredSamples = Array.from(new Map(measuredSampleCandidates
    .filter(sampleEvidence)
    .map((sample) => [sampleElapsedMs(sample), sample])).values())
    .sort((left, right) => sampleElapsedMs(left) - sampleElapsedMs(right));
  const firstElapsedMs = sampleElapsedMs(measuredSamples[0]);
  const finalElapsedMs = sampleElapsedMs(measuredSamples.at(-1));
  const observedDurationMs = firstElapsedMs !== null && finalElapsedMs !== null
    ? Math.max(0, finalElapsedMs - firstElapsedMs)
    : 0;
  const expectedSamples = Math.floor(config.requiredMeasuredDurationMs / config.sampleIntervalMs) + 1;
  const sampleCoverage = expectedSamples > 0 ? measuredSamples.length / expectedSamples : 0;
  let maxSampleGapMs = null;
  for (let index = 1; index < measuredSamples.length; index += 1) {
    const gap = sampleElapsedMs(measuredSamples[index]) - sampleElapsedMs(measuredSamples[index - 1]);
    maxSampleGapMs = maxSampleGapMs === null ? gap : Math.max(maxSampleGapMs, gap);
  }

  const naturalHeap = stableWindowSummary(measuredSamples, config);
  const naturalBackingStorage = stableWindowSummary(
    measuredSamples,
    config,
    "aggregateBackingStorageSize",
  );
  const naturalEmbedderHeap = stableWindowSummary(
    measuredSamples,
    config,
    "aggregateEmbedderHeapUsedSize",
  );
  const rawGcCheckpoints = Array.isArray(report.gcCheckpoints) ? report.gcCheckpoints : [];
  const invalidGcCheckpointIndexes = rawGcCheckpoints.reduce((indexes, checkpoint, index) => {
    const elapsedMs = sampleElapsedMs(checkpoint);
    if (elapsedMs === null
      || elapsedMs > allowedEndMs
      || checkpoint?.ok !== true
      || !Number.isSafeInteger(checkpoint?.scheduledAtMs)
      || checkpoint.scheduledAtMs < 0
      || !heapEvidence(checkpoint?.after).valid) {
      indexes.push(index);
    }
    return indexes;
  }, []);
  const measuredGcCandidates = rawGcCheckpoints.filter((checkpoint) => {
    const elapsedMs = sampleElapsedMs(checkpoint);
    return elapsedMs !== null
      && elapsedMs >= config.warmupMs
      && elapsedMs <= allowedEndMs
      && checkpoint?.ok === true
      && heapEvidence(checkpoint?.after).valid;
  });
  const duplicateGcTimestamps = measuredGcCandidates.length
    - new Set(measuredGcCandidates.map(sampleElapsedMs)).size;
  const measuredGcCheckpoints = Array.from(new Map(measuredGcCandidates
    .map((checkpoint) => [sampleElapsedMs(checkpoint), checkpoint])).values())
    .sort((left, right) => sampleElapsedMs(left) - sampleElapsedMs(right));
  const gc = gcSummary(measuredGcCheckpoints, config);
  const gcBackingStorage = gcSummary(
    measuredGcCheckpoints,
    config,
    "aggregateBackingStorageSize",
  );
  const gcEmbedderHeap = gcSummary(
    measuredGcCheckpoints,
    config,
    "aggregateEmbedderHeapUsedSize",
  );
  let maxGcGapMs = null;
  for (let index = 1; index < measuredGcCheckpoints.length; index += 1) {
    const gap = sampleElapsedMs(measuredGcCheckpoints[index])
      - sampleElapsedMs(measuredGcCheckpoints[index - 1]);
    maxGcGapMs = maxGcGapMs === null ? gap : Math.max(maxGcGapMs, gap);
  }
  const workerEvidence = measuredSamples.map((sample) => (
    sample?.workerVisible === true && heapEvidence(sample?.heap).valid
  ));
  const workerIdentities = measuredSamples.map((sample) => {
    const worker = sample?.heap?.workers?.[0];
    return typeof worker?.targetId === "string" && worker.targetId.length > 0
      && typeof worker?.sessionId === "string" && worker.sessionId.length > 0
      ? `${worker.targetId}:${worker.sessionId}`
      : null;
  });
  const initialWorkerTargets = report.readiness?.workerTargetsInitial;
  const finalWorkerTargets = report.readiness?.workerTargetsFinal;
  const initialWorker = Array.isArray(initialWorkerTargets) && initialWorkerTargets.length === 1
    ? initialWorkerTargets[0]
    : null;
  const finalWorker = Array.isArray(finalWorkerTargets) && finalWorkerTargets.length === 1
    ? finalWorkerTargets[0]
    : null;
  const workerLifecyclePassed = initialWorker !== null
    && finalWorker !== null
    && typeof initialWorker.targetId === "string"
    && initialWorker.targetId.length > 0
    && typeof initialWorker.sessionId === "string"
    && initialWorker.sessionId.length > 0
    && initialWorker.targetId === finalWorker.targetId
    && initialWorker.sessionId === finalWorker.sessionId
    && workerIdentities.length > 0
    && workerIdentities.every(
      (identity) => identity === `${initialWorker.targetId}:${initialWorker.sessionId}`,
    );
  const runtimes = measuredSamples.map((sample) => sample?.runtime ?? null);
  const browserTimings = measuredSamples.map((sample) => sample?.browserTiming ?? null);
  const finalBrowserTiming = report.browserTiming ?? null;
  const inputFrameLatency = Object.freeze({
    frameIntervalP95Ms: nonNegativeNumber(
      finalBrowserTiming?.metrics?.frameIntervalMs?.p95Ms,
    ),
    frameIntervalP99Ms: nonNegativeNumber(
      finalBrowserTiming?.metrics?.frameIntervalMs?.p99Ms,
    ),
    inputToNextPaintP95Ms: nonNegativeNumber(
      finalBrowserTiming?.metrics?.inputToNextPaintMs?.p95Ms,
    ),
    inputToNextPaintP99Ms: nonNegativeNumber(
      finalBrowserTiming?.metrics?.inputToNextPaintMs?.p99Ms,
    ),
  });
  const inputFrameLatencyByType = Object.freeze(Object.fromEntries(
    DRAWING_INPUT_TYPES.map((type) => {
      const metric = finalBrowserTiming?.inputToNextPaintByType?.[type];
      const sampleCount = Number.isSafeInteger(metric?.totalCount) && metric.totalCount >= 0
        ? metric.totalCount
        : null;
      const p95Ms = nonNegativeNumber(metric?.p95Ms);
      const p99Ms = nonNegativeNumber(metric?.p99Ms);
      const p95Eligible = sampleCount !== null
        && sampleCount >= DRAWING_INPUT_P95_MINIMUM_SAMPLES;
      const p99Eligible = sampleCount !== null
        && sampleCount >= DRAWING_INPUT_P99_MINIMUM_SAMPLES;
      const p95Passed = p95Eligible && p95Ms !== null
        && p95Ms <= config.inputToNextPaintP95Ms;
      const p99Passed = p99Eligible && p99Ms !== null
        && p99Ms <= config.inputToNextPaintP99Ms;
      return [type, Object.freeze({
        sampleCount,
        eligibility: Object.freeze({ p95: p95Eligible, p99: p99Eligible }),
        p95Ms,
        p99Ms,
        p95Passed,
        p99Passed,
        passed: p95Passed && p99Passed,
      })];
    }),
  ));
  const browserTimingProgressPassed = browserTimings.length > 1
    && browserTimings.every((timing, index) => {
      if (!browserTimingEvidence(timing)) return false;
      if (index === 0) return true;
      const previous = browserTimings[index - 1];
      return timing.windowDurationMs > previous.windowDurationMs
        && timing.inputEvents >= previous.inputEvents
        && DRAWING_INPUT_TYPES.every((type) => (
          timing.inputEventCounts[type] >= previous.inputEventCounts[type]
            && timing.inputPaintFenceStats[type].fenceCount
              >= previous.inputPaintFenceStats[type].fenceCount
            && timing.inputToNextPaintByType[type].totalCount
              >= previous.inputToNextPaintByType[type].totalCount
        ))
        && REQUIRED_BROWSER_TIMING_METRICS.every((key) => (
          timing.metrics[key].totalCount >= previous.metrics[key].totalCount
        ));
    });
  const inputFrameLatencyPassed = browserTimingEvidence(
    finalBrowserTiming,
    { requireBuckets: true },
  )
    && inputFrameLatency.frameIntervalP95Ms <= config.frameIntervalP95Ms
    && inputFrameLatency.frameIntervalP99Ms <= config.frameIntervalP99Ms
    && inputFrameLatency.inputToNextPaintP95Ms <= config.inputToNextPaintP95Ms
    && inputFrameLatency.inputToNextPaintP99Ms <= config.inputToNextPaintP99Ms;
  const inputFrameLatencyByTypePassed = browserTimingEvidence(
    finalBrowserTiming,
    { requireBuckets: true },
  ) && DRAWING_INPUT_TYPES.every((type) => inputFrameLatencyByType[type].passed);
  const cacheBudgets = runtimes.map((runtime) => nonNegativeNumber(runtime?.cacheBudgetBytes));
  const cacheHardLimits = runtimes.map((runtime) => nonNegativeNumber(runtime?.cacheHardLimitBytes));
  const cacheCurrent = runtimes.map((runtime) => nonNegativeNumber(runtime?.cacheBytes));
  const cacheMaxima = runtimes.map((runtime) => nonNegativeNumber(runtime?.cacheBytesMax));
  const cacheEntryCounts = runtimes.map((runtime) => nonNegativeNumber(runtime?.cacheEntryCount));
  const cacheBudgetEvictions = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheBudgetEvictionCount,
  ));
  const cacheEntryBytes = runtimes.map((runtime) => nonNegativeNumber(runtime?.cacheEntryBytes));
  const cacheEntryBudgets = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheEntryBudgetBytes,
  ));
  const cacheMetadataBytes = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheMetadataBytes,
  ));
  const cacheMetadataBudgets = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheMetadataBudgetBytes,
  ));
  const cacheRecentHierarchyKeys = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheRecentHierarchyKeyCount,
  ));
  const cacheRecentHierarchyKeysPerRequestLimits = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheRecentHierarchyKeysPerRequestLimit,
  ));
  const cacheRecentRequestCounts = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheRecentRequestCount,
  ));
  const cacheRecentRequestLimits = runtimes.map((runtime) => nonNegativeNumber(
    runtime?.cacheRecentRequestLimit,
  ));
  const cacheComplete = measuredSamples.length > 0
    && [
      ...cacheBudgets,
      ...cacheHardLimits,
      ...cacheCurrent,
      ...cacheMaxima,
      ...cacheEntryCounts,
      ...cacheBudgetEvictions,
      ...cacheEntryBytes,
      ...cacheEntryBudgets,
      ...cacheMetadataBytes,
      ...cacheMetadataBudgets,
      ...cacheRecentHierarchyKeys,
      ...cacheRecentHierarchyKeysPerRequestLimits,
      ...cacheRecentRequestCounts,
      ...cacheRecentRequestLimits,
    ]
      .every((value) => value !== null);
  const cacheWithinBudget = cacheComplete && runtimes.every((runtime, index) => (
    cacheCurrent[index] <= cacheBudgets[index]
      && cacheMaxima[index] <= cacheBudgets[index]
      && cacheBudgets[index] <= cacheHardLimits[index]
      && cacheEntryBytes[index] <= cacheEntryBudgets[index]
      && cacheMetadataBytes[index] <= cacheMetadataBudgets[index]
      && cacheEntryBytes[index] + cacheMetadataBytes[index] === cacheCurrent[index]
      && cacheEntryBudgets[index] + cacheMetadataBudgets[index] === cacheBudgets[index]
      && cacheRecentHierarchyKeysPerRequestLimits[index] > 0
      && cacheRecentRequestLimits[index] > 0
      && cacheRecentRequestCounts[index] <= cacheRecentRequestLimits[index]
      && cacheRecentHierarchyKeys[index] <= cacheRecentRequestCounts[index]
        * cacheRecentHierarchyKeysPerRequestLimits[index]
  ));
  const runtimeInvariantFailures = runtimes.reduce((failures, runtime, index) => {
    const valid = runtime?.engineMode === "scene-canary"
      && runtime?.scenePublicationReady === true
      && runtime?.attachedPrimitiveCount === 1
      && runtime?.backend === "worker"
      && runtime?.canonicalRawPreserved === true
      && runtime?.vertexBudgetPassed === true
      && nonNegativeNumber(runtime?.queueDepthMax) !== null
      && runtime.queueDepthMax <= config.maxWorkerQueueDepth
      && nonNegativeNumber(runtime?.inFlightMax) !== null
      && runtime.inFlightMax <= config.maxWorkerInFlight
      && nonNegativeNumber(runtime?.queueDepthCurrent) === 0
      && nonNegativeNumber(runtime?.inFlightCurrent) === 0
      && nonNegativeNumber(runtime?.stalePublishDelta) === 0
      && nonNegativeNumber(runtime?.sceneFallbackCount) === 0
      && nonNegativeNumber(runtime?.sceneRuntimeFaultCount) === 0
      && nonNegativeNumber(runtime?.legacyFallbackSucceededCount) === 0
      && nonNegativeNumber(runtime?.sceneFallbackDelta) === 0
      && runtime?.sceneFallbackLastReason === null
      && nonNegativeNumber(runtime?.workerJobDelta) !== null
      && runtime.workerJobDelta > 0
      && nonNegativeNumber(runtime?.workerResultDelta) !== null
      && runtime.workerResultDelta > 0
      && runtime.workerResultDelta <= runtime.workerJobDelta
      && runtimeStampCurrent(runtime);
    if (!valid) failures.push(index);
    return failures;
  }, []);

  const cycles = Array.isArray(report.cycles) ? report.cycles : [];
  const cycleValid = (cycle) => {
    const elapsedMs = sampleElapsedMs(cycle);
    const runtime = cycle?.runtime;
    const previousStamp = cycle?.previousStamp;
    const requestedStamp = runtime?.lastRequestedStamp;
    return elapsedMs !== null
      && elapsedMs <= allowedEndMs
      && cycle?.passed === true
      && cycle?.currentPaintPassed === true
      && cycle?.queueConverged === true
      && validStamp(previousStamp)
      && runtimeStampCurrent(runtime)
      && !sameStamp(previousStamp, requestedStamp)
      && Number.isSafeInteger(cycle?.viewportRevision)
      && cycle.viewportRevision === requestedStamp.viewportRevision
      && nonNegativeNumber(runtime?.queueDepthCurrent) === 0
      && nonNegativeNumber(runtime?.inFlightCurrent) === 0
      && nonNegativeNumber(runtime?.stalePublishDelta) === 0
      && nonNegativeNumber(runtime?.sceneFallbackCount) === 0
      && nonNegativeNumber(runtime?.sceneRuntimeFaultCount) === 0
      && nonNegativeNumber(runtime?.legacyFallbackSucceededCount) === 0
      && nonNegativeNumber(runtime?.sceneFallbackDelta) === 0
      && runtime?.sceneFallbackLastReason === null
      && nonNegativeNumber(runtime?.workerJobDelta) !== null
      && runtime.workerJobDelta > 0
      && nonNegativeNumber(runtime?.workerResultDelta) !== null
      && runtime.workerResultDelta > 0
      && runtime.workerResultDelta <= runtime.workerJobDelta
      && Number.isSafeInteger(cycle?.workerJobCycleDelta)
      && cycle.workerJobCycleDelta > 0
      && Number.isSafeInteger(cycle?.workerResultCycleDelta)
      && cycle.workerResultCycleDelta > 0
      && cycle.workerResultCycleDelta <= cycle.workerJobCycleDelta
      && cycle?.stalePublishCycleDelta === 0;
  };
  const invalidCycleIndexes = cycles.reduce((indexes, cycle, index) => {
    if (!cycleValid(cycle)) indexes.push(index);
    return indexes;
  }, []);
  const measuredCycles = cycles
    .filter((cycle) => sampleElapsedMs(cycle) >= config.warmupMs && cycleValid(cycle))
    .sort((left, right) => sampleElapsedMs(left) - sampleElapsedMs(right));
  let maxCycleGapMs = null;
  for (let index = 1; index < measuredCycles.length; index += 1) {
    const gap = sampleElapsedMs(measuredCycles[index]) - sampleElapsedMs(measuredCycles[index - 1]);
    maxCycleGapMs = maxCycleGapMs === null ? gap : Math.max(maxCycleGapMs, gap);
  }
  const firstCycleElapsedMs = sampleElapsedMs(measuredCycles[0]);
  const finalCycleElapsedMs = sampleElapsedMs(measuredCycles.at(-1));
  const expectedCycles = Math.max(
    1,
    Math.floor(config.requiredMeasuredDurationMs / config.workloadIntervalMs),
  );
  const minimumCycles = Math.max(1, Math.floor(expectedCycles * config.minSampleCoverage));
  const distinctViewportRevisions = new Set(measuredCycles
    .map((cycle) => cycle?.viewportRevision)
    .filter((value) => Number.isSafeInteger(value))).size;
  const viewportRevisionsMonotonic = measuredCycles.every((cycle, index) => (
    index === 0 || cycle.viewportRevision > measuredCycles[index - 1].viewportRevision
  ));
  const cycleWindowCovered = firstCycleElapsedMs !== null
    && finalCycleElapsedMs !== null
    && firstCycleElapsedMs <= config.warmupMs
      + config.workloadIntervalMs
      + config.maxSampleGapMs
    && finalCycleElapsedMs >= config.warmupMs
      + config.requiredMeasuredDurationMs
      - config.workloadIntervalMs
      - config.maxSampleGapMs;
  const inputPaintFenceEvidence = slowInputPostRafTaskFenceEvidence(
    finalBrowserTiming,
    cycles,
  );
  const derivedMinimumGcCheckpoints = Math.floor(
    config.requiredMeasuredDurationMs / config.gcIntervalMs,
  ) + 1;
  const requiredGcCheckpoints = Math.max(
    Math.ceil(config.minGcCheckpoints),
    derivedMinimumGcCheckpoints,
  );
  const diagnosticKeys = [
    "sampleErrors",
    "consoleErrors",
    "runtimeExceptions",
    "networkFailures",
    "longTasks",
  ];
  const diagnosticCounts = Object.fromEntries(
    diagnosticKeys.map((key) => [key, diagnosticCount(report.diagnostics, key)]),
  );
  const diagnosticsComplete = Object.values(diagnosticCounts).every((value) => value !== null);
  const diagnosticsClean = diagnosticsComplete
    && Object.values(diagnosticCounts).every((value) => value === 0);
  const longTaskCounts = report.browserTiming?.longTaskCounts;
  const rawLongTasks = Array.isArray(report.browserTiming?.rawLongTasks)
    ? report.browserTiming.rawLongTasks
    : [];
  const instrumentationWindows = Array.isArray(report.browserTiming?.instrumentationWindows)
    ? report.browserTiming.instrumentationWindows
    : [];
  const expectedInstrumentationNames = rawGcCheckpoints.map(
    (checkpoint) => `phase9-forced-gc:${checkpoint?.scheduledAtMs}`,
  );
  const taskContainedByInstrumentation = (task) => instrumentationWindows.some((window) => (
    task.startTime >= window.startTime
      && task.startTime + task.duration <= window.endTime
  ));
  const recomputedExcludedLongTasks = rawLongTasks.filter(taskContainedByInstrumentation);
  const recomputedAttributableLongTasks = rawLongTasks.filter(
    (task) => !taskContainedByInstrumentation(task),
  );
  const diagnosticLongTasks = Array.isArray(report.diagnostics?.longTasks)
    ? report.diagnostics.longTasks
    : null;
  const instrumentationWindowsPassed = instrumentationWindows.length
    === expectedInstrumentationNames.length
    && instrumentationWindows.map((window) => window?.name)
      .every((name, index) => name === expectedInstrumentationNames[index])
    && instrumentationWindows.every((window) => (
      nonNegativeNumber(window?.startTime) !== null
        && nonNegativeNumber(window?.endTime) !== null
        && window.endTime >= window.startTime
        && window.endTime - window.startTime
          <= DRAWING_SOAK_FIXED_CONTRACT.maxInstrumentationWindowMs
    ));
  const longTaskAttributionPassed = Number.isSafeInteger(longTaskCounts?.total)
    && longTaskCounts.total >= 0
    && Number.isSafeInteger(longTaskCounts?.retained)
    && longTaskCounts.retained === rawLongTasks.length
    && Number.isSafeInteger(longTaskCounts?.dropped)
    && longTaskCounts.dropped === 0
    && longTaskCounts.total === longTaskCounts.retained
    && Number.isSafeInteger(longTaskCounts?.excluded)
    && longTaskCounts.excluded === recomputedExcludedLongTasks.length
    && Number.isSafeInteger(longTaskCounts?.attributable)
    && longTaskCounts.attributable === recomputedAttributableLongTasks.length
    && recomputedAttributableLongTasks.length === 0
    && diagnosticLongTasks !== null
    && diagnosticLongTasks.length === recomputedAttributableLongTasks.length
    && instrumentationWindowsPassed;
  const fixedConfiguration = report.configuration ?? {};
  const fixture = report.fixture ?? {};
  const fixedSceneContractPassed = fixedConfiguration.drawingEngineMode === "scene-canary"
    && fixedConfiguration.drawingInteractionSurfaceMode === "overlay"
    && fixedConfiguration.drawingRasterBackend === "worker"
    && fixedConfiguration.drawingCoordinateProjectorMode === "batch"
    && fixedConfiguration.drawingDocumentAuthority === "document"
    && fixedConfiguration.bars === DRAWING_SOAK_FIXED_CONTRACT.bars
    && fixedConfiguration.dpr === DRAWING_SOAK_FIXED_CONTRACT.dpr
    && fixedConfiguration.seed === DRAWING_SOAK_FIXED_CONTRACT.seed
    && fixedConfiguration.intervalSeconds === DRAWING_SOAK_FIXED_CONTRACT.intervalSeconds
    && fixedConfiguration.mockEndTime === DRAWING_SOAK_FIXED_CONTRACT.mockEndTime
    && fixture.name === DRAWING_SOAK_FIXED_CONTRACT.fixtureName
    && fixture.entities === DRAWING_SOAK_FIXED_CONTRACT.fixtureEntities
    && fixture.points === DRAWING_SOAK_FIXED_CONTRACT.fixturePoints
    && fixture.seed === DRAWING_SOAK_FIXED_CONTRACT.seed
    && fixture.rawSha256 === DRAWING_SOAK_FIXED_CONTRACT.fixtureRawSha256;
  const refreshRateHz = nonNegativeNumber(report.environment?.refreshRateHz);
  const histogramFrameMedianMs = histogramPercentile(
    report.browserTiming?.metrics?.frameIntervalMs,
    50,
  );
  const histogramRefreshRateHz = histogramFrameMedianMs !== null
    && histogramFrameMedianMs > 0
    ? 1_000 / histogramFrameMedianMs
    : null;
  const refreshRateProfilePassed = refreshRateHz !== null
    && refreshRateHz >= DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMin
    && refreshRateHz <= DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMax
    && nonNegativeNumber(report.browserTiming?.refreshRateHz) === refreshRateHz
    && histogramRefreshRateHz === refreshRateHz;
  const productionHarnessPassed = report.environment?.productionBuild === true
    && report.environment?.productionBuildVerification === "managed-vite-preview"
    && report.environment?.buildEnvironment?.NODE_ENV === "production"
    && /^[0-9a-f]{40}$/.test(report.context?.git?.commit ?? "")
    && /^[0-9a-f]{64}$/.test(report.context?.git?.buildInputFingerprint ?? "")
    && report.context?.git?.buildInputsDirty === false
    && typeof report.context?.browser?.name === "string"
    && report.context.browser.name.length > 0
    && typeof report.context?.machine?.platform === "string"
    && report.context.machine.platform.length > 0
    && refreshRateProfilePassed
    && fixedConfiguration.headless === false
    && report.readiness?.browserWindowInitial?.headed === true
    && report.readiness?.browserWindowInitial?.windowState === "normal"
    && report.readiness?.browserWindowInitial?.visibilityState === "visible"
    && report.readiness?.browserWindowInitial?.hidden === false
    && report.readiness?.browserWindowInitial?.devicePixelRatio === 1.5
    && nonNegativeNumber(report.readiness?.refreshRatePreflight?.refreshRateHz) !== null
    && report.readiness.refreshRatePreflight.refreshRateHz
      >= DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMin
    && report.readiness.refreshRatePreflight.refreshRateHz
      <= DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMax
    && report.readiness?.browserWindowFinal?.headed === true
    && report.readiness?.browserWindowFinal?.windowState === "normal"
    && report.readiness?.browserWindowFinal?.visibilityState === "visible"
    && report.readiness?.browserWindowFinal?.hidden === false
    && report.readiness?.browserWindowFinal?.devicePixelRatio === 1.5
    && report.readiness?.drawingEngineDomEvidenceInitial?.passed === true
    && report.readiness?.drawingEngineDomEvidenceFinal?.passed === true
    && report.readiness?.probeStopped?.started === true
    && report.readiness?.probeStopped?.stopped === true
    && browserTimingEvidence(report.browserTiming, {
      requireBuckets: true,
      requireLongTaskCounts: true,
    })
    && report.browserTiming.windowDurationMs >= config.requiredMeasuredDurationMs;

  const retainedCurveAcceptance = (summary) => Object.freeze({
    deltaAllowanceBytes: summary.baselineBytes !== null
      ? Math.max(
        config.terminalPlateauNoiseFloorBytes,
        summary.baselineBytes * (config.maxHeapDeltaPct / 100),
      )
      : null,
    deltaPassed: summary.deltaBytes !== null
      && summary.baselineBytes !== null
      && summary.deltaBytes <= Math.max(
        config.terminalPlateauNoiseFloorBytes,
        summary.baselineBytes * (config.maxHeapDeltaPct / 100),
      ),
    slopePassed: summary.slopeBytesPerHour !== null
      && summary.slopeLimitBytesPerHour !== null
      && summary.slopeBytesPerHour <= summary.slopeLimitBytesPerHour,
    plateauPassed: summary.plateauDeltaBytes !== null
      && summary.plateauAllowanceBytes !== null
      && summary.plateauDeltaBytes <= summary.plateauAllowanceBytes,
  });
  const usedCurveAcceptance = retainedCurveAcceptance(gc);
  const backingCurveAcceptance = retainedCurveAcceptance(gcBackingStorage);
  const embedderCurveAcceptance = retainedCurveAcceptance(gcEmbedderHeap);
  const naturalCurveAcceptance = (summary) => retainedCurveAcceptance({
    ...summary,
    slopeBytesPerHour: null,
    slopeLimitBytesPerHour: null,
    plateauDeltaBytes: null,
    plateauAllowanceBytes: null,
  });
  const naturalUsedAcceptance = naturalCurveAcceptance(naturalHeap);
  const naturalBackingAcceptance = naturalCurveAcceptance(naturalBackingStorage);
  const naturalEmbedderAcceptance = naturalCurveAcceptance(naturalEmbedderHeap);
  const eventLatencyCalibration = eventLatencyCalibrationEvidence(report);
  const checks = Object.freeze({
    configurationEvidence: check(
      configurationEvidencePassed,
      "every soak duration/cadence/threshold field is explicitly present as a native finite number",
      configurationEvidencePassed,
      { configurationError },
    ),
    formalEligibility: check(
      formalEligible,
      "66m total / 5m warmup / 60m measured with no looser formal cadence or thresholds",
      formalEligible,
    ),
    fixedSceneContract: check(
      fixedSceneContractPassed,
      "scene-canary + overlay + worker + batch/document + 10000 bars + DPR 1.5 + 64x512 fixture",
      fixedSceneContractPassed,
    ),
    productionHarness: check(
      productionHarnessPassed,
      "managed production preview with git/build/browser/machine provenance",
      productionHarnessPassed,
    ),
    eventLatencyCalibration: check(
      eventLatencyCalibration.actual,
      "post-formal-soak Chromium presentation trace: 128 exact samples/type, p95 <= 20ms, p99 <= 33ms, lossless provenance-matched acquisition",
      eventLatencyCalibration.passed,
    ),
    refreshRateProfile: check(
      refreshRateHz,
      `${DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMin}-${DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMax}Hz fixed SLO profile`,
      refreshRateProfilePassed,
    ),
    sampleEvidence: check(
      invalidSampleIndexes.length + duplicateSampleTimestamps,
      0,
      allSamples.length > 0
        && invalidSampleIndexes.length === 0
        && duplicateSampleTimestamps === 0,
      { invalidSampleIndexes, duplicateSampleTimestamps },
    ),
    measuredDuration: check(
      observedDurationMs,
      `>= ${config.requiredMeasuredDurationMs}`,
      observedDurationMs >= config.requiredMeasuredDurationMs,
    ),
    sampleCoverage: check(
      sampleCoverage,
      `>= ${config.minSampleCoverage}`,
      measuredSamples.length >= expectedSamples * config.minSampleCoverage,
      { expectedSamples, observedSamples: measuredSamples.length },
    ),
    sampleGap: check(
      maxSampleGapMs,
      `<= ${config.maxSampleGapMs}`,
      maxSampleGapMs !== null && maxSampleGapMs <= config.maxSampleGapMs,
    ),
    workerHeapVisible: check(
      workerEvidence.filter(Boolean).length,
      measuredSamples.length,
      measuredSamples.length > 0 && workerEvidence.every(Boolean),
    ),
    workerLifecycle: check(
      workerLifecyclePassed ? workerIdentities[0] : null,
      "exactly one stable drawing worker target/session across readiness and every sample",
      workerLifecyclePassed,
      {
        initialWorkerTargets: Array.isArray(initialWorkerTargets)
          ? initialWorkerTargets.length
          : null,
        finalWorkerTargets: Array.isArray(finalWorkerTargets)
          ? finalWorkerTargets.length
          : null,
        distinctSampleWorkers: new Set(workerIdentities).size,
      },
    ),
    naturalHeapDelta: check(
      naturalHeap.deltaBytes,
      `<= ${naturalUsedAcceptance.deltaAllowanceBytes ?? "finite runtime allowance"} bytes`,
      naturalHeap.observedDurationMs >= config.requiredMeasuredDurationMs
        && naturalUsedAcceptance.deltaPassed,
    ),
    gcCoverage: check(
      gc.checkpoints,
      `>= ${requiredGcCheckpoints} checkpoints over ${config.requiredMeasuredDurationMs}ms`,
      gc.checkpoints >= requiredGcCheckpoints
        && gc.observedDurationMs >= config.requiredMeasuredDurationMs,
      {
        configuredMinimum: config.minGcCheckpoints,
        derivedMinimum: derivedMinimumGcCheckpoints,
        observedDurationMs: gc.observedDurationMs,
      },
    ),
    gcEvidence: check(
      invalidGcCheckpointIndexes.length + duplicateGcTimestamps,
      0,
      rawGcCheckpoints.length > 0
        && invalidGcCheckpointIndexes.length === 0
        && duplicateGcTimestamps === 0,
      { invalidGcCheckpointIndexes, duplicateGcTimestamps },
    ),
    gcCadence: check(
      maxGcGapMs,
      `<= ${config.gcIntervalMs + config.maxSampleGapMs}`,
      maxGcGapMs !== null
        && maxGcGapMs <= config.gcIntervalMs + config.maxSampleGapMs,
    ),
    retainedHeapDelta: check(
      gc.deltaBytes,
      `<= ${usedCurveAcceptance.deltaAllowanceBytes ?? "finite runtime allowance"} bytes`,
      usedCurveAcceptance.deltaPassed,
    ),
    retainedHeapSlope: check(
      gc.slopeBytesPerHour,
      `<= ${gc.slopeLimitBytesPerHour ?? "finite runtime limit"} bytes/hour`,
      usedCurveAcceptance.slopePassed,
      { slopePctPerHour: gc.slopePctPerHour },
    ),
    retainedHeapPlateau: check(
      gc.plateauDeltaBytes,
      `<= ${gc.plateauAllowanceBytes ?? "finite runtime allowance"} bytes`,
      usedCurveAcceptance.plateauPassed,
    ),
    backingStorageNaturalDelta: check(
      naturalBackingStorage.deltaBytes,
      `<= ${naturalBackingAcceptance.deltaAllowanceBytes ?? "finite runtime allowance"} bytes`,
      naturalBackingStorage.observedDurationMs >= config.requiredMeasuredDurationMs
        && naturalBackingAcceptance.deltaPassed,
    ),
    backingStorageRetainedDelta: check(
      gcBackingStorage.deltaBytes,
      `<= ${backingCurveAcceptance.deltaAllowanceBytes ?? "finite runtime allowance"} bytes`,
      backingCurveAcceptance.deltaPassed,
    ),
    backingStorageRetainedSlope: check(
      gcBackingStorage.slopeBytesPerHour,
      `<= ${gcBackingStorage.slopeLimitBytesPerHour ?? "finite runtime limit"} bytes/hour`,
      backingCurveAcceptance.slopePassed,
      { slopePctPerHour: gcBackingStorage.slopePctPerHour },
    ),
    backingStorageRetainedPlateau: check(
      gcBackingStorage.plateauDeltaBytes,
      `<= ${gcBackingStorage.plateauAllowanceBytes ?? "finite runtime allowance"} bytes`,
      backingCurveAcceptance.plateauPassed,
    ),
    embedderHeapNaturalDelta: check(
      naturalEmbedderHeap.deltaBytes,
      `<= ${naturalEmbedderAcceptance.deltaAllowanceBytes ?? "finite runtime allowance"} bytes`,
      naturalEmbedderHeap.observedDurationMs >= config.requiredMeasuredDurationMs
        && naturalEmbedderAcceptance.deltaPassed,
    ),
    embedderHeapRetainedDelta: check(
      gcEmbedderHeap.deltaBytes,
      `<= ${embedderCurveAcceptance.deltaAllowanceBytes ?? "finite runtime allowance"} bytes`,
      embedderCurveAcceptance.deltaPassed,
    ),
    embedderHeapRetainedSlope: check(
      gcEmbedderHeap.slopeBytesPerHour,
      `<= ${gcEmbedderHeap.slopeLimitBytesPerHour ?? "finite runtime limit"} bytes/hour`,
      embedderCurveAcceptance.slopePassed,
      { slopePctPerHour: gcEmbedderHeap.slopePctPerHour },
    ),
    embedderHeapRetainedPlateau: check(
      gcEmbedderHeap.plateauDeltaBytes,
      `<= ${gcEmbedderHeap.plateauAllowanceBytes ?? "finite runtime allowance"} bytes`,
      embedderCurveAcceptance.plateauPassed,
    ),
    cacheEvidence: check(
      cacheComplete ? maximum(cacheMaxima) : null,
      "finite non-negative current/max/budget/hard-limit/entry/eviction evidence with a non-empty heavy-scene cache",
      cacheComplete && maximum(cacheMaxima) > 0 && maximum(cacheEntryCounts) > 0,
      {
        cacheEntryCountMax: maximum(cacheEntryCounts),
        cacheBudgetEvictionCountMax: maximum(cacheBudgetEvictions),
        cacheEntryBytesMax: maximum(cacheEntryBytes),
        cacheMetadataBytesMax: maximum(cacheMetadataBytes),
        cacheRecentHierarchyKeyCountMax: maximum(cacheRecentHierarchyKeys),
        cacheRecentRequestCountMax: maximum(cacheRecentRequestCounts),
      },
    ),
    cacheBudget: check(
      cacheComplete ? maximum(cacheMaxima) : null,
      "every current/max <= runtime budget <= hard limit",
      cacheWithinBudget,
      {
        budgets: cacheComplete ? [...new Set(cacheBudgets)] : [],
        hardLimits: cacheComplete ? [...new Set(cacheHardLimits)] : [],
        recentRequestLimits: cacheComplete ? [...new Set(cacheRecentRequestLimits)] : [],
        entryBudgets: cacheComplete ? [...new Set(cacheEntryBudgets)] : [],
        metadataBudgets: cacheComplete ? [...new Set(cacheMetadataBudgets)] : [],
      },
    ),
    runtimeInvariants: check(
      runtimeInvariantFailures.length,
      0,
      runtimes.length > 0 && runtimeInvariantFailures.length === 0,
      { failedSampleIndexes: runtimeInvariantFailures },
    ),
    browserTimingProgress: check(
      browserTimingProgressPassed,
      "measured timing histograms remain complete and monotonically accumulate after warmup",
      browserTimingProgressPassed,
    ),
    inputFrameLatency: check(
      inputFrameLatency,
      {
        frameIntervalP95Ms: `<= ${config.frameIntervalP95Ms}`,
        frameIntervalP99Ms: `<= ${config.frameIntervalP99Ms}`,
        inputToNextPaintP95Ms: `<= ${config.inputToNextPaintP95Ms}`,
        inputToNextPaintP99Ms: `<= ${config.inputToNextPaintP99Ms}`,
      },
      inputFrameLatencyPassed,
    ),
    inputFrameLatencyByType: check(
      inputFrameLatencyByType,
      {
        p95: `each type has >= ${DRAWING_INPUT_P95_MINIMUM_SAMPLES} samples and p95 <= ${config.inputToNextPaintP95Ms}ms`,
        p99: `each type has >= ${DRAWING_INPUT_P99_MINIMUM_SAMPLES} samples and p99 <= ${config.inputToNextPaintP99Ms}ms`,
      },
      inputFrameLatencyByTypePassed,
    ),
    inputPaintFenceEvidence: check(
      inputPaintFenceEvidence.actual,
      `${DRAWING_INPUT_POST_RAF_TASK_SCHEMA_VERSION} bounded top-${DRAWING_INPUT_PAINT_FENCE_CAPACITY} trace with attributed monotonic post-rAF-task fences`,
      inputPaintFenceEvidence.passed,
    ),
    workerWorkload: check(
      measuredCycles.reduce((total, cycle) => total + cycle.workerResultCycleDelta, 0),
      "every measured viewport churn submits and completes positive worker work",
      runtimes.length > 0
        && runtimes.every((runtime) => nonNegativeNumber(runtime?.workerJobDelta) !== null
          && runtime.workerJobDelta > 0
          && nonNegativeNumber(runtime?.workerResultDelta) !== null
          && runtime.workerResultDelta > 0
          && runtime.workerResultDelta <= runtime.workerJobDelta)
        && invalidCycleIndexes.length === 0
        && measuredCycles.length > 0
        && measuredCycles.every((cycle) => cycle.workerJobCycleDelta > 0
          && cycle.workerResultCycleDelta > 0
          && cycle.workerResultCycleDelta <= cycle.workerJobCycleDelta
          && cycle.stalePublishCycleDelta === 0),
      {
        maxWorkerJobs: maximum(runtimes.map((runtime) => runtime?.workerJobDelta)),
        maxWorkerResults: maximum(runtimes.map((runtime) => runtime?.workerResultDelta)),
        measuredWorkerJobs: measuredCycles.reduce(
          (total, cycle) => total + cycle.workerJobCycleDelta,
          0,
        ),
        measuredWorkerResults: measuredCycles.reduce(
          (total, cycle) => total + cycle.workerResultCycleDelta,
          0,
        ),
      },
    ),
    workloadCycles: check(
      measuredCycles.length,
      `>= ${minimumCycles}`,
      measuredCycles.length >= minimumCycles && invalidCycleIndexes.length === 0,
      {
        attempted: cycles.length,
        measured: measuredCycles.length,
        invalidCycleIndexes,
        expectedCycles,
        minimumCycles,
      },
    ),
    workloadCadence: check(
      maxCycleGapMs,
      `<= ${config.workloadIntervalMs + config.maxSampleGapMs} with full measured-window coverage`,
      cycleWindowCovered
        && maxCycleGapMs !== null
        && maxCycleGapMs <= config.workloadIntervalMs + config.maxSampleGapMs,
      { firstCycleElapsedMs, finalCycleElapsedMs, cycleWindowCovered },
    ),
    viewportChurn: check(
      distinctViewportRevisions,
      `>= ${config.minDistinctViewportRevisions} strictly increasing revisions`,
      distinctViewportRevisions >= config.minDistinctViewportRevisions
        && viewportRevisionsMonotonic,
      { viewportRevisionsMonotonic },
    ),
    diagnostics: check(
      diagnosticsComplete ? diagnosticCounts : null,
      "all diagnostic channels present and zero",
      diagnosticsClean,
    ),
    longTaskAttribution: check(
      longTaskCounts ?? null,
      "zero drawing-attributable Long Tasks; raw tasks are recomputed against exact forced-GC windows",
      longTaskAttributionPassed,
      {
        expectedInstrumentationNames,
        instrumentationWindowsPassed,
        recomputedExcludedCount: recomputedExcludedLongTasks.length,
        recomputedAttributableCount: recomputedAttributableLongTasks.length,
      },
    ),
  });
  const smokePassed = Object.entries(checks)
    .filter(([name]) => name !== "formalEligibility")
    .every(([, item]) => item.passed === true);
  const formalPassed = formalEligible && smokePassed;
  return Object.freeze({
    passed: formalPassed,
    formalEligible,
    formalAcceptance: Object.freeze({ passed: formalPassed, eligible: formalEligible }),
    smokeAcceptance: Object.freeze({ passed: smokePassed, formalEligible }),
    configuration: config,
    summary: Object.freeze({
      observedDurationMs,
      expectedSamples,
      observedSamples: measuredSamples.length,
      sampleCoverage,
      maxSampleGapMs,
      invalidSampleIndexes,
      duplicateSampleTimestamps,
      naturalHeap,
      naturalBackingStorage,
      naturalEmbedderHeap,
      gc,
      gcBackingStorage,
      gcEmbedderHeap,
      maxGcGapMs,
      invalidGcCheckpointIndexes,
      duplicateGcTimestamps,
      cacheMaxBytes: maximum(cacheMaxima),
      cacheEntryCountMax: maximum(cacheEntryCounts),
      cacheBudgetEvictionCountMax: maximum(cacheBudgetEvictions),
      cacheEntryBytesMax: maximum(cacheEntryBytes),
      cacheMetadataBytesMax: maximum(cacheMetadataBytes),
      cacheRecentHierarchyKeyCountMax: maximum(cacheRecentHierarchyKeys),
      cacheRecentRequestCountMax: maximum(cacheRecentRequestCounts),
      inputFrameLatency,
      inputFrameLatencyByType,
      inputPaintFenceEvidence: inputPaintFenceEvidence.actual,
      eventLatencyCalibration: eventLatencyCalibration.actual,
      cyclesAttempted: cycles.length,
      cyclesPassed: measuredCycles.length,
      maxCycleGapMs,
      cycleWindowCovered,
      distinctViewportRevisions,
      diagnosticCounts,
    }),
    checks,
    failureReasons: Object.entries(checks)
      .filter(([, value]) => value.passed !== true)
      .map(([name]) => name),
  });
}
