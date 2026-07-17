import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE6_BAR_COUNT,
  PHASE6_BUDGETS,
  PHASE6_HIT_QUERY_COUNT,
  PHASE6_LINEAGE_VIEWPORT_SCENARIO,
  PHASE6_POINTER_SAMPLE_COUNT,
  PHASE6_REQUIRED_SCENARIO_IDS,
  PHASE6_SCENARIO_IDS,
  buildPhase6HitQueryPoints,
  buildPhase6Acceptance,
  normalizePhase6PanePlotRect,
} from "./drawing-performance-phase6.mjs";
import { PHASE6_LINEAGE_REPRESENTATION } from "./drawing-performance-phase6-lineage.mjs";

const stamp = Object.freeze({
  scopeKey: "BINANCE:BTCUSDT",
  documentRevision: 7,
  surfaceGeneration: 2,
  dataRevision: 3,
  projectionRevision: 4,
  lineageIndexRevision: 5,
  viewportRevision: 6,
  themeRevision: 1,
  widthCssPx: 1200,
  heightCssPx: 700,
  dpr: 1,
});

function phase5Probe() {
  return {
    handoffs: [{
      kind: "live-ink",
      exactTicketObserved: true,
      exactAckBeforeClear: true,
      blankFrameCount: 0,
    }],
  };
}

function actionFor(id) {
  const currentPaint = {
    currentPaintWaitPassed: true,
    currentPaintPreviousStamp: { ...stamp, viewportRevision: stamp.viewportRevision - 1 },
    currentPaintRequestedStamp: stamp,
    currentPaintedStamp: stamp,
  };
  if (id === PHASE6_SCENARIO_IDS.freehandZoomPan
    || id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan) {
    return { wheelEventsDispatched: 60, panEventsDispatched: 36, ...currentPaint };
  }
  if (id === PHASE6_SCENARIO_IDS.hitIndex) {
    return {
      hitQueriesRequested: PHASE6_HIT_QUERY_COUNT,
      hitQueryCoordinateSpace: "pane-local",
      hitQueryPlotRect: { x: 0, y: 0, width: 1_200, height: 700, dpr: 1 },
      hitOracleQueryCount: PHASE6_HIT_QUERY_COUNT,
      hitOracleMismatchCount: 0,
      hitOraclePositiveHitCount: 48,
      hitOracleCandidateCoverageCount: 1,
      hitOracleMaxCandidates: 8,
      hitQueryPaintWaitPassed: true,
      hitQueryPreviousStamp: { ...stamp, viewportRevision: stamp.viewportRevision - 1 },
      hitQueryRequestedStamp: stamp,
      hitQueryPaintedStamp: stamp,
      hitQueryQueriedStamp: stamp,
      hitQueryOraclePaintedStamp: stamp,
      hitQueryCurrentPainted: true,
      hitOracleOutsideMeasurementWindow: true,
    };
  }
  if (id === PHASE6_SCENARIO_IDS.activeFinalize) {
    return {
      heavyPointerSamplesDispatched: PHASE6_POINTER_SAMPLE_COUNT,
      committedPointerSamplesDispatched: PHASE6_POINTER_SAMPLE_COUNT,
      heavyFixturePreservedAfterCancel: true,
      fixtureClearedBeforeCommit: true,
    };
  }
  if (id === PHASE6_SCENARIO_IDS.workerBackpressure) {
    return { workerBackpressureWheelEventsDispatched: 96, ...currentPaint };
  }
  return { wheelEventsDispatched: 60, panEventsDispatched: 36, ...currentPaint };
}

