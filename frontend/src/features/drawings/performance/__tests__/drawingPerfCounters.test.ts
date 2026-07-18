import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_PERF_EVENT_NAME,
  createDrawingPerfCounters,
  installDrawingPerfDebugHandle,
  readDrawingPerfBootstrapConfig,
  readDrawingPerfInteractionHandoff,
  recordDrawingPerfInteractionHandoffAcknowledged,
  recordDrawingPerfInteractionHandoffPrepared,
  registerDrawingPerfActivePersistenceDocumentRecordProvider,
  registerDrawingPerfLegacyCompatibilitySnapshotProvider,
  registerDrawingPerfPhase6HitOracleProvider,
  registerDrawingPerfPhase6RuntimeProvider,
  registerDrawingPerfRuntimeSummaryProvider,
  registerDrawingPerfShadowParityRequester,
  type DrawingPerfDebugHandle,
  type DrawingPerfSummaryEventDetail,
} from "../drawingPerfCounters.js";
import {
  beginDrawingInteractionLifecycleFreehandGesture,
  markDrawingInteractionLifecycleBoundaryChange,
} from "../../interaction/drawingInteractionLifecycle.js";

test("rolling duration histograms retain only their bounded newest window", () => {
  let nowMs = 0;
  const counters = createDrawingPerfCounters({
    now: () => nowMs,
    reporter: null,
    histogramCapacity: 3,
  });

  assert.equal(counters.recordFrameDuration(10), true);
  assert.equal(counters.recordFrameDuration(20), true);
  assert.equal(counters.recordFrameDuration(30), true);
  assert.equal(counters.recordFrameDuration(40), true);
  assert.equal(counters.recordFrameDuration(-1), false);
  assert.equal(counters.recordFrameDuration(Number.NaN), false);

  nowMs = 100;
  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.durations.frameMs, {
    sampleCount: 3,
    totalCount: 4,
    capacity: 3,
    samples: [20, 30, 40],
    minMs: 20,
    maxMs: 40,
    meanMs: 30,
    p50Ms: 30,
    p95Ms: 40,
    p99Ms: 40,
  });
  assert.equal(snapshot.counters.frameCount, 4);
  assert.equal(snapshot.counterMaxima.frameCount, 4);
  assert.equal(snapshot.capturedAtMs, 100);
});

test("hot-path samples publish only on the five-second boundary or gesture end", () => {
  let nowMs = 0;
  const published: Array<{ name: string; detail: DrawingPerfSummaryEventDetail }> = [];
  const counters = createDrawingPerfCounters({
    now: () => nowMs,
    flushIntervalMs: 5_000,
    reporter: (name, detail) => { published.push({ name, detail }); },
  });

  for (let index = 0; index < 100; index += 1) {
    counters.recordFrameDuration(16 + (index % 2));
  }
  nowMs = 4_999;
  counters.recordInputDuration(2);
  assert.equal(published.length, 0);

  nowMs = 5_000;
  counters.recordInteractionDuration(3);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.name, DRAWING_PERF_EVENT_NAME);
  assert.equal(published[0]?.detail.reason, "interval");
  assert.equal(published[0]?.detail.snapshot.counters.frameCount, 100);

  counters.recordFrameDuration(17);
  assert.equal(published.length, 1);
  const gestureSummary = counters.gestureEnded();
  assert.equal(published.length, 2);
  assert.equal(gestureSummary.reason, "gesture-end");
  assert.equal(published[1]?.detail.snapshot.flushSequence, 2);
});

