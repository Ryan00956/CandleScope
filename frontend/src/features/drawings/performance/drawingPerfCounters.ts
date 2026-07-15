import { recordPerfEvent } from "../../../runtime/performance/perfMarks.js";

export const DRAWING_PERF_EVENT_NAME = "drawing.perf.summary";
export const DEFAULT_DRAWING_PERF_FLUSH_INTERVAL_MS = 5_000;
export const DEFAULT_DRAWING_PERF_HISTOGRAM_CAPACITY = 240;
export const DEFAULT_DRAWING_LONG_TASK_THRESHOLD_MS = 50;
export const DEFAULT_DRAWING_PERF_RAW_CAPTURE_CAPACITY = 20_000;

export const DRAWING_PERF_DURATION_METRICS = [
  "frameMs",
  "inputMs",
  "interactionMs",
  "longTaskMs",
  "drawingMainThreadMs",
  "hitQueryMs",
  "mouseupSyncMs",
  "persistenceMs",
  "sceneProjectPaintMs",
  "activeOverlayCpuMs",
] as const;

export const DRAWING_PERF_COUNTER_METRICS = [
  "frameCount",
  "inputCount",
  "interactionCount",
  "longTaskCount",
  "anchorResolveCount",
  "finalProjectionCount",
  "sceneRebuildCount",
  "requestUpdateCount",
  "workerJobCount",
  "workerResultCount",
  "staleWorkerResultCount",
  "workerQueueDropCount",
  "shadowCompareCount",
  "shadowParityMismatchCount",
  "shadowSkippedCount",
  "shadowErrorCount",
] as const;

export const DRAWING_PERF_GAUGE_METRICS = [
  "rawPoints",
  "renderedPoints",
  "visibleEntities",
  "culledEntities",
  "lodRatio",
  "workerQueue",
  "workerInFlight",
  "cacheBytes",
  "shadowComparedEntities",
  "shadowComparedHits",
  "shadowGapProjectionMs",
  "shadowLegacyProbeMs",
  "shadowMismatchItems",
  "shadowParityCompareMs",
  "shadowParityMs",
  "shadowSceneBuildMs",
] as const;

export type DrawingPerfDurationMetric = typeof DRAWING_PERF_DURATION_METRICS[number];
export type DrawingPerfCounterMetric = typeof DRAWING_PERF_COUNTER_METRICS[number];
export type DrawingPerfGaugeMetric = typeof DRAWING_PERF_GAUGE_METRICS[number];
export type DrawingPerfFrameWorkDurationMetric =
  | "drawingMainThreadMs"
  | "sceneProjectPaintMs";
export type DrawingPerfFrameWorkGeometryMetric =
  | "rawPoints"
  | "renderedPoints"
  | "visibleEntities"
  | "culledEntities";
export type DrawingPerfFlushReason =
  | "interval"
  | "gesture-end"
  | "manual"
  | "dispose"
  | (string & {});