function runtimeFor(id) {
  const fallback = id === PHASE6_SCENARIO_IDS.mainThreadFallback;
  return {
    engineMode: "scene-canary",
    scenePublicationReady: true,
    attachedPrimitiveCount: 1,
    backend: fallback ? "main-thread" : "worker",
    backendSource: fallback ? "benchmark-fallback" : "configured-worker",
    workerResultDelayMs: id === PHASE6_SCENARIO_IDS.workerBackpressure ? 96 : 0,
    sourceLineageExactResolveCount:
      id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan ? 64 : 0,
    sourceLineageFallbackResolveCount: 0,
    sourceLineageUnresolvedResolveCount: 0,
    offscreenSupported: true,
    queueDepthMax: fallback ? 0 : 2,
    inFlightMax: fallback ? 0 : 1,
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    workerJobDelta: fallback ? 0
      : id === PHASE6_SCENARIO_IDS.workerBackpressure ? 8 : 3,
    workerResultDelta: fallback ? 0 : 2,
    pendingDropDelta: id === PHASE6_SCENARIO_IDS.workerBackpressure ? 5 : 0,
    staleResultDropDelta: id === PHASE6_SCENARIO_IDS.workerBackpressure ? 1 : 0,
    stalePublishDelta: 0,
    rawPointsMax: id === PHASE6_SCENARIO_IDS.hitIndex ? 1_024 : 32_768,
    renderedPointsMax: id === PHASE6_SCENARIO_IDS.hitIndex ? 600 : 4_096,
    lodRatio: id === PHASE6_SCENARIO_IDS.hitIndex ? 0.5859375 : 0.125,
    lodObservationPhase: id === PHASE6_SCENARIO_IDS.activeFinalize ? "initial" : "final",
    initialRawPoints: id === PHASE6_SCENARIO_IDS.hitIndex ? 0 : 32_768,
    initialRenderedPoints: id === PHASE6_SCENARIO_IDS.hitIndex ? 0 : 4_096,
    initialLodRatio: id === PHASE6_SCENARIO_IDS.hitIndex ? 0 : 0.125,
    finalRawPoints: id === PHASE6_SCENARIO_IDS.activeFinalize ? 757
      : id === PHASE6_SCENARIO_IDS.hitIndex ? 1_024 : 32_768,
    finalRenderedPoints: id === PHASE6_SCENARIO_IDS.activeFinalize ? 757
      : id === PHASE6_SCENARIO_IDS.hitIndex ? 600 : 4_096,
    finalLodRatio: id === PHASE6_SCENARIO_IDS.activeFinalize ? 1
      : id === PHASE6_SCENARIO_IDS.hitIndex ? 0.5859375 : 0.125,
    canonicalRawPreserved: true,
    vertexBudgetPassed: true,
    anchorResolveDelta: id === PHASE6_SCENARIO_IDS.activeFinalize ? 1 : 0,
    lastRequestedStamp: stamp,
    lastPublishedStamp: stamp,
    lastPaintedStamp: stamp,
  };
}

function samplesFor(id) {
  const samples = {
    drawingMainThreadMs: [],
    inputToNextPaintMs: [],
    sceneProjectPaintMs: [],
    frameIntervalMs: [],
    hitQueryMs: [],
    mouseupSyncMs: [],
    workerFinalizeMs: [],
    exactRenderMs: [],
  };
  if (id === PHASE6_SCENARIO_IDS.hitIndex) samples.hitQueryMs = [0.2, 0.4];
  else {
    samples.frameIntervalMs = [16, 17];
    samples.exactRenderMs = [80];
  }
  if (id === PHASE6_SCENARIO_IDS.activeFinalize) {
    samples.drawingMainThreadMs = [2, 3];
    samples.inputToNextPaintMs = [12, 15];
    samples.mouseupSyncMs = [4, 5];
    samples.workerFinalizeMs = [60, 80];
  } else if (id !== PHASE6_SCENARIO_IDS.hitIndex) {
    samples.sceneProjectPaintMs = [5, 7];
  }
  return samples;
}