test("counters, gauges, and attributed long tasks reject invalid measurements", () => {
  const counters = createDrawingPerfCounters({
    now: () => 0,
    reporter: null,
    maxLongTaskAttributions: 2,
  });

  assert.equal(counters.recordAnchorResolve(12), true);
  assert.equal(counters.recordFinalProjection(7), true);
  assert.equal(counters.recordSceneRebuild(), true);
  assert.equal(counters.recordRequestUpdate(3), true);
  assert.equal(counters.recordAnchorResolve(0), false);
  assert.equal(counters.recordPersistenceAttempt(null), true);
  const quotaError = new Error("quota exceeded");
  quotaError.name = "QuotaExceededError";
  assert.equal(counters.recordPersistenceAttempt(quotaError), true);
  assert.equal(counters.recordPersistenceAttempt(new Error("blocked")), true);

  assert.equal(counters.setGauge("rawPoints", 4_096), true);
  assert.equal(counters.setGauge("renderedPoints", 512), true);
  assert.equal(counters.setGauge("visibleEntities", 64), true);
  assert.equal(counters.setGauge("culledEntities", 136), true);
  assert.equal(counters.setGauge("lodRatio", 0.125), true);
  assert.equal(counters.recordWorkerQueue(2), true);
  assert.equal(counters.setGauge("lodRatio", 1.1), false);
  assert.equal(counters.recordWorkerQueue(-1), false);

  assert.equal(counters.recordLongTask(49.9, "render"), false);
  assert.equal(counters.recordLongTask(50, "render"), false);
  assert.equal(counters.recordLongTask(55, "render"), true);
  assert.equal(counters.recordLongTask(60, "input"), true);
  assert.equal(counters.recordLongTask(70, "worker"), true);

  const snapshot = counters.snapshot();
  assert.equal(snapshot.counters.anchorResolveCount, 12);
  assert.equal(snapshot.counters.finalProjectionCount, 7);
  assert.equal(snapshot.counters.sceneRebuildCount, 1);
  assert.equal(snapshot.counters.requestUpdateCount, 3);
  assert.equal(snapshot.counters.persistenceAttemptCount, 3);
  assert.equal(snapshot.counters.persistenceFailureCount, 2);
  assert.equal(snapshot.counters.persistenceQuotaFailureCount, 1);
  assert.equal(snapshot.counters.persistenceOtherFailureCount, 1);
  assert.equal(snapshot.counters.longTaskCount, 3);
  assert.equal(snapshot.durations.longTaskMs.minMs, 55);
  assert.equal(snapshot.durations.longTaskMs.maxMs, 70);
  assert.deepEqual(snapshot.gauges, {
    rawPoints: 4_096,
    renderedPoints: 512,
    visibleEntities: 64,
    culledEntities: 136,
    lodRatio: 0.125,
    workerQueue: 2,
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
  });
  assert.equal(snapshot.gaugeMaxima.workerQueue, 2);
  assert.equal(snapshot.gaugeMaxima.rawPoints, 4_096);
  assert.equal(Object.keys(snapshot.longTasksByAttribution).length, 2);
  assert.deepEqual(snapshot.longTasksByAttribution.render, { count: 1, totalDurationMs: 55 });
  assert.deepEqual(snapshot.longTasksByAttribution.other, { count: 2, totalDurationMs: 130 });
});

test("Phase 6 exact and worker telemetry is retained in histograms, raw capture, counters, and gauges", () => {
  const counters = createDrawingPerfCounters({
    now: () => 0,
    reporter: null,
    benchmarkRawCapture: true,
    rawCaptureCapacity: 4,
  });

  assert.equal(counters.recordDuration("workerFinalizeMs", 8.5), true);
  assert.equal(counters.recordDuration("exactRenderMs", 104), true);
  assert.equal(counters.recordDuration("exactRenderMs", Number.NaN), false);
  assert.equal(counters.incrementCounter("workerJobCount", 3), true);
  assert.equal(counters.incrementCounter("workerResultCount", 2), true);
  assert.equal(counters.incrementCounter("staleWorkerResultCount"), true);
  assert.equal(counters.incrementCounter("staleWorkerPublishCount", 2), true);
  assert.equal(counters.incrementCounter("sceneRuntimeFaultCount", 2), true);
  assert.equal(counters.incrementCounter("legacyFallbackSucceededCount"), true);
  assert.equal(counters.incrementCounter("workerQueueDropCount"), true);
  assert.equal(counters.setGauge("workerQueue", 2), true);
  assert.equal(counters.setGauge("workerInFlight", 1), true);
  assert.equal(counters.setGauge("cacheBytes", 65_536), true);

  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.durations.workerFinalizeMs.samples, [8.5]);
  assert.deepEqual(snapshot.durations.exactRenderMs.samples, [104]);
  assert.equal(snapshot.counters.workerJobCount, 3);
  assert.equal(snapshot.counters.workerResultCount, 2);
  assert.equal(snapshot.counters.staleWorkerResultCount, 1);
  assert.equal(snapshot.counters.staleWorkerPublishCount, 2);
  assert.equal(snapshot.counters.sceneRuntimeFaultCount, 2);
  assert.equal(snapshot.counters.legacyFallbackSucceededCount, 1);
  assert.equal(snapshot.counters.workerQueueDropCount, 1);
  assert.equal(snapshot.gauges.workerQueue, 2);
  assert.equal(snapshot.gauges.workerInFlight, 1);
  assert.equal(snapshot.gauges.cacheBytes, 65_536);
  assert.deepEqual(counters.readRawCapture().metrics.workerFinalizeMs.samples, [8.5]);
  assert.deepEqual(counters.readRawCapture().metrics.exactRenderMs.samples, [104]);

  counters.reset();
  const reset = counters.snapshot();
  assert.equal(reset.durations.workerFinalizeMs.sampleCount, 0);
  assert.equal(reset.durations.exactRenderMs.sampleCount, 0);
  assert.equal(reset.counters.staleWorkerPublishCount, 0);
  assert.equal(reset.counters.sceneRuntimeFaultCount, 0);
  assert.equal(reset.counters.legacyFallbackSucceededCount, 0);
  assert.equal(reset.gauges.workerQueue, 0);
  assert.equal(reset.gauges.cacheBytes, 0);
});

