import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_PERF_EVENT_NAME,
  createDrawingPerfCounters,
  installDrawingPerfDebugHandle,
  readDrawingPerfBootstrapConfig,
  registerDrawingPerfShadowParityRequester,
  type DrawingPerfDebugHandle,
  type DrawingPerfSummaryEventDetail,
} from "../drawingPerfCounters.js";

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
    rawPoints: 100,
    renderedPoints: 20,
    visibleEntities: 1,
  }), true);
  assert.equal(counters.accumulateFrameWork({
    drawingMainThreadMs: 2,
    sceneProjectPaintMs: 1.25,
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
    rawPoints: 300,
    renderedPoints: 60,
    visibleEntities: 1,
    culledEntities: 1,
  });
  assert.equal(counters.flushFrameWork(), null);

  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.durations.drawingMainThreadMs.samples, [3]);
  assert.deepEqual(snapshot.durations.sceneProjectPaintMs.samples, [1.75]);
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
  const unregister = handle?.registerRuntimeSummaryProvider(() => ({
    entityCount: 3,
    pointCount: 512,
    typeCounts: { freehand: 2, trendLine: 1 },
  }));
  assert.deepEqual(handle?.readRuntimeSummary(), {
    entityCount: 3,
    pointCount: 512,
    typeCounts: { freehand: 2, trendLine: 1 },
  });
  unregister?.();
  assert.equal(handle?.readRuntimeSummary(), null);
  const unregisterThrowing = handle?.registerRuntimeSummaryProvider(() => {
    throw new Error("surface disposed");
  });
  assert.equal(handle?.readRuntimeSummary(), null);
  unregisterThrowing?.();
  assert.equal(handle?.requestShadowParity(), false);
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
  assert.equal(installDrawingPerfDebugHandle(null), null);
});