function run(id, iteration, warmup = false) {
  return {
    id: `${id}-${iteration}`,
    warmup,
    action: actionFor(id),
    samples: samplesFor(id),
    bench: { longTaskSupported: true, devicePixelRatio: 1 },
    browserWindow: {
      headed: true,
      windowState: "normal",
      visibilityState: "visible",
      hidden: false,
      devicePixelRatio: 1,
    },
    restore: { passed: true },
    phase5Probe: id === PHASE6_SCENARIO_IDS.activeFinalize ? phase5Probe() : null,
    phase6Probe: {
      started: true,
      fallbackRequested: id === PHASE6_SCENARIO_IDS.mainThreadFallback,
      backpressureDelayMs: id === PHASE6_SCENARIO_IDS.workerBackpressure ? 96 : 0,
      runtime: runtimeFor(id),
      hitOracle: id === PHASE6_SCENARIO_IDS.hitIndex ? {
        supported: true,
        queryCount: PHASE6_HIT_QUERY_COUNT,
        mismatchCount: 0,
        positiveHitCount: 48,
        candidateCoverageCount: 1,
        maxCandidates: 8,
        totalSegments: 2_048,
        queriedStamp: stamp,
        paintedStamp: stamp,
        currentPainted: true,
      } : null,
    },
  };
}

function metricsFor(id) {
  const metrics = {};
  const add = (metric, values) => { metrics[metric] = { samples: 10, ...values }; };
  if (id === PHASE6_SCENARIO_IDS.hitIndex) {
    add("hitQueryMs", {
      p95: PHASE6_BUDGETS.hitQueryP95Ms,
      p99: PHASE6_BUDGETS.hitQueryP99Ms,
      max: PHASE6_BUDGETS.hitQueryMaxMs,
    });
    return metrics;
  }
  add("frameIntervalMs", {
    p95: PHASE6_BUDGETS.frameIntervalP95Ms,
    p99: PHASE6_BUDGETS.frameIntervalP99Ms,
  });
  add("exactRenderMs", { max: PHASE6_BUDGETS.exactRenderMaxMs });
  if (id === PHASE6_SCENARIO_IDS.activeFinalize) {
    add("drawingMainThreadMs", {
      p95: PHASE6_BUDGETS.drawingMainThreadP95Ms,
      p99: PHASE6_BUDGETS.drawingMainThreadP99Ms,
    });
    add("inputToNextPaintMs", {
      p95: PHASE6_BUDGETS.inputToNextPaintP95Ms,
      p99: PHASE6_BUDGETS.inputToNextPaintP99Ms,
    });
    add("mouseupSyncMs", {
      p95: PHASE6_BUDGETS.mouseupSyncP95Ms,
      p99: PHASE6_BUDGETS.mouseupSyncP99Ms,
    });
    add("workerFinalizeMs", { p95: PHASE6_BUDGETS.workerFinalizeP95Ms });
  } else {
    add("sceneProjectPaintMs", {
      p95: PHASE6_BUDGETS.sceneProjectPaintP95Ms,
      p99: PHASE6_BUDGETS.sceneProjectPaintP99Ms,
    });
  }
  return metrics;
}

function scenario(id) {
  const hit = id === PHASE6_SCENARIO_IDS.hitIndex;
  const lineage = id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan;
  const freehand = !hit;
  return {
    id,
    fixture: {
      name: lineage ? "freehandLineage64x512" : hit ? "entities512" : "freehand64x512",
      bars: PHASE6_BAR_COUNT,
      entities: hit ? 512 : 64,
      points: hit ? 1_024 : 32_768,
      spans: lineage ? 64 : 0,
      maxFreehandPointsPerDrawing: freehand ? 512 : 0,
      maxFreehandSpansPerDrawing: lineage ? 1 : 0,
      sourceLineage: lineage,
      ...(lineage ? {
        sourceProjection: PHASE6_LINEAGE_REPRESENTATION.projectorId,
        sourceProjectionConfig: PHASE6_LINEAGE_REPRESENTATION.projectionConfig,
        lineageExact: {
          left: { time: 1_700_000_000, sourceOrdinal: 2 },
          right: { time: 1_700_003_600, sourceOrdinal: 3 },
        },
        lineageFallback: {
          fromTime: 1_700_000_000,
          toTime: 1_700_003_600,
          leftRatio: 0,
          rightRatio: 1,
        },
        lineageDerivedRowCount: 4_000,
      } : {}),
    },
    repetitions: { measuredRuns: 5, warmupRuns: 1 },
    rawRuns: Array.from({ length: 6 }, (_, index) => run(id, index + 1, index === 0)),
    metrics: metricsFor(id),
    longTasks: { attributableCount: 0 },
  };
}