test("shadow parity summaries use fixed-size counters and latest-value gauges", () => {
  const counters = createDrawingPerfCounters({ now: () => 0, reporter: null });
  assert.equal(counters.incrementCounter("shadowCompareCount"), true);
  assert.equal(counters.incrementCounter("shadowParityMismatchCount", 2), true);
  assert.equal(counters.incrementCounter("shadowSkippedCount", 3), true);
  assert.equal(counters.incrementCounter("shadowErrorCount", 4), true);
  assert.equal(counters.setGauge("shadowComparedEntities", 512), true);
  assert.equal(counters.setGauge("shadowComparedHits", 32), true);
  assert.equal(counters.setGauge("shadowGapProjectionMs", 4.5), true);
  assert.equal(counters.setGauge("shadowLegacyProbeMs", 5.5), true);
  assert.equal(counters.setGauge("shadowMismatchItems", 7), true);
  assert.equal(counters.setGauge("shadowParityCompareMs", 2.5), true);
  assert.equal(counters.setGauge("shadowParityMs", 12.5), true);

  let snapshot = counters.snapshot();
  assert.equal(snapshot.counters.shadowCompareCount, 1);
  assert.equal(snapshot.counters.shadowParityMismatchCount, 2);
  assert.equal(snapshot.counters.shadowSkippedCount, 3);
  assert.equal(snapshot.counters.shadowErrorCount, 4);
  assert.equal(snapshot.gauges.shadowComparedEntities, 512);
  assert.equal(snapshot.gauges.shadowComparedHits, 32);
  assert.equal(snapshot.gauges.shadowGapProjectionMs, 4.5);
  assert.equal(snapshot.gauges.shadowLegacyProbeMs, 5.5);
  assert.equal(snapshot.gauges.shadowMismatchItems, 7);
  assert.equal(snapshot.gauges.shadowParityCompareMs, 2.5);
  assert.equal(snapshot.gauges.shadowParityMs, 12.5);

  assert.equal(counters.incrementCounter("shadowCompareCount", Number.MAX_SAFE_INTEGER), true);
  assert.equal(counters.incrementCounter("shadowCompareCount"), true);
  assert.equal(counters.setGauge("shadowMismatchItems", 1), true);
  snapshot = counters.snapshot();
  assert.equal(snapshot.counters.shadowCompareCount, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.gauges.shadowMismatchItems, 1);
  assert.equal(snapshot.gaugeMaxima.shadowMismatchItems, 7);

  counters.reset();
  snapshot = counters.snapshot();
  assert.equal(snapshot.counters.shadowCompareCount, 0);
  assert.equal(snapshot.gauges.shadowComparedEntities, 0);
  assert.equal(snapshot.gauges.shadowComparedHits, 0);
  assert.equal(snapshot.gauges.shadowMismatchItems, 0);
});

test("reset clears all rolling state and restarts the controlled clock window", () => {
  let nowMs = 10;
  const counters = createDrawingPerfCounters({ now: () => nowMs, reporter: null });
  counters.recordFrameDuration(16);
  counters.setGauge("rawPoints", 100);
  counters.flush("manual");

  nowMs = 250;
  counters.reset();
  const snapshot = counters.snapshot();
  assert.equal(snapshot.startedAtMs, 250);
  assert.equal(snapshot.elapsedMs, 0);
  assert.equal(snapshot.flushSequence, 0);
  assert.equal(snapshot.durations.frameMs.sampleCount, 0);
  assert.equal(snapshot.durations.frameMs.totalCount, 0);
  assert.equal(snapshot.counters.frameCount, 0);
  assert.equal(snapshot.gauges.rawPoints, 0);
});