export interface DrawingPerfHistogramSnapshot {
  /** Samples represented by the percentile values (never greater than capacity). */
  sampleCount: number;
  /** All valid samples observed since reset, including overwritten samples. */
  totalCount: number;
  capacity: number;
  /** Retained samples in observation order; bounded by capacity. */
  samples: readonly number[];
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface DrawingLongTaskAttributionSnapshot {
  count: number;
  totalDurationMs: number;
}

export interface DrawingPerfSnapshot {
  schemaVersion: 1;
  capturedAtMs: number;
  startedAtMs: number;
  elapsedMs: number;
  lastFlushAtMs: number;
  flushSequence: number;
  histogramCapacity: number;
  durations: Record<DrawingPerfDurationMetric, DrawingPerfHistogramSnapshot>;
  counters: Record<DrawingPerfCounterMetric, number>;
  counterMaxima: Record<DrawingPerfCounterMetric, number>;
  gauges: Record<DrawingPerfGaugeMetric, number>;
  gaugeMaxima: Record<DrawingPerfGaugeMetric, number>;
  longTasksByAttribution: Record<string, DrawingLongTaskAttributionSnapshot>;
}

export interface DrawingPerfSummaryEventDetail {
  reason: DrawingPerfFlushReason;
  snapshot: DrawingPerfSnapshot;
}

export interface DrawingPerfRawMetricCapture {
  /** Undrained samples in observation order. */
  samples: readonly number[];
  /** Valid samples observed since the previous drain or reset. */
  observedCount: number;
  /** Oldest samples overwritten because the bounded capture filled up. */
  droppedCount: number;
  capacity: number;
}

export interface DrawingPerfRawCaptureSnapshot {
  enabled: boolean;
  capacityPerMetric: number;
  metrics: Record<DrawingPerfDurationMetric, DrawingPerfRawMetricCapture>;
}

export interface DrawingPerfFrameWorkContribution {
  /** Stable primitive/entity id used to de-duplicate geometry within one frame. */
  geometryKey?: string;
  drawingMainThreadMs?: number;
  sceneProjectPaintMs?: number;
  rawPoints?: number;
  renderedPoints?: number;
  visibleEntities?: number;
  culledEntities?: number;
}

export interface DrawingPerfFrameWorkFlushResult {
  contributionCount: number;
  drawingMainThreadMs: number | null;
  sceneProjectPaintMs: number | null;
  rawPoints: number | null;
  renderedPoints: number | null;
  visibleEntities: number | null;
  culledEntities: number | null;
}

export interface DrawingPerfRuntimeSummary {
  entityCount: number;
  pointCount: number;
  typeCounts: Readonly<Record<string, number>>;
}

export type DrawingPerfRuntimeSummaryProvider = () => DrawingPerfRuntimeSummary | null;
export type DrawingPerfShadowParityRequester = () => boolean;

export interface DrawingPerfBootstrapConfig {
  /** Benchmark-only: retain a larger drainable raw sample stream. */
  benchmarkRawCapture?: boolean;
  rawCaptureCapacity?: number;
}

export type DrawingPerfReporter = (
  eventName: typeof DRAWING_PERF_EVENT_NAME,
  detail: DrawingPerfSummaryEventDetail,
) => unknown;

export interface DrawingPerfCountersOptions {
  now?: () => number;
  reporter?: DrawingPerfReporter | null;
  flushIntervalMs?: number;
  histogramCapacity?: number;
  longTaskThresholdMs?: number;
  maxLongTaskAttributions?: number;
  benchmarkRawCapture?: boolean;
  rawCaptureCapacity?: number;
}

export interface DrawingPerfCounters {
  recordDuration(metric: DrawingPerfDurationMetric, durationMs: number): boolean;
  recordFrameDuration(durationMs: number): boolean;
  recordInputDuration(durationMs: number): boolean;
  recordInteractionDuration(durationMs: number): boolean;
  recordDrawingMainThreadDuration(durationMs: number): boolean;
  recordHitQueryDuration(durationMs: number): boolean;
  recordMouseupSyncDuration(durationMs: number): boolean;
  recordPersistenceDuration(durationMs: number): boolean;
  recordSceneProjectPaintDuration(durationMs: number): boolean;
  recordActiveOverlayCpuDuration(durationMs: number): boolean;
  accumulateFrameWork(contribution: DrawingPerfFrameWorkContribution): boolean;
  flushFrameWork(): DrawingPerfFrameWorkFlushResult | null;
  recordLongTask(durationMs: number, attribution?: string): boolean;
  incrementCounter(metric: DrawingPerfCounterMetric, by?: number): boolean;
  setGauge(metric: DrawingPerfGaugeMetric, value: number): boolean;
  recordAnchorResolve(count?: number): boolean;
  recordFinalProjection(count?: number): boolean;
  recordSceneRebuild(count?: number): boolean;
  recordRequestUpdate(count?: number): boolean;
  recordWorkerQueue(depth: number): boolean;
  gestureEnded(): DrawingPerfSummaryEventDetail;
  flush(reason?: DrawingPerfFlushReason): DrawingPerfSummaryEventDetail;
  readRawCapture(): DrawingPerfRawCaptureSnapshot;
  drainRawCapture(): DrawingPerfRawCaptureSnapshot;
  snapshot(): DrawingPerfSnapshot;
  reset(): void;
}

export interface DrawingPerfDebugHandle {
  readonly report: () => DrawingPerfSnapshot;
  readonly snapshot: () => DrawingPerfSnapshot;
  readonly flush: (reason?: DrawingPerfFlushReason) => DrawingPerfSummaryEventDetail;
  readonly readRawCapture: () => DrawingPerfRawCaptureSnapshot;
  readonly drainRawCapture: () => DrawingPerfRawCaptureSnapshot;
  readonly registerRuntimeSummaryProvider: (
    provider: DrawingPerfRuntimeSummaryProvider | null,
  ) => () => void;
  readonly readRuntimeSummary: () => DrawingPerfRuntimeSummary | null;
  readonly requestShadowParity: () => boolean;
  readonly reset: () => void;
}

export interface DrawingPerfHostGlobal {
  __CANDLESCOPE_DRAWING_PERF__?: DrawingPerfDebugHandle;
  __CANDLESCOPE_DRAWING_PERF_CONFIG__?: DrawingPerfBootstrapConfig;
}

interface MutableLongTaskAttribution {
  count: number;
  totalDurationMs: number;
}

const MAX_HISTOGRAM_CAPACITY = 4_096;
const MAX_RAW_CAPTURE_CAPACITY = 100_000;
const DEFAULT_MAX_LONG_TASK_ATTRIBUTIONS = 16;
const MAX_LONG_TASK_ATTRIBUTIONS = 64;
const MAX_RUNTIME_SUMMARY_TYPES = 128;
const OTHER_LONG_TASK_ATTRIBUTION = "other";
const FRAME_WORK_METRICS = [
  "drawingMainThreadMs",
  "sceneProjectPaintMs",
  "rawPoints",
  "renderedPoints",
  "visibleEntities",
  "culledEntities",
] as const;
const FRAME_WORK_GEOMETRY_METRICS = [
  "rawPoints",
  "renderedPoints",
  "visibleEntities",
  "culledEntities",
] as const;

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function nearestRank(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sortedValues.length));
  return sortedValues[rank - 1] ?? null;
}

class RollingDurationHistogram {
  readonly capacity: number;