function passingReport() {
  return {
    context: { mode: "scene-canary" },
    configuration: {
      drawingEngineMode: "scene-canary",
      drawingInteractionSurfaceMode: "overlay",
      drawingRasterBackend: "worker",
      headless: false,
      buildEnvironment: { VITE_DRAWING_RASTER_BACKEND: "worker" },
    },
    environment: {
      productionBuild: true,
      productionBuildVerification: "managed-vite-preview",
      dpr: 1,
    },
    executionAcceptance: { passed: true },
    scenarios: Object.values(PHASE6_SCENARIO_IDS).map(scenario),
  };
}

function acceptance(report = passingReport()) {
  return buildPhase6Acceptance(report, { runs: 5, warmupRuns: 1, smoke: false });
}

test("formal Phase 6 acceptance requires the full 5+1 production matrix", () => {
  const result = acceptance();
  assert.equal(result.passed, true);
  assert.equal(result.modePassed, true);
  assert.equal(result.headedModePassed, true);
  assert.equal(result.barCoveragePassed, true);
  assert.equal(result.fixtureCoveragePassed, true);
  assert.equal(result.runtimeEvidencePassed, true);
  assert.equal(result.actionCoveragePassed, true);
  assert.equal(result.browserEnvironmentPassed, true);
  assert.equal(result.metricBudgetsPassed, true);
  assert.equal(result.perRunMetricCoveragePassed, true);
  assert.equal(result.attributableLongTaskPassed, true);
});

test("formal Phase 6 rejects headless, hidden, and DPR-drifted browser evidence", () => {
  const headlessReport = passingReport();
  headlessReport.configuration.headless = true;
  const headless = acceptance(headlessReport);
  assert.equal(headless.passed, false);
  assert.equal(headless.headedModePassed, false);
  assert.ok(headless.failureReasons.includes("phase6-headed-mode-required"));

  const hiddenReport = passingReport();
  hiddenReport.scenarios[0].rawRuns[1].browserWindow.visibilityState = "hidden";
  hiddenReport.scenarios[0].rawRuns[1].browserWindow.hidden = true;
  const hidden = acceptance(hiddenReport);
  assert.equal(hidden.passed, false);
  assert.equal(hidden.browserEnvironmentPassed, false);
  assert.ok(hidden.failureReasons.includes("phase6-browser-environment-invalid"));

  const dprReport = passingReport();
  dprReport.scenarios[0].rawRuns[1].bench.devicePixelRatio = 2;
  const dpr = acceptance(dprReport);
  assert.equal(dpr.passed, false);
  assert.equal(dpr.browserEnvironmentPassed, false);
});

test("formal Phase 6 acceptance supports more than five measured repetitions", () => {
  const report = passingReport();
  for (const scenarioValue of report.scenarios) {
    scenarioValue.rawRuns.push(run(scenarioValue.id, 7, false));
    scenarioValue.repetitions.measuredRuns = 6;
  }
  const result = buildPhase6Acceptance(report, {
    runs: 6,
    warmupRuns: 1,
    smoke: false,
  });
  assert.equal(result.measuredRunCoveragePassed, true);
  assert.equal(result.runtimeEvidence.length, PHASE6_REQUIRED_SCENARIO_IDS.length * 6);
  assert.equal(result.actionEvidence.length, PHASE6_REQUIRED_SCENARIO_IDS.length * 6);
  assert.equal(result.perRunMetricEvidence.length, PHASE6_REQUIRED_SCENARIO_IDS.length * 6);
  assert.equal(result.passed, true);
});