test("benchmark raw capture is opt-in, bounded, and drains without overlap", () => {
  const productionCounters = createDrawingPerfCounters({ now: () => 0, reporter: null });
  productionCounters.recordDrawingMainThreadDuration(1);
  assert.equal(productionCounters.readRawCapture().enabled, false);
  assert.deepEqual(
    productionCounters.readRawCapture().metrics.drawingMainThreadMs.samples,
    [],
  );

  const counters = createDrawingPerfCounters({
    now: () => 0,
    reporter: null,
    benchmarkRawCapture: true,
    rawCaptureCapacity: 3,
  });
  for (const durationMs of [1, 2, 3, 4, 5]) {
    counters.recordDrawingMainThreadDuration(durationMs);
  }

  const firstRead = counters.readRawCapture();
  assert.equal(firstRead.enabled, true);
  assert.equal(firstRead.capacityPerMetric, 3);
  assert.deepEqual(firstRead.metrics.drawingMainThreadMs, {
    samples: [3, 4, 5],
    observedCount: 5,
    droppedCount: 2,
    capacity: 3,
  });
  assert.deepEqual(
    counters.readRawCapture().metrics.drawingMainThreadMs.samples,
    [3, 4, 5],
  );

  const drained = counters.drainRawCapture();
  assert.deepEqual(drained.metrics.drawingMainThreadMs.samples, [3, 4, 5]);
  assert.deepEqual(counters.drainRawCapture().metrics.drawingMainThreadMs, {
    samples: [],
    observedCount: 0,
    droppedCount: 0,
    capacity: 3,
  });
  counters.recordDrawingMainThreadDuration(6);
  assert.deepEqual(counters.drainRawCapture().metrics.drawingMainThreadMs.samples, [6]);

  const summary = counters.flush("benchmark-test");
  assert.equal("rawCapture" in summary.snapshot, false);
});

test("frame work aggregates primitive durations and geometry into one frame sample", () => {
  const counters = createDrawingPerfCounters({
    now: () => 0,
    reporter: null,
    benchmarkRawCapture: true,
    rawCaptureCapacity: 10,
  });

  assert.equal(counters.accumulateFrameWork({
    drawingMainThreadMs: 1,
    sceneProjectPaintMs: 0.5,
    activeOverlayCpuMs: 0.25,
    rawPoints: 100,
    renderedPoints: 20,
    visibleEntities: 1,
  }), true);
  assert.equal(counters.accumulateFrameWork({
    drawingMainThreadMs: 2,
    sceneProjectPaintMs: 1.25,
    activeOverlayCpuMs: 0.5,
    rawPoints: 200,
    renderedPoints: 40,
    culledEntities: 1,
  }), true);
  assert.equal(counters.accumulateFrameWork({ drawingMainThreadMs: -1 }), false);
  assert.equal(counters.snapshot().durations.drawingMainThreadMs.sampleCount, 0);
  assert.equal(counters.snapshot().gauges.rawPoints, 0);

  const frame = counters.flushFrameWork();
  assert.deepEqual(frame, {
    contributionCount: 2,
    drawingMainThreadMs: 3,
    sceneProjectPaintMs: 1.75,
    activeOverlayCpuMs: 0.75,
    rawPoints: 300,
    renderedPoints: 60,
    visibleEntities: 1,
    culledEntities: 1,
  });
  assert.equal(counters.flushFrameWork(), null);

  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.durations.drawingMainThreadMs.samples, [3]);
  assert.deepEqual(snapshot.durations.sceneProjectPaintMs.samples, [1.75]);
  assert.deepEqual(snapshot.durations.activeOverlayCpuMs.samples, [0.75]);
  assert.equal(snapshot.gauges.rawPoints, 300);
  assert.equal(snapshot.gauges.renderedPoints, 60);
  assert.equal(snapshot.gauges.visibleEntities, 1);
  assert.equal(snapshot.gauges.culledEntities, 1);
  assert.equal(snapshot.gauges.lodRatio, 0.2);
  assert.deepEqual(
    counters.readRawCapture().metrics.drawingMainThreadMs.samples,
    [3],
  );
});

test("active overlay CPU can be the only contribution and is sampled once per frame", () => {
  const counters = createDrawingPerfCounters({
    now: () => 0,
    reporter: null,
    benchmarkRawCapture: true,
  });
  assert.equal(counters.accumulateFrameWork({ activeOverlayCpuMs: 0.4 }), true);
  assert.equal(counters.accumulateFrameWork({ activeOverlayCpuMs: 0.6 }), true);
  const frame = counters.flushFrameWork();
  assert.equal(frame?.activeOverlayCpuMs, 1);
  assert.deepEqual(counters.readRawCapture().metrics.activeOverlayCpuMs.samples, [1]);
});