  private readonly values: Float64Array;
  private nextIndex = 0;
  private retainedCount = 0;
  private observedCount = 0;
  private retainedSum = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.values = new Float64Array(capacity);
  }

  record(value: number): void {
    if (this.retainedCount === this.capacity) {
      this.retainedSum -= this.values[this.nextIndex] ?? 0;
    } else {
      this.retainedCount += 1;
    }

    this.values[this.nextIndex] = value;
    this.retainedSum += value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.observedCount += 1;
  }

  snapshot(): DrawingPerfHistogramSnapshot {
    if (this.retainedCount === 0) {
      return {
        sampleCount: 0,
        totalCount: this.observedCount,
        capacity: this.capacity,
        samples: [],
        minMs: null,
        maxMs: null,
        meanMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      };
    }

    const oldestIndex = this.retainedCount === this.capacity ? this.nextIndex : 0;
    const retainedValues = new Array<number>(this.retainedCount);
    for (let offset = 0; offset < this.retainedCount; offset += 1) {
      const index = (oldestIndex + offset) % this.capacity;
      retainedValues[offset] = this.values[index] ?? 0;
    }
    const sortedValues = [...retainedValues];
    sortedValues.sort((left, right) => left - right);

    return {
      sampleCount: this.retainedCount,
      totalCount: this.observedCount,
      capacity: this.capacity,
      samples: retainedValues,
      minMs: sortedValues[0] ?? null,
      maxMs: sortedValues[this.retainedCount - 1] ?? null,
      meanMs: this.retainedSum / this.retainedCount,
      p50Ms: nearestRank(sortedValues, 50),
      p95Ms: nearestRank(sortedValues, 95),
      p99Ms: nearestRank(sortedValues, 99),
    };
  }

  reset(): void {
    this.nextIndex = 0;
    this.retainedCount = 0;
    this.observedCount = 0;
    this.retainedSum = 0;
  }
}

class BoundedRawCapture {
  readonly capacity: number;

  private readonly values: Float64Array;
  private nextIndex = 0;
  private retainedCount = 0;
  private observedCount = 0;
  private droppedCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.values = new Float64Array(capacity);
  }

  record(value: number): void {
    if (this.retainedCount === this.capacity) {
      this.droppedCount += 1;
    } else {
      this.retainedCount += 1;
    }
    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.observedCount += 1;
  }

  read(): DrawingPerfRawMetricCapture {
    const oldestIndex = this.retainedCount === this.capacity ? this.nextIndex : 0;
    const samples = new Array<number>(this.retainedCount);
    for (let offset = 0; offset < this.retainedCount; offset += 1) {
      samples[offset] = this.values[(oldestIndex + offset) % this.capacity] ?? 0;
    }
    return {
      samples,
      observedCount: this.observedCount,
      droppedCount: this.droppedCount,
      capacity: this.capacity,
    };
  }

  drain(): DrawingPerfRawMetricCapture {
    const snapshot = this.read();
    this.reset();
    return snapshot;
  }

  reset(): void {
    this.nextIndex = 0;
    this.retainedCount = 0;
    this.observedCount = 0;
    this.droppedCount = 0;
  }
}

function createDurationHistograms(
  capacity: number,
): Record<DrawingPerfDurationMetric, RollingDurationHistogram> {
  return {
    frameMs: new RollingDurationHistogram(capacity),
    inputMs: new RollingDurationHistogram(capacity),
    interactionMs: new RollingDurationHistogram(capacity),
    longTaskMs: new RollingDurationHistogram(capacity),
    drawingMainThreadMs: new RollingDurationHistogram(capacity),
    hitQueryMs: new RollingDurationHistogram(capacity),
    mouseupSyncMs: new RollingDurationHistogram(capacity),
    persistenceMs: new RollingDurationHistogram(capacity),
    sceneProjectPaintMs: new RollingDurationHistogram(capacity),
    activeOverlayCpuMs: new RollingDurationHistogram(capacity),
  };
}

function createRawCaptures(
  capacity: number,
): Record<DrawingPerfDurationMetric, BoundedRawCapture> {
  return {
    frameMs: new BoundedRawCapture(capacity),
    inputMs: new BoundedRawCapture(capacity),
    interactionMs: new BoundedRawCapture(capacity),
    longTaskMs: new BoundedRawCapture(capacity),
    drawingMainThreadMs: new BoundedRawCapture(capacity),
    hitQueryMs: new BoundedRawCapture(capacity),
    mouseupSyncMs: new BoundedRawCapture(capacity),
    persistenceMs: new BoundedRawCapture(capacity),
    sceneProjectPaintMs: new BoundedRawCapture(capacity),
    activeOverlayCpuMs: new BoundedRawCapture(capacity),
  };
}

function emptyRawMetricCapture(): DrawingPerfRawMetricCapture {
  return { samples: [], observedCount: 0, droppedCount: 0, capacity: 0 };
}

function emptyRawCaptureSnapshot(): DrawingPerfRawCaptureSnapshot {
  return {
    enabled: false,
    capacityPerMetric: 0,
    metrics: {
      frameMs: emptyRawMetricCapture(),
      inputMs: emptyRawMetricCapture(),
      interactionMs: emptyRawMetricCapture(),
      longTaskMs: emptyRawMetricCapture(),
      drawingMainThreadMs: emptyRawMetricCapture(),
      hitQueryMs: emptyRawMetricCapture(),
      mouseupSyncMs: emptyRawMetricCapture(),
      persistenceMs: emptyRawMetricCapture(),
      sceneProjectPaintMs: emptyRawMetricCapture(),
      activeOverlayCpuMs: emptyRawMetricCapture(),
    },
  };
}

interface FrameWorkAccumulator {
  contributionCount: number;
  values: Record<
    DrawingPerfFrameWorkDurationMetric | DrawingPerfFrameWorkGeometryMetric,
    number
  >;
  seen: Record<
    DrawingPerfFrameWorkDurationMetric | DrawingPerfFrameWorkGeometryMetric,
    boolean
  >;
  geometryByKey: Map<string, Partial<Record<DrawingPerfFrameWorkGeometryMetric, number>>>;
}