test("Phase 6 runner requires the 64x512 source-lineage viewport scenario", () => {
  assert.deepEqual(PHASE6_LINEAGE_VIEWPORT_SCENARIO, {
    id: PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
    fixture: "freehandLineage64x512",
    action: "phase6-viewport",
    requiredMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    targetMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    targetCounters: [
      "surfacePrimitiveCount",
      "workerQueueDepth",
      "workerInFlight",
      "staleWorkerPublishCount",
    ],
    representation: PHASE6_LINEAGE_REPRESENTATION,
  });
  assert.ok(PHASE6_REQUIRED_SCENARIO_IDS.includes(
    PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  ));
  const report = passingReport();
  const lineage = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  );
  assert.deepEqual(lineage.fixture, {
    name: "freehandLineage64x512",
    bars: PHASE6_BAR_COUNT,
    entities: 64,
    points: 32_768,
    spans: 64,
    maxFreehandPointsPerDrawing: 512,
    maxFreehandSpansPerDrawing: 1,
    sourceLineage: true,
    sourceProjection: PHASE6_LINEAGE_REPRESENTATION.projectorId,
    sourceProjectionConfig: PHASE6_LINEAGE_REPRESENTATION.projectionConfig,
    lineageExact: {
      left: { time: 1_700_000_000, sourceOrdinal: 2 },
      right: { time: 1_700_003_600, sourceOrdinal: 3 },
    },
    lineageFallback: {
      fromTime: 1_700_000_000,
      toTime: 1_700_003_600,
      leftRatio: 0,
      rightRatio: 1,
    },
    lineageDerivedRowCount: 4_000,
  });
});

test("source-lineage viewport uses the same action, runtime, and latency gates as freehand zoom", () => {
  const report = passingReport();
  const lineage = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  );
  const measured = lineage.rawRuns.find((item) => !item.warmup);
  measured.action.panEventsDispatched = 0;
  measured.phase6Probe.runtime.anchorResolveDelta = 1;
  lineage.metrics.sceneProjectPaintMs.p95 = PHASE6_BUDGETS.sceneProjectPaintP95Ms + 0.01;
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.actionCoveragePassed, false);
  assert.equal(result.runtimeEvidencePassed, false);
  assert.equal(result.metricBudgetsPassed, false);
  assert.ok(result.actionEvidence.some((item) => (
    item.scenarioId === PHASE6_SCENARIO_IDS.freehandLineageZoomPan && !item.passed
  )));
  assert.ok(result.runtimeEvidence.some((item) => (
    item.scenarioId === PHASE6_SCENARIO_IDS.freehandLineageZoomPan && !item.passed
  )));
  assert.ok(result.metricEvidence.some((item) => (
    item.scenarioId === PHASE6_SCENARIO_IDS.freehandLineageZoomPan
      && item.metric === "sceneProjectPaintMs"
      && !item.passed
  )));
});

test("source-lineage viewport proves exact Renko projection without fallback", () => {
  const report = passingReport();
  const lineage = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  );
  const runtime = lineage.rawRuns[1].phase6Probe.runtime;
  runtime.sourceLineageExactResolveCount = 0;
  runtime.sourceLineageFallbackResolveCount = 64;
  const result = acceptance(report);
  assert.equal(result.runtimeEvidencePassed, false);
  const evidence = result.runtimeEvidence.find((item) => item.runId === lineage.rawRuns[1].id);
  assert.equal(evidence.sourceLineagePassed, false);
  assert.equal(evidence.sourceLineageExactResolveCount, 0);
  assert.equal(evidence.sourceLineageFallbackResolveCount, 64);
});