test("frame geometry uses the last contribution per primitive instead of double counting redraws", () => {
  const counters = createDrawingPerfCounters({ now: () => 0, reporter: null });
  counters.accumulateFrameWork({
    geometryKey: "stroke-a",
    rawPoints: 512,
    renderedPoints: 500,
    visibleEntities: 1,
    culledEntities: 0,
  });
  counters.accumulateFrameWork({
    geometryKey: "stroke-a",
    rawPoints: 512,
    renderedPoints: 480,
    visibleEntities: 1,
    culledEntities: 0,
  });
  counters.accumulateFrameWork({
    geometryKey: "stroke-b",
    rawPoints: 512,
    renderedPoints: 510,
    visibleEntities: 1,
    culledEntities: 0,
  });

  const result = counters.flushFrameWork();
  assert.equal(result?.rawPoints, 1_024);
  assert.equal(result?.renderedPoints, 990);
  assert.equal(result?.visibleEntities, 2);
});

test("summary flush commits pending frame work and reset discards all pending capture state", () => {
  const published: DrawingPerfSummaryEventDetail[] = [];
  const counters = createDrawingPerfCounters({
    now: () => 0,
    reporter: (_name, detail) => { published.push(detail); },
    benchmarkRawCapture: true,
    rawCaptureCapacity: 10,
  });

  counters.accumulateFrameWork({ drawingMainThreadMs: 4, sceneProjectPaintMs: 2 });
  const summary = counters.flush("scenario-end");
  assert.deepEqual(summary.snapshot.durations.drawingMainThreadMs.samples, [4]);
  assert.equal(published.length, 1);

  counters.accumulateFrameWork({ drawingMainThreadMs: 9, rawPoints: 90 });
  counters.recordHitQueryDuration(3);
  counters.reset();
  assert.equal(counters.flushFrameWork(), null);
  assert.deepEqual(counters.readRawCapture().metrics.drawingMainThreadMs.samples, []);
  assert.equal(counters.readRawCapture().metrics.hitQueryMs.observedCount, 0);
  assert.equal(counters.snapshot().gauges.rawPoints, 0);
});

test("the five-second summary boundary cannot split one pending primitive frame", () => {
  let nowMs = 0;
  const published: DrawingPerfSummaryEventDetail[] = [];
  const counters = createDrawingPerfCounters({
    now: () => nowMs,
    flushIntervalMs: 5_000,
    reporter: (_name, detail) => { published.push(detail); },
  });

  counters.accumulateFrameWork({
    geometryKey: "line-a",
    drawingMainThreadMs: 1,
    rawPoints: 2,
    renderedPoints: 2,
    visibleEntities: 1,
  });
  nowMs = 5_000;
  counters.recordSceneRebuild();
  assert.equal(published.length, 0);

  counters.accumulateFrameWork({
    geometryKey: "line-b",
    drawingMainThreadMs: 2,
    rawPoints: 2,
    renderedPoints: 2,
    visibleEntities: 1,
  });
  const frame = counters.flushFrameWork();

  assert.equal(frame?.drawingMainThreadMs, 3);
  assert.equal(frame?.rawPoints, 4);
  assert.equal(frame?.visibleEntities, 2);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.reason, "interval");
  assert.deepEqual(
    published[0]?.snapshot.durations.drawingMainThreadMs.samples,
    [3],
  );
});

test("page bootstrap config enables benchmark capture only when explicitly requested", () => {
  assert.deepEqual(readDrawingPerfBootstrapConfig(null), { benchmarkRawCapture: false });
  assert.deepEqual(readDrawingPerfBootstrapConfig({
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {
      benchmarkRawCapture: true,
      rawCaptureCapacity: 12_345,
    },
  }), {
    benchmarkRawCapture: true,
    rawCaptureCapacity: 12_345,
  });
  assert.deepEqual(readDrawingPerfBootstrapConfig({
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: { rawCaptureCapacity: 50_000 },
  }), { benchmarkRawCapture: false });
});

test("reporter failures stay isolated from drawing paths", () => {
  const counters = createDrawingPerfCounters({
    now: () => 5_000,
    flushIntervalMs: 5_000,
    reporter: () => { throw new Error("telemetry unavailable"); },
  });

  assert.doesNotThrow(() => counters.recordFrameDuration(16));
  assert.doesNotThrow(() => counters.gestureEnded());
  assert.equal(counters.snapshot().counters.frameCount, 1);
});