function createFrameWorkAccumulator(): FrameWorkAccumulator {
  return {
    contributionCount: 0,
    values: {
      drawingMainThreadMs: 0,
      sceneProjectPaintMs: 0,
      rawPoints: 0,
      renderedPoints: 0,
      visibleEntities: 0,
      culledEntities: 0,
    },
    seen: {
      drawingMainThreadMs: false,
      sceneProjectPaintMs: false,
      rawPoints: false,
      renderedPoints: false,
      visibleEntities: false,
      culledEntities: false,
    },
    geometryByKey: new Map(),
  };
}

function createCounters(): Record<DrawingPerfCounterMetric, number> {
  return {
    frameCount: 0,
    inputCount: 0,
    interactionCount: 0,
    longTaskCount: 0,
    anchorResolveCount: 0,
    finalProjectionCount: 0,
    sceneRebuildCount: 0,
    requestUpdateCount: 0,
    workerJobCount: 0,
    workerResultCount: 0,
    staleWorkerResultCount: 0,
    workerQueueDropCount: 0,
    shadowCompareCount: 0,
    shadowParityMismatchCount: 0,
    shadowSkippedCount: 0,
    shadowErrorCount: 0,
  };
}

function createGauges(): Record<DrawingPerfGaugeMetric, number> {
  return {
    rawPoints: 0,
    renderedPoints: 0,
    visibleEntities: 0,
    culledEntities: 0,
    lodRatio: 0,
    workerQueue: 0,
    workerInFlight: 0,
    cacheBytes: 0,
    shadowComparedEntities: 0,
    shadowComparedHits: 0,
    shadowGapProjectionMs: 0,
    shadowLegacyProbeMs: 0,
    shadowMismatchItems: 0,
    shadowParityCompareMs: 0,
    shadowParityMs: 0,
    shadowSceneBuildMs: 0,
  };
}

function copyCounters(
  counters: Readonly<Record<DrawingPerfCounterMetric, number>>,
): Record<DrawingPerfCounterMetric, number> {
  return { ...counters };
}

function copyGauges(
  gauges: Readonly<Record<DrawingPerfGaugeMetric, number>>,
): Record<DrawingPerfGaugeMetric, number> {
  return { ...gauges };
}

class DrawingPerfCountersImpl implements DrawingPerfCounters {
  private readonly clock: () => number;
  private readonly reporter: DrawingPerfReporter | null;
  private readonly flushIntervalMs: number;
  private readonly longTaskThresholdMs: number;
  private readonly maxLongTaskAttributions: number;
  private readonly histograms: Record<DrawingPerfDurationMetric, RollingDurationHistogram>;
  private readonly rawCaptures: Record<DrawingPerfDurationMetric, BoundedRawCapture> | null;
  private readonly counters = createCounters();
  private readonly counterMaxima = createCounters();
  private readonly gauges = createGauges();
  private readonly gaugeMaxima = createGauges();
  private readonly longTaskAttributions = new Map<string, MutableLongTaskAttribution>();
  private readonly frameWork = createFrameWorkAccumulator();

  private lastKnownNow = 0;
  private startedAtMs: number;
  private lastFlushAtMs: number;
  private flushSequence = 0;

  constructor(options: DrawingPerfCountersOptions) {
    this.clock = options.now ?? defaultNow;
    this.reporter = options.reporter === undefined ? recordPerfEvent : options.reporter;
    this.flushIntervalMs = normalizePositiveNumber(
      options.flushIntervalMs,
      DEFAULT_DRAWING_PERF_FLUSH_INTERVAL_MS,
    );
    this.longTaskThresholdMs = normalizeNonNegativeNumber(
      options.longTaskThresholdMs,
      DEFAULT_DRAWING_LONG_TASK_THRESHOLD_MS,
    );
    this.maxLongTaskAttributions = normalizePositiveInteger(
      options.maxLongTaskAttributions,
      DEFAULT_MAX_LONG_TASK_ATTRIBUTIONS,
      MAX_LONG_TASK_ATTRIBUTIONS,
    );
    const histogramCapacity = normalizePositiveInteger(
      options.histogramCapacity,
      DEFAULT_DRAWING_PERF_HISTOGRAM_CAPACITY,
      MAX_HISTOGRAM_CAPACITY,
    );
    this.histograms = createDurationHistograms(histogramCapacity);
    this.rawCaptures = options.benchmarkRawCapture === true
      ? createRawCaptures(normalizePositiveInteger(
        options.rawCaptureCapacity,
        DEFAULT_DRAWING_PERF_RAW_CAPTURE_CAPACITY,
        MAX_RAW_CAPTURE_CAPACITY,
      ))
      : null;
    this.startedAtMs = this.readNow();
    this.lastFlushAtMs = this.startedAtMs;
  }

  recordDuration(metric: DrawingPerfDurationMetric, durationMs: number): boolean {
    if (metric === "longTaskMs") return this.recordLongTask(durationMs);
    if (!this.isValidDuration(durationMs)) return false;

    this.recordDurationWithoutFlush(metric, durationMs);
    this.markDirtyAndMaybeFlush();
    return true;
  }

  recordFrameDuration(durationMs: number): boolean {
    return this.recordDuration("frameMs", durationMs);
  }