test("Phase 6 rejects wrong fixture names and missing source-lineage span provenance", () => {
  const report = passingReport();
  const lineage = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  );
  lineage.fixture.name = "freehand64x512";
  lineage.fixture.spans = 0;
  lineage.fixture.sourceLineage = false;
  const result = acceptance(report);
  assert.equal(result.fixtureCoveragePassed, false);
  assert.ok(result.fixtureEvidence.some((item) => (
    item.scenarioId === PHASE6_SCENARIO_IDS.freehandLineageZoomPan && !item.passed
  )));
  assert.ok(result.failureReasons.includes("phase6-fixture-provenance-invalid"));
});

test("Phase 6 hit queries ignore host offsets and cover the pane in local coordinates", () => {
  const plotRect = { x: 137, y: 81, width: 1_200, height: 700, dpr: 1.5 };
  assert.deepEqual(normalizePhase6PanePlotRect(plotRect), {
    x: 0,
    y: 0,
    width: 1_200,
    height: 700,
    dpr: 1.5,
  });
  const points = buildPhase6HitQueryPoints(plotRect, PHASE6_HIT_QUERY_COUNT);
  assert.equal(points.length, PHASE6_HIT_QUERY_COUNT);
  assert.ok(points.every((point) => point.x >= 0 && point.x <= plotRect.width));
  assert.ok(points.every((point) => point.y >= 0 && point.y <= plotRect.height));
  assert.ok(points.some((point) => point.x < 100));
  assert.ok(points.some((point) => point.x > 1_100));
  assert.ok(points.some((point) => point.y < 100));
  assert.ok(points.some((point) => point.y > 600));
  assert.deepEqual(buildPhase6HitQueryPoints({ ...plotRect, width: 0 }, 1_000), []);
});

test("Phase 6 fails closed when production has not exposed worker/runtime evidence", () => {
  const report = passingReport();
  for (const scenarioValue of report.scenarios) {
    for (const runValue of scenarioValue.rawRuns) runValue.phase6Probe.runtime = null;
  }
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.runtimeEvidencePassed, false);
  assert.ok(result.failureReasons.includes("phase6-runtime-evidence-missing-or-invalid"));
});

test("Phase 6 rejects empty worker finalize and exact-settle samples", () => {
  const report = passingReport();
  const active = report.scenarios.find((item) => item.id === PHASE6_SCENARIO_IDS.activeFinalize);
  active.metrics.workerFinalizeMs = { samples: 0, p95: null };
  for (const runValue of active.rawRuns.filter((item) => !item.warmup)) {
    runValue.samples.workerFinalizeMs = [];
    runValue.samples.exactRenderMs = [];
  }
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.metricBudgetsPassed, false);
  assert.equal(result.perRunMetricCoveragePassed, false);
  assert.ok(result.failureReasons.includes("phase6-required-metric-samples-missing"));
});

test("Phase 6 rejects queue overflow, stale publication, and mismatched stamps", () => {
  const report = passingReport();
  const zoom = report.scenarios.find((item) => item.id === PHASE6_SCENARIO_IDS.freehandZoomPan);
  const runtime = zoom.rawRuns[1].phase6Probe.runtime;
  runtime.queueDepthMax = 3;
  runtime.stalePublishDelta = 1;
  runtime.lastPaintedStamp = { ...stamp, viewportRevision: stamp.viewportRevision - 1 };
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.runtimeEvidencePassed, false);
  const evidence = result.runtimeEvidence.find((item) => item.runId === zoom.rawRuns[1].id);
  assert.equal(evidence.stampPassed, false);
});

test("Phase 6 hit-index gate requires exactly 1000 oracle-parity queries over candidates", () => {
  const report = passingReport();
  const hit = report.scenarios.find((item) => item.id === PHASE6_SCENARIO_IDS.hitIndex);
  const oracle = hit.rawRuns[1].phase6Probe.hitOracle;
  oracle.queryCount = 999;
  oracle.mismatchCount = 1;
  oracle.positiveHitCount = 0;
  oracle.candidateCoverageCount = 0;
  oracle.maxCandidates = oracle.totalSegments;
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.actionCoveragePassed, false);
  assert.ok(result.failureReasons.includes("phase6-action-or-oracle-coverage-failed"));
});