test("debug handle can be installed explicitly and stays SSR-safe", () => {
  const globalRef: { __CANDLESCOPE_DRAWING_PERF__?: DrawingPerfDebugHandle } = {};
  const handle = installDrawingPerfDebugHandle(globalRef);
  assert.equal(handle, globalRef.__CANDLESCOPE_DRAWING_PERF__);
  assert.ok(Object.isFrozen(handle));
  assert.equal(handle?.report().schemaVersion, 1);
  assert.equal(handle?.readRawCapture().enabled, false);
  assert.deepEqual(handle?.readExportLifecycle(), {
    schemaVersion: 1,
    transactionCount: 0,
    transactions: [],
  });
  const unregister = handle?.registerRuntimeSummaryProvider(() => ({
    entityCount: 3,
    pointCount: 512,
    typeCounts: { freehand: 2, trendLine: 1 },
    attachedPrimitiveCount: 2,
    effectiveEngineMode: "scene-canary",
    scenePublicationReady: true,
    mainPanePlotRect: { x: 8, y: 4, width: 900, height: 540, dpr: 1.5 },
  }));
  assert.deepEqual(handle?.readRuntimeSummary(), {
    entityCount: 3,
    pointCount: 512,
    typeCounts: { freehand: 2, trendLine: 1 },
    attachedPrimitiveCount: 2,
    effectiveEngineMode: "scene-canary",
    scenePublicationReady: true,
    mainPanePlotRect: { x: 8, y: 4, width: 900, height: 540, dpr: 1.5 },
  });
  unregister?.();
  assert.equal(handle?.readRuntimeSummary(), null);
  const unregisterThrowing = handle?.registerRuntimeSummaryProvider(() => {
    throw new Error("surface disposed");
  });
  assert.equal(handle?.readRuntimeSummary(), null);
  unregisterThrowing?.();
  const unregisterInvalidSurface = handle?.registerRuntimeSummaryProvider(() => ({
    entityCount: 0,
    pointCount: 0,
    typeCounts: {},
    mainPanePlotRect: { x: 0, y: 0, width: 0, height: 10, dpr: 1.5 },
  }));
  assert.equal(handle?.readRuntimeSummary(), null);
  unregisterInvalidSurface?.();
  assert.equal(handle?.requestShadowParity(), false);
  const activeGesture = beginDrawingInteractionLifecycleFreehandGesture();
  assert.deepEqual(handle?.readInteractionLifecycle(), {
    active: activeGesture,
    lastCompleted: null,
  });
  markDrawingInteractionLifecycleBoundaryChange({
    kind: "interval",
    beforeValue: "1m",
    afterValue: "5m",
  });
  const unregisterParity = registerDrawingPerfShadowParityRequester(() => true);
  assert.equal(handle?.requestShadowParity(), true);
  unregisterParity();
  assert.equal(handle?.requestShadowParity(), false);
  const unregisterThrowingParity = registerDrawingPerfShadowParityRequester(() => {
    throw new Error("scene unavailable");
  });
  assert.equal(handle?.requestShadowParity(), false);
  unregisterThrowingParity();
  assert.doesNotThrow(() => handle?.reset());
  assert.deepEqual(handle?.readExportLifecycle(), {
    schemaVersion: 1,
    transactionCount: 0,
    transactions: [],
  });
  assert.deepEqual(handle?.readInteractionLifecycle(), {
    active: null,
    lastCompleted: null,
  });
  assert.equal(installDrawingPerfDebugHandle(null), null);
});

test("higher-priority pane diagnostics own the global handle and release to a fallback", () => {
  const handle = installDrawingPerfDebugHandle({});
  const summary = (entityCount: number) => ({
    entityCount,
    pointCount: entityCount * 2,
    typeCounts: { line: entityCount },
  });
  const unregisterSubPane = registerDrawingPerfRuntimeSummaryProvider(
    () => summary(1),
    { priority: 0 },
  );
  const unregisterMainPane = registerDrawingPerfRuntimeSummaryProvider(
    () => summary(2),
    { priority: 100 },
  );
  const unregisterLaterSubPane = registerDrawingPerfRuntimeSummaryProvider(
    () => summary(3),
    { priority: 0 },
  );

  assert.equal(handle?.readRuntimeSummary()?.entityCount, 2);
  unregisterMainPane();
  assert.equal(handle?.readRuntimeSummary()?.entityCount, 3);
  unregisterLaterSubPane();
  assert.equal(handle?.readRuntimeSummary()?.entityCount, 1);
  unregisterSubPane();
  assert.equal(handle?.readRuntimeSummary(), null);
});