  recordInputDuration(durationMs: number): boolean {
    return this.recordDuration("inputMs", durationMs);
  }

  recordInteractionDuration(durationMs: number): boolean {
    return this.recordDuration("interactionMs", durationMs);
  }

  recordDrawingMainThreadDuration(durationMs: number): boolean {
    return this.recordDuration("drawingMainThreadMs", durationMs);
  }

  recordHitQueryDuration(durationMs: number): boolean {
    return this.recordDuration("hitQueryMs", durationMs);
  }

  recordMouseupSyncDuration(durationMs: number): boolean {
    return this.recordDuration("mouseupSyncMs", durationMs);
  }

  recordPersistenceDuration(durationMs: number): boolean {
    return this.recordDuration("persistenceMs", durationMs);
  }

  recordSceneProjectPaintDuration(durationMs: number): boolean {
    return this.recordDuration("sceneProjectPaintMs", durationMs);
  }

  recordActiveOverlayCpuDuration(durationMs: number): boolean {
    return this.recordDuration("activeOverlayCpuMs", durationMs);
  }

  accumulateFrameWork(contribution: DrawingPerfFrameWorkContribution): boolean {
    const supplied = contribution.drawingMainThreadMs !== undefined
      || contribution.sceneProjectPaintMs !== undefined
      || contribution.rawPoints !== undefined
      || contribution.renderedPoints !== undefined
      || contribution.visibleEntities !== undefined
      || contribution.culledEntities !== undefined;
    if (!supplied) return false;
    if (contribution.geometryKey !== undefined
      && (typeof contribution.geometryKey !== "string"
        || contribution.geometryKey.trim().length === 0)) return false;
    if (!this.isOptionalNonNegative(contribution.drawingMainThreadMs)
      || !this.isOptionalNonNegative(contribution.sceneProjectPaintMs)
      || !this.isOptionalNonNegative(contribution.rawPoints)
      || !this.isOptionalNonNegative(contribution.renderedPoints)
      || !this.isOptionalNonNegative(contribution.visibleEntities)
      || !this.isOptionalNonNegative(contribution.culledEntities)) {
      return false;
    }

    this.addFrameWorkValue("drawingMainThreadMs", contribution.drawingMainThreadMs);
    this.addFrameWorkValue("sceneProjectPaintMs", contribution.sceneProjectPaintMs);
    const geometryKey = contribution.geometryKey?.trim().slice(0, 160);
    if (geometryKey) {
      const geometry = this.frameWork.geometryByKey.get(geometryKey) ?? {};
      for (const metric of FRAME_WORK_GEOMETRY_METRICS) {
        const value = contribution[metric];
        if (value !== undefined) geometry[metric] = value;
      }
      this.frameWork.geometryByKey.set(geometryKey, geometry);
    } else {
      this.addFrameWorkValue("rawPoints", contribution.rawPoints);
      this.addFrameWorkValue("renderedPoints", contribution.renderedPoints);
      this.addFrameWorkValue("visibleEntities", contribution.visibleEntities);
      this.addFrameWorkValue("culledEntities", contribution.culledEntities);
    }
    this.frameWork.contributionCount += 1;
    return true;
  }

  flushFrameWork(): DrawingPerfFrameWorkFlushResult | null {
    return this.flushFrameWorkInternal(true);
  }

  recordLongTask(durationMs: number, attribution = "unattributed"): boolean {
    if (!this.isValidDuration(durationMs) || durationMs <= this.longTaskThresholdMs) return false;

    this.recordDurationWithoutFlush("longTaskMs", durationMs);
    this.incrementCounterWithoutFlush("longTaskCount", 1);
    this.incrementLongTaskAttribution(attribution, durationMs);
    this.markDirtyAndMaybeFlush();
    return true;
  }

  incrementCounter(metric: DrawingPerfCounterMetric, by = 1): boolean {
    if (!Number.isSafeInteger(by) || by <= 0) return false;
    this.incrementCounterWithoutFlush(metric, by);
    this.markDirtyAndMaybeFlush();
    return true;
  }

  setGauge(metric: DrawingPerfGaugeMetric, value: number): boolean {
    if (!Number.isFinite(value) || value < 0) return false;
    if (metric === "lodRatio" && value > 1) return false;
    this.setGaugeWithoutFlush(metric, value);
    this.markDirtyAndMaybeFlush();
    return true;
  }

  recordAnchorResolve(count = 1): boolean {
    return this.incrementCounter("anchorResolveCount", count);
  }

  recordFinalProjection(count = 1): boolean {
    return this.incrementCounter("finalProjectionCount", count);
  }

  recordSceneRebuild(count = 1): boolean {
    return this.incrementCounter("sceneRebuildCount", count);
  }

  recordRequestUpdate(count = 1): boolean {
    return this.incrementCounter("requestUpdateCount", count);
  }

  recordWorkerQueue(depth: number): boolean {
    return this.setGauge("workerQueue", depth);
  }

  gestureEnded(): DrawingPerfSummaryEventDetail {
    return this.flush("gesture-end");
  }

  flush(reason: DrawingPerfFlushReason = "manual"): DrawingPerfSummaryEventDetail {
    return this.flushAt(reason, this.readNow());
  }

  readRawCapture(): DrawingPerfRawCaptureSnapshot {
    return this.rawCaptureSnapshot(false);
  }