test("Phase 6 hit-index gate requires the newly painted viewport stamp and out-of-window oracle", () => {
  const report = passingReport();
  const hit = report.scenarios.find((item) => item.id === PHASE6_SCENARIO_IDS.hitIndex);
  const measured = hit.rawRuns[1];
  measured.action.hitQueryQueriedStamp = { ...stamp, viewportRevision: 99 };
  measured.action.hitOracleOutsideMeasurementWindow = false;
  const result = acceptance(report);
  assert.equal(result.actionCoveragePassed, false);
  const evidence = result.actionEvidence.find((item) => item.runId === measured.id);
  assert.equal(evidence.queryStampPassed, false);
});

test("Phase 6 hit-index gate rejects all-null parity and missing candidate coverage", () => {
  const report = passingReport();
  const hit = report.scenarios.find((item) => item.id === PHASE6_SCENARIO_IDS.hitIndex);
  for (const measured of hit.rawRuns.filter((item) => !item.warmup)) {
    measured.phase6Probe.hitOracle.positiveHitCount = 0;
    measured.phase6Probe.hitOracle.candidateCoverageCount = 0;
    measured.phase6Probe.hitOracle.maxCandidates = 0;
    measured.action.hitOraclePositiveHitCount = 0;
    measured.action.hitOracleCandidateCoverageCount = 0;
    measured.action.hitOracleMaxCandidates = 0;
  }
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.actionCoveragePassed, false);
  const evidence = result.actionEvidence.find((item) => (
    item.scenarioId === PHASE6_SCENARIO_IDS.hitIndex
  ));
  assert.equal(evidence.positiveHitCount, 0);
  assert.equal(evidence.candidateCoverageCount, 0);
  assert.ok(result.failureReasons.includes("phase6-action-or-oracle-coverage-failed"));
});

test("Phase 6 requires real LOD, preserved canonical raw geometry, and one primitive", () => {
  const report = passingReport();
  const fallback = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.mainThreadFallback,
  );
  const runtime = fallback.rawRuns[1].phase6Probe.runtime;
  runtime.renderedPointsMax = runtime.rawPointsMax;
  runtime.lodRatio = 1;
  runtime.canonicalRawPreserved = false;
  runtime.attachedPrimitiveCount = 65;
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.runtimeEvidencePassed, false);
});

test("Phase 6 LOD evidence stays coherent across a smaller final plan and fails on mixed ratios", () => {
  const passing = acceptance();
  const activeEvidence = passing.runtimeEvidence.find(
    (item) => item.scenarioId === PHASE6_SCENARIO_IDS.activeFinalize,
  );
  assert.equal(activeEvidence.lodPassed, true);
  assert.equal(activeEvidence.lodObservationPhase, "initial");
  assert.equal(activeEvidence.finalLodRatio, 1);

  const report = passingReport();
  const fallback = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.mainThreadFallback,
  );
  const runtime = fallback.rawRuns[1].phase6Probe.runtime;
  runtime.lodRatio = 0.25;
  const result = acceptance(report);
  const evidence = result.runtimeEvidence.find((item) => item.runId === fallback.rawRuns[1].id);
  assert.equal(result.runtimeEvidencePassed, false);
  assert.equal(evidence.lodPassed, false);
});