test("debug handle exposes registered Phase 6 runtime and indexed-hit oracle providers", () => {
  const handle = installDrawingPerfDebugHandle({});
  const workerIdentity = Object.freeze({
    schemaVersion: 1,
    jobId: 4,
    generation: 4,
    stamp: Object.freeze({ viewportRevision: 8 }),
  });
  const phase6Runtime = Object.freeze({
    engineMode: "scene-canary" as const,
    scenePublicationReady: true,
    attachedPrimitiveCount: 1,
    backend: "worker" as const,
    backendSource: "environment" as const,
    workerResultDelayMs: 32,
    workerAvailability: "available" as const,
    workerUnavailableReason: null,
    sourceLineageExactResolveCount: 64,
    sourceLineageFallbackResolveCount: 0,
    sourceLineageUnresolvedResolveCount: 0,
    offscreenSupported: true,
    queueDepthMax: 2,
    inFlightMax: 1,
    queueDepthCurrent: 1,
    inFlightCurrent: 1,
    workerJobDelta: 4,
    workerResultDelta: 3,
    pendingDropDelta: 1,
    staleResultDropDelta: 1,
    stalePublishCount: 0,
    sceneFallbackCount: 0,
    sceneRuntimeFaultCount: 0,
    legacyFallbackSucceededCount: 0,
    sceneFallbackLastReason: null,
    persistence: Object.freeze({
      scopeKey: "binance:spot:BTCUSDT__main",
      phase: "error" as const,
      queueDepth: 1,
      inFlightRevision: null,
      pendingRevision: 8,
      dirtyRevision: 8,
      lastPersistedRevision: 7,
      lastError: "quota exceeded",
      lastErrorName: "QuotaExceededError",
      legacySnapshotRevision: 7,
      legacySnapshotError: null,
    }),
    persistenceRestoreSource: "v2" as const,
    persistenceAttemptCount: 2,
    persistenceFailureCount: 1,
    persistenceQuotaFailureCount: 1,
    persistenceOtherFailureCount: 0,
    rawPoints: 32_768,
    renderedPoints: 1_024,
    lodRatio: 0.03125,
    canonicalRawPreserved: true,
    vertexBudgetPassed: true,
    cacheBytes: 262_144,
    cacheBytesMax: 524_288,
    cacheBudgetBytes: 64 * 1024 * 1024,
    cacheHardLimitBytes: 96 * 1024 * 1024,
    cacheEntryCount: 8,
    cacheBudgetEvictionCount: 0,
    cacheEntryBytes: 240_000,
    cacheEntryBudgetBytes: 63 * 1024 * 1024,
    cacheMetadataBytes: 22_144,
    cacheMetadataBudgetBytes: 1024 * 1024,
    cacheRecentHierarchyKeyCount: 24,
    cacheRecentHierarchyKeysPerRequestLimit: 3,
    cacheRecentRequestCount: 8,
    cacheRecentRequestLimit: 512,
    exactRenderMs: 96,
    lastRequestedStamp: Object.freeze({ viewportRevision: 8 }),
    lastPublishedStamp: Object.freeze({ viewportRevision: 8 }),
    lastPaintedStamp: Object.freeze({ viewportRevision: 8 }),
    paintReceipt: Object.freeze({
      kind: "drawing-scene-bridge-paint-ack" as const,
      observedAt: "2026-07-16T08:00:00.000Z",
      stamp: Object.freeze({ viewportRevision: 8 }),
      attachmentRevision: 1,
      paintSequence: 2,
    }),
    submittedWorkerHeaders: Object.freeze([workerIdentity]),
    returnedWorkerIdentity: null,
    acceptedWorkerIdentity: workerIdentity,
    publishedWorkerIdentity: workerIdentity,
    latestSubmittedWorkerIdentity: workerIdentity,
  });
  const unregisterRuntime = registerDrawingPerfPhase6RuntimeProvider(() => phase6Runtime);
  assert.strictEqual(handle?.readPhase6Runtime(), phase6Runtime);
  assert.equal(handle?.readPhase6Runtime()?.sceneRuntimeFaultCount, 0);
  assert.equal(handle?.readPhase6Runtime()?.persistence?.pendingRevision, 8);
  assert.equal(handle?.readPhase6Runtime()?.persistenceRestoreSource, "v2");
  assert.equal(handle?.readPhase6Runtime()?.persistenceQuotaFailureCount, 1);
  assert.equal(handle?.readPhase6Runtime()?.cacheMetadataBudgetBytes, 1024 * 1024);
  assert.strictEqual(handle?.readPhase6Runtime()?.paintReceipt, phase6Runtime.paintReceipt);
  assert.strictEqual(
    handle?.readPhase6Runtime()?.latestSubmittedWorkerIdentity,
    workerIdentity,
  );
  unregisterRuntime();
  assert.equal(handle?.readPhase6Runtime(), null);

  const activeDocumentRecord = Object.freeze({
    documentSchemaVersion: 1,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 8,
    updatedAt: 0,
    entities: Object.freeze([{ id: "pending-line" }]),
  });
  const unregisterActiveDocument = registerDrawingPerfActivePersistenceDocumentRecordProvider(
    () => activeDocumentRecord,
  );
  assert.strictEqual(handle?.readActivePersistenceDocumentRecord(), activeDocumentRecord);
  unregisterActiveDocument();
  assert.equal(handle?.readActivePersistenceDocumentRecord(), null);

  const unregisterThrowingActiveDocument =
    registerDrawingPerfActivePersistenceDocumentRecordProvider(() => {
      throw new Error("active persistence document unavailable");
    });
  assert.equal(handle?.readActivePersistenceDocumentRecord(), null);
  unregisterThrowingActiveDocument();

  const legacyCompatibilitySnapshot = Object.freeze({
    scopeKey: activeDocumentRecord.scopeKey,
    raw: '[{"type":"line","id":"pending-line"}]',
    normalizedRaw: '[{"type":"line","id":"pending-line"}]',
    record: activeDocumentRecord,
  });
  const unregisterLegacyCompatibility =
    registerDrawingPerfLegacyCompatibilitySnapshotProvider(
      () => legacyCompatibilitySnapshot,
    );
  assert.strictEqual(
    handle?.readActiveLegacyCompatibilitySnapshot(),
    legacyCompatibilitySnapshot,
  );
  unregisterLegacyCompatibility();
  assert.equal(handle?.readActiveLegacyCompatibilitySnapshot(), null);

  const unregisterThrowingLegacyCompatibility =
    registerDrawingPerfLegacyCompatibilitySnapshotProvider(() => {
      throw new Error("legacy compatibility snapshot unavailable");
    });
  assert.equal(handle?.readActiveLegacyCompatibilitySnapshot(), null);
  unregisterThrowingLegacyCompatibility();

  const unregisterThrowingRuntime = registerDrawingPerfPhase6RuntimeProvider(() => {
    throw new Error("surface disposed");
  });
  assert.equal(handle?.readPhase6Runtime(), null);
  unregisterThrowingRuntime();

  const oracleResult = Object.freeze({
    queryCount: 2,
    mismatchCount: 0,
    maxCandidates: 3,
    totalSegments: 1_000,
    indexedResults: Object.freeze([null, { entityId: "top" }]),
    oracleResults: Object.freeze([null, { entityId: "top" }]),
  });
  const unregisterOracle = registerDrawingPerfPhase6HitOracleProvider((points) => {
    assert.deepEqual(points, [{ x: 10, y: 20 }, { x: 30, y: 40 }]);
    return oracleResult;
  });
  assert.strictEqual(handle?.runPhase6HitOracle([
    { x: 10, y: 20 },
    { x: 30, y: 40 },
  ]), oracleResult);
  unregisterOracle();
  assert.deepEqual(handle?.runPhase6HitOracle([{ x: 1, y: 2 }]), {
    queryCount: 0,
    mismatchCount: 0,
    maxCandidates: 0,
    totalSegments: 0,
  });
});