  drainRawCapture(): DrawingPerfRawCaptureSnapshot {
    return this.rawCaptureSnapshot(true);
  }

  snapshot(): DrawingPerfSnapshot {
    return this.snapshotAt(this.readNow());
  }

  reset(): void {
    for (const histogram of Object.values(this.histograms)) histogram.reset();
    if (this.rawCaptures) {
      for (const capture of Object.values(this.rawCaptures)) capture.reset();
    }
    Object.assign(this.counters, createCounters());
    Object.assign(this.counterMaxima, createCounters());
    Object.assign(this.gauges, createGauges());
    Object.assign(this.gaugeMaxima, createGauges());
    this.longTaskAttributions.clear();
    this.resetFrameWork();
    const atMs = this.readNow();
    this.startedAtMs = atMs;
    this.lastFlushAtMs = atMs;
    this.flushSequence = 0;
  }

  private isValidDuration(durationMs: number): boolean {
    return Number.isFinite(durationMs) && durationMs >= 0;
  }

  private isOptionalNonNegative(value: number | undefined): boolean {
    return value === undefined || (Number.isFinite(value) && value >= 0);
  }

  private recordDurationWithoutFlush(
    metric: DrawingPerfDurationMetric,
    durationMs: number,
  ): void {
    this.histograms[metric].record(durationMs);
    this.rawCaptures?.[metric].record(durationMs);
    if (metric === "frameMs") this.incrementCounterWithoutFlush("frameCount", 1);
    if (metric === "inputMs") this.incrementCounterWithoutFlush("inputCount", 1);
    if (metric === "interactionMs") this.incrementCounterWithoutFlush("interactionCount", 1);
  }

  private setGaugeWithoutFlush(metric: DrawingPerfGaugeMetric, value: number): void {
    this.gauges[metric] = value;
    this.gaugeMaxima[metric] = Math.max(this.gaugeMaxima[metric], value);
  }

  private addFrameWorkValue(
    metric: DrawingPerfFrameWorkDurationMetric | DrawingPerfFrameWorkGeometryMetric,
    value: number | undefined,
  ): void {
    if (value === undefined) return;
    this.frameWork.values[metric] += value;
    this.frameWork.seen[metric] = true;
  }

  private flushFrameWorkInternal(
    allowIntervalFlush: boolean,
  ): DrawingPerfFrameWorkFlushResult | null {
    if (this.frameWork.contributionCount === 0) return null;
    for (const geometry of this.frameWork.geometryByKey.values()) {
      for (const metric of FRAME_WORK_GEOMETRY_METRICS) {
        const value = geometry[metric];
        if (value !== undefined) this.addFrameWorkValue(metric, value);
      }
    }
    const result: DrawingPerfFrameWorkFlushResult = {
      contributionCount: this.frameWork.contributionCount,
      drawingMainThreadMs: this.frameWork.seen.drawingMainThreadMs
        ? this.frameWork.values.drawingMainThreadMs
        : null,
      sceneProjectPaintMs: this.frameWork.seen.sceneProjectPaintMs
        ? this.frameWork.values.sceneProjectPaintMs
        : null,
      rawPoints: this.frameWork.seen.rawPoints ? this.frameWork.values.rawPoints : null,
      renderedPoints: this.frameWork.seen.renderedPoints
        ? this.frameWork.values.renderedPoints
        : null,
      visibleEntities: this.frameWork.seen.visibleEntities
        ? this.frameWork.values.visibleEntities
        : null,
      culledEntities: this.frameWork.seen.culledEntities
        ? this.frameWork.values.culledEntities
        : null,
    };
    this.resetFrameWork();

    if (result.drawingMainThreadMs !== null) {
      this.recordDurationWithoutFlush("drawingMainThreadMs", result.drawingMainThreadMs);
      if (result.drawingMainThreadMs > this.longTaskThresholdMs) {
        this.recordDurationWithoutFlush("longTaskMs", result.drawingMainThreadMs);
        this.incrementCounterWithoutFlush("longTaskCount", 1);
        this.incrementLongTaskAttribution("drawing-frame-work", result.drawingMainThreadMs);
      }
    }
    if (result.sceneProjectPaintMs !== null) {
      this.recordDurationWithoutFlush("sceneProjectPaintMs", result.sceneProjectPaintMs);
    }
    if (result.rawPoints !== null) this.setGaugeWithoutFlush("rawPoints", result.rawPoints);
    if (result.renderedPoints !== null) {
      this.setGaugeWithoutFlush("renderedPoints", result.renderedPoints);
    }
    if (result.visibleEntities !== null) {
      this.setGaugeWithoutFlush("visibleEntities", result.visibleEntities);
    }
    if (result.culledEntities !== null) {
      this.setGaugeWithoutFlush("culledEntities", result.culledEntities);
    }
    if (result.rawPoints !== null && result.renderedPoints !== null) {
      const lodRatio = result.rawPoints === 0
        ? 0
        : Math.min(1, result.renderedPoints / result.rawPoints);
      this.setGaugeWithoutFlush("lodRatio", lodRatio);
    }
    if (allowIntervalFlush) this.markDirtyAndMaybeFlush();
    return result;
  }

  private resetFrameWork(): void {
    this.frameWork.contributionCount = 0;
    this.frameWork.geometryByKey.clear();
    for (const metric of FRAME_WORK_METRICS) {
      this.frameWork.values[metric] = 0;
      this.frameWork.seen[metric] = false;
    }
  }