test("Phase 6 LOD evidence fails closed when final observations or invariants disappear", () => {
  const report = passingReport();
  const active = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.activeFinalize,
  );
  const missingFinal = active.rawRuns[1].phase6Probe.runtime;
  missingFinal.finalRawPoints = null;
  missingFinal.finalRenderedPoints = null;
  missingFinal.finalLodRatio = null;
  const missingFinalResult = acceptance(report);
  const missingFinalEvidence = missingFinalResult.runtimeEvidence.find(
    (item) => item.runId === active.rawRuns[1].id,
  );
  assert.equal(missingFinalResult.runtimeEvidencePassed, false);
  assert.equal(missingFinalEvidence.lodPassed, false);

  const invariantReport = passingReport();
  const fallback = invariantReport.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.mainThreadFallback,
  );
  fallback.rawRuns[1].phase6Probe.runtime.canonicalRawPreserved = null;
  fallback.rawRuns[2].phase6Probe.runtime.vertexBudgetPassed = null;
  const invariantResult = acceptance(invariantReport);
  assert.equal(invariantResult.runtimeEvidencePassed, false);
});

test("Phase 6 backpressure and fallback scenarios prove their distinct paths", () => {
  const report = passingReport();
  const pressure = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.workerBackpressure,
  );
  pressure.rawRuns[1].phase6Probe.runtime.pendingDropDelta = 0;
  pressure.rawRuns[2].phase6Probe.runtime.workerResultDelayMs = 95;
  const fallback = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.mainThreadFallback,
  );
  fallback.rawRuns[1].phase6Probe.runtime.backend = "worker";
  fallback.rawRuns[1].phase6Probe.fallbackRequested = false;
  fallback.rawRuns[2].phase6Probe.runtime.backendSource = "offscreen-unsupported";
  fallback.rawRuns[3].phase6Probe.runtime.workerJobDelta = 1;
  fallback.rawRuns[4].phase6Probe.runtime.lastPublishedStamp = {
    ...stamp,
    viewportRevision: stamp.viewportRevision - 1,
  };
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.runtimeEvidencePassed, false);
  assert.equal(result.actionCoveragePassed, false);
});

test("Phase 6 backpressure proves a bounded drained latest-wins queue without charging injected delay to exact SLO", () => {
  const report = passingReport();
  const pressure = report.scenarios.find(
    (item) => item.id === PHASE6_SCENARIO_IDS.workerBackpressure,
  );
  pressure.metrics.exactRenderMs.max = PHASE6_BUDGETS.exactRenderMaxMs + 96;
  let result = acceptance(report);
  assert.equal(result.passed, true);
  assert.equal(result.metricEvidence.some((item) => (
    item.scenarioId === PHASE6_SCENARIO_IDS.workerBackpressure
      && item.metric === "exactRenderMs"
  )), false);

  const measured = pressure.rawRuns[1];
  measured.phase6Probe.runtime.queueDepthMax = 1;
  result = acceptance(report);
  assert.equal(result.runtimeEvidencePassed, false);
  assert.equal(result.runtimeEvidence.find((item) => item.runId === measured.id)
    ?.backpressurePassed, false);

  measured.phase6Probe.runtime.queueDepthMax = PHASE6_BUDGETS.workerQueueDepthMax;
  measured.phase6Probe.runtime.queueDepthCurrent = 1;
  result = acceptance(report);
  assert.equal(result.runtimeEvidencePassed, false);

  measured.phase6Probe.runtime.queueDepthCurrent = 0;
  measured.samples.exactRenderMs = [];
  result = acceptance(report);
  assert.equal(result.runtimeEvidencePassed, true);
  assert.equal(result.perRunMetricCoveragePassed, false);
});

test("Phase 6 refuses smoke, wrong managed mode, insufficient bars, and fewer repetitions", () => {
  const report = passingReport();
  report.configuration.drawingRasterBackend = "main-thread";
  report.scenarios[0].fixture.bars = PHASE6_BAR_COUNT - 1;
  const result = buildPhase6Acceptance(report, {
    runs: 4,
    warmupRuns: 0,
    smoke: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.modePassed, false);
  assert.equal(result.barCoveragePassed, false);
  assert.equal(result.measuredRunCoveragePassed, false);
  assert.equal(result.warmupCoveragePassed, false);
  assert.ok(result.failureReasons.includes("smoke-only-run"));
});