test("interaction handoff telemetry accepts covering paints across viewport revisions", () => {
  const handle = installDrawingPerfDebugHandle({});
  handle?.reset();
  const stamp = {
    scopeKey: "BTCUSDT",
    documentRevision: 7,
    surfaceGeneration: 3,
    viewportRevision: 11,
  } as const;
  const prepared = recordDrawingPerfInteractionHandoffPrepared("live-ink", stamp);
  assert.equal(prepared?.sequence, 1);
  assert.deepEqual(readDrawingPerfInteractionHandoff(), {
    prepared,
    acknowledged: null,
  });
  assert.equal(recordDrawingPerfInteractionHandoffAcknowledged("dynamic", stamp), false);
  assert.equal(recordDrawingPerfInteractionHandoffAcknowledged("live-ink", {
    ...stamp,
    documentRevision: 6,
    viewportRevision: 12,
  }), false);
  assert.equal(recordDrawingPerfInteractionHandoffAcknowledged("live-ink", {
    ...stamp,
    scopeKey: "ETHUSDT",
    documentRevision: 8,
    viewportRevision: 12,
  }), false);
  assert.equal(recordDrawingPerfInteractionHandoffAcknowledged("live-ink", {
    ...stamp,
    documentRevision: 8,
    surfaceGeneration: 4,
    viewportRevision: 12,
  }), false);
  assert.equal(recordDrawingPerfInteractionHandoffAcknowledged("live-ink", {
    ...stamp,
    documentRevision: 8,
    viewportRevision: 12,
  }), true);
  assert.deepEqual(readDrawingPerfInteractionHandoff(), {
    prepared,
    acknowledged: prepared,
  });
  handle?.reset();
  assert.deepEqual(readDrawingPerfInteractionHandoff(), {
    prepared: null,
    acknowledged: null,
  });
});