  private incrementCounterWithoutFlush(metric: DrawingPerfCounterMetric, by: number): void {
    this.counters[metric] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[metric] + by);
    this.counterMaxima[metric] = Math.max(this.counterMaxima[metric], this.counters[metric]);
  }

  private incrementLongTaskAttribution(attribution: string, durationMs: number): void {
    const normalized = attribution.trim().slice(0, 80) || "unattributed";
    let key = normalized;
    if (!this.longTaskAttributions.has(key)) {
      const namedCapacity = Math.max(0, this.maxLongTaskAttributions - 1);
      if (this.longTaskAttributions.size >= namedCapacity) key = OTHER_LONG_TASK_ATTRIBUTION;
    }

    const current = this.longTaskAttributions.get(key);
    if (current) {
      current.count = Math.min(Number.MAX_SAFE_INTEGER, current.count + 1);
      current.totalDurationMs = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.totalDurationMs + durationMs,
      );
      return;
    }
    this.longTaskAttributions.set(key, { count: 1, totalDurationMs: durationMs });
  }

  private markDirtyAndMaybeFlush(): void {
    const atMs = this.readNow();
    // Never publish an interval summary from the middle of a synchronous
    // multi-primitive redraw. The shared rAF flush below will commit the
    // complete frame and call this method again before publishing.
    if (this.frameWork.contributionCount === 0
      && atMs - this.lastFlushAtMs >= this.flushIntervalMs) {
      this.flushAt("interval", atMs);
    }
  }

  private flushAt(reason: DrawingPerfFlushReason, atMs: number): DrawingPerfSummaryEventDetail {
    this.flushFrameWorkInternal(false);
    this.flushSequence += 1;
    this.lastFlushAtMs = atMs;
    const detail: DrawingPerfSummaryEventDetail = {
      reason,
      snapshot: this.snapshotAt(atMs),
    };
    if (this.reporter) {
      try {
        this.reporter(DRAWING_PERF_EVENT_NAME, detail);
      } catch {
        // Instrumentation must never break drawing input or rendering paths.
      }
    }
    return detail;
  }

  private rawCaptureSnapshot(drain: boolean): DrawingPerfRawCaptureSnapshot {
    if (!this.rawCaptures) return emptyRawCaptureSnapshot();
    const read = (capture: BoundedRawCapture): DrawingPerfRawMetricCapture => (
      drain ? capture.drain() : capture.read()
    );
    return {
      enabled: true,
      capacityPerMetric: this.rawCaptures.frameMs.capacity,
      metrics: {
        frameMs: read(this.rawCaptures.frameMs),
        inputMs: read(this.rawCaptures.inputMs),
        interactionMs: read(this.rawCaptures.interactionMs),
        longTaskMs: read(this.rawCaptures.longTaskMs),
        drawingMainThreadMs: read(this.rawCaptures.drawingMainThreadMs),
        hitQueryMs: read(this.rawCaptures.hitQueryMs),
        mouseupSyncMs: read(this.rawCaptures.mouseupSyncMs),
        persistenceMs: read(this.rawCaptures.persistenceMs),
        sceneProjectPaintMs: read(this.rawCaptures.sceneProjectPaintMs),
        activeOverlayCpuMs: read(this.rawCaptures.activeOverlayCpuMs),
      },
    };
  }

  private snapshotAt(capturedAtMs: number): DrawingPerfSnapshot {
    return {
      schemaVersion: 1,
      capturedAtMs,
      startedAtMs: this.startedAtMs,
      elapsedMs: Math.max(0, capturedAtMs - this.startedAtMs),
      lastFlushAtMs: this.lastFlushAtMs,
      flushSequence: this.flushSequence,
      histogramCapacity: this.histograms.frameMs.capacity,
      durations: {
        frameMs: this.histograms.frameMs.snapshot(),
        inputMs: this.histograms.inputMs.snapshot(),
        interactionMs: this.histograms.interactionMs.snapshot(),
        longTaskMs: this.histograms.longTaskMs.snapshot(),
        drawingMainThreadMs: this.histograms.drawingMainThreadMs.snapshot(),
        hitQueryMs: this.histograms.hitQueryMs.snapshot(),
        mouseupSyncMs: this.histograms.mouseupSyncMs.snapshot(),
        persistenceMs: this.histograms.persistenceMs.snapshot(),
        sceneProjectPaintMs: this.histograms.sceneProjectPaintMs.snapshot(),
        activeOverlayCpuMs: this.histograms.activeOverlayCpuMs.snapshot(),
      },
      counters: copyCounters(this.counters),
      counterMaxima: copyCounters(this.counterMaxima),
      gauges: copyGauges(this.gauges),
      gaugeMaxima: copyGauges(this.gaugeMaxima),
      longTasksByAttribution: Object.fromEntries(
        Array.from(this.longTaskAttributions, ([key, value]) => [key, { ...value }]),
      ),
    };
  }

  private readNow(): number {
    const observed = this.clock();
    if (!Number.isFinite(observed)) return this.lastKnownNow;
    this.lastKnownNow = Math.max(this.lastKnownNow, observed);
    return this.lastKnownNow;
  }
}

export function createDrawingPerfCounters(
  options: DrawingPerfCountersOptions = {},
): DrawingPerfCounters {
  return new DrawingPerfCountersImpl(options);
}

function getBrowserDebugGlobal(): DrawingPerfHostGlobal | null {
  if (typeof window === "undefined") return null;
  return window as unknown as DrawingPerfHostGlobal;
}

export function readDrawingPerfBootstrapConfig(
  globalRef: DrawingPerfHostGlobal | null = getBrowserDebugGlobal(),
): DrawingPerfBootstrapConfig {
  const configured = globalRef?.__CANDLESCOPE_DRAWING_PERF_CONFIG__;
  if (configured?.benchmarkRawCapture !== true) return { benchmarkRawCapture: false };
  const result: DrawingPerfBootstrapConfig = { benchmarkRawCapture: true };
  if (Number.isSafeInteger(configured.rawCaptureCapacity)
    && configured.rawCaptureCapacity !== undefined
    && configured.rawCaptureCapacity > 0) {
    result.rawCaptureCapacity = Math.min(configured.rawCaptureCapacity, MAX_RAW_CAPTURE_CAPACITY);
  }
  return result;
}

export const drawingPerfCounters = createDrawingPerfCounters(
  readDrawingPerfBootstrapConfig(),
);

let frameWorkFlushScheduled = false;

/**
 * Add work to the current drawing frame and commit one aggregate sample at the
 * next animation-frame boundary. All legacy primitives share this scheduler,
 * so a 64-primitive redraw is measured as one frame cost instead of 64 cheap
 * primitive samples.
 */
export function accumulateDrawingPerfFrameWork(
  contribution: DrawingPerfFrameWorkContribution,
): boolean {
  const accepted = drawingPerfCounters.accumulateFrameWork(contribution);
  if (!accepted || frameWorkFlushScheduled) return accepted;
  frameWorkFlushScheduled = true;
  const flush = () => {
    frameWorkFlushScheduled = false;
    drawingPerfCounters.flushFrameWork();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
  return true;
}

let runtimeSummaryProvider: DrawingPerfRuntimeSummaryProvider | null = null;
let shadowParityRequester: DrawingPerfShadowParityRequester | null = null;

export function registerDrawingPerfRuntimeSummaryProvider(
  provider: DrawingPerfRuntimeSummaryProvider | null,
): () => void {
  runtimeSummaryProvider = provider;
  return () => {
    if (runtimeSummaryProvider === provider) runtimeSummaryProvider = null;
  };
}

export function readDrawingPerfRuntimeSummary(): DrawingPerfRuntimeSummary | null {
  if (!runtimeSummaryProvider) return null;
  try {
    const summary = runtimeSummaryProvider();
    if (!summary
      || !Number.isSafeInteger(summary.entityCount)
      || summary.entityCount < 0
      || !Number.isSafeInteger(summary.pointCount)
      || summary.pointCount < 0
      || !summary.typeCounts
      || typeof summary.typeCounts !== "object") {
      return null;
    }
    const typeEntries: Array<readonly [string, number]> = [];
    let acceptedTypes = 0;
    for (const [rawType, count] of Object.entries(summary.typeCounts)) {
      if (acceptedTypes >= MAX_RUNTIME_SUMMARY_TYPES) break;
      if (!Number.isSafeInteger(count) || count < 0) return null;
      const type = rawType.trim().slice(0, 80);
      if (!type) continue;
      typeEntries.push([type, count]);
      acceptedTypes += 1;
    }
    return {
      entityCount: summary.entityCount,
      pointCount: summary.pointCount,
      typeCounts: Object.fromEntries(typeEntries),
    };
  } catch {
    return null;
  }
}

export function registerDrawingPerfShadowParityRequester(
  requester: DrawingPerfShadowParityRequester | null,
): () => void {
  shadowParityRequester = requester;
  return () => {
    if (shadowParityRequester === requester) shadowParityRequester = null;
  };
}

export function requestDrawingPerfShadowParity(): boolean {
  if (!shadowParityRequester) return false;
  try {
    return shadowParityRequester() === true;
  } catch {
    return false;
  }
}

export function getDrawingPerfCounters(): DrawingPerfCounters {
  return drawingPerfCounters;
}

export function resetDrawingPerfCounters(): void {
  drawingPerfCounters.reset();
}

export function flushDrawingPerfCounters(
  reason: DrawingPerfFlushReason = "manual",
): DrawingPerfSummaryEventDetail {
  return drawingPerfCounters.flush(reason);
}

export function installDrawingPerfDebugHandle(
  globalRef: DrawingPerfHostGlobal | null = getBrowserDebugGlobal(),
): DrawingPerfDebugHandle | null {
  if (!globalRef) return null;
  const handle: DrawingPerfDebugHandle = Object.freeze({
    report: () => drawingPerfCounters.snapshot(),
    snapshot: () => drawingPerfCounters.snapshot(),
    flush: (reason: DrawingPerfFlushReason = "manual") => drawingPerfCounters.flush(reason),
    readRawCapture: () => drawingPerfCounters.readRawCapture(),
    drainRawCapture: () => drawingPerfCounters.drainRawCapture(),
    registerRuntimeSummaryProvider: (provider: DrawingPerfRuntimeSummaryProvider | null) => (
      registerDrawingPerfRuntimeSummaryProvider(provider)
    ),
    readRuntimeSummary: () => readDrawingPerfRuntimeSummary(),
    requestShadowParity: () => requestDrawingPerfShadowParity(),
    reset: () => { drawingPerfCounters.reset(); },
  });
  globalRef.__CANDLESCOPE_DRAWING_PERF__ = handle;
  return handle;
}

installDrawingPerfDebugHandle();
