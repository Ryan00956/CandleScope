import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDrawingSoak,
  DRAWING_SOAK_DEFAULTS,
  DRAWING_SOAK_FIXED_CONTRACT,
  isFormalDrawingSoakConfiguration,
  normalizeDrawingSoakRuntimeEvidence,
  theilSenSlopeBytesPerHour,
} from "./drawing-soak-metrics.mjs";

const MIB = 1024 * 1024;

const TEST_CONFIGURATION = Object.freeze({
  durationMs: 14_000,
  warmupMs: 2_000,
  requiredMeasuredDurationMs: 10_000,
  sampleIntervalMs: 1_000,
  gcIntervalMs: 2_000,
  workloadIntervalMs: 2_000,
  comparisonWindowMs: 2_000,
  minSampleCoverage: 0.95,
  maxSampleGapMs: 1_500,
  maxHeapDeltaPct: 10,
  maxHeapSlopePctPerHour: 2,
  heapSlopeNoiseFloorBytesPerHour: MIB,
  terminalPlateauPct: 2,
  terminalPlateauNoiseFloorBytes: MIB,
  minGcCheckpoints: 6,
  plateauWindowSize: 2,
  minDistinctViewportRevisions: 2,
  maxWorkerQueueDepth: 2,
  maxWorkerInFlight: 1,
  frameIntervalP95Ms: 20,
  frameIntervalP99Ms: 33.4,
  inputToNextPaintP95Ms: 20,
  inputToNextPaintP99Ms: 33,
});

function stamp(viewportRevision) {
  return {
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 4,
    surfaceGeneration: 3,
    dataRevision: 7,
    projectionRevision: 9,
    lineageIndexRevision: 2,
    viewportRevision,
    themeRevision: 1,
    widthCssPx: 1200,
    heightCssPx: 720,
    dpr: 1.5,
  };
}

function runtime(viewportRevision = 1) {
  const currentStamp = stamp(viewportRevision);
  return {
    engineMode: "scene-canary",
    scenePublicationReady: true,
    attachedPrimitiveCount: 1,
    backend: "worker",
    canonicalRawPreserved: true,
    vertexBudgetPassed: true,
    queueDepthMax: 1,
    inFlightMax: 1,
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    stalePublishDelta: 0,
    sceneFallbackCount: 0,
    sceneRuntimeFaultCount: 0,
    legacyFallbackSucceededCount: 0,
    sceneFallbackDelta: 0,
    sceneFallbackLastReason: null,
    workerJobDelta: 1_000,
    workerResultDelta: 1_000,
    cacheBytes: 24 * MIB,
    cacheBytesMax: 28 * MIB,
    cacheBudgetBytes: 64 * MIB,
    cacheHardLimitBytes: 96 * MIB,
    cacheEntryCount: 64,
    cacheBudgetEvictionCount: 0,
    cacheEntryBytes: 23 * MIB,
    cacheEntryBudgetBytes: 63 * MIB,
    cacheMetadataBytes: MIB,
    cacheMetadataBudgetBytes: MIB,
    cacheRecentHierarchyKeyCount: 128,
    cacheRecentHierarchyKeysPerRequestLimit: 3,
    cacheRecentRequestCount: 64,
    cacheRecentRequestLimit: 512,
    lastRequestedStamp: currentStamp,
    lastPublishedStamp: structuredClone(currentStamp),
    lastPaintedStamp: structuredClone(currentStamp),
  };
}

function heapSnapshot(aggregateUsedSize) {
  return {
    aggregateUsedSize,
    aggregateBackingStorageSize: 8 * MIB,
    aggregateEmbedderHeapUsedSize: 4 * MIB,
    page: {
      usedSize: aggregateUsedSize - 20 * MIB,
      backingStorageSize: 6 * MIB,
      embedderHeapUsedSize: 3 * MIB,
    },
    workers: [{
      sessionId: "drawing-worker-session",
      targetId: "drawing-worker",
      usedSize: 20 * MIB,
      backingStorageSize: 2 * MIB,
      embedderHeapUsedSize: MIB,
    }],
  };
}

function timingMetric({ includeBuckets = false } = {}) {
  return {
    totalCount: 100,
    invalidCount: 0,
    captureObserved: 100,
    bucketWidthMs: 16.7,
    histogramMaxMs: 1_000,
    bucketCount: 2,
    overflowCount: 0,
    p50Ms: 16.7,
    p95Ms: 16.7,
    p99Ms: 16.7,
    maxMs: 16.7,
    ...(includeBuckets ? { bucketCounts: [100, 0] } : {}),
  };
}

function browserTiming({ includeBuckets = false, windowDurationMs = 1_000 } = {}) {
  return {
    windowDurationMs,
    refreshRateHz: 1_000 / 16.7,
    inputEvents: 100,
    eventTimingSupported: true,
    longTaskSupported: true,
    longTaskCounts: {
      total: 0,
      retained: 0,
      dropped: 0,
      excluded: 0,
      attributable: 0,
    },
    instrumentationWindows: [],
    rawLongTasks: [],
    captureStats: {
      rafIntervalsMs: { observed: 100, dropped: 0 },
      inputToNextPaintMs: { observed: 100, dropped: 0 },
      eventTimingMs: { observed: 100, dropped: 0 },
      mouseupSyncMs: { observed: 100, dropped: 0 },
    },
    metrics: {
      frameIntervalMs: timingMetric({ includeBuckets }),
      inputToNextPaintMs: timingMetric({ includeBuckets }),
      eventTimingMs: timingMetric({ includeBuckets }),
      mouseupSyncMs: timingMetric({ includeBuckets }),
    },
  };
}

function buildPassingReport({
  heapAt = () => 100 * MIB,
  configuration = TEST_CONFIGURATION,
} = {}) {
  const samples = [];
  for (
    let elapsedMs = configuration.warmupMs;
    elapsedMs <= configuration.durationMs;
    elapsedMs += configuration.sampleIntervalMs
  ) {
    const aggregateUsedSize = heapAt(elapsedMs);
    samples.push({
      elapsedMs,
      workerVisible: true,
      heap: heapSnapshot(aggregateUsedSize),
      dom: { documents: 1, nodes: 400, jsEventListeners: 80 },
      performance: { Timestamp: elapsedMs / 1_000, TaskDuration: 1, ScriptDuration: 0.5 },
      browserTiming: browserTiming({
        windowDurationMs: Math.max(0, elapsedMs - configuration.warmupMs),
      }),
      visibility: { visibilityState: "visible", hidden: false, hasFocus: true },
      runtime: runtime(Math.floor(elapsedMs / 1_000)),
    });
  }
  const gcCheckpoints = [];
  for (
    let elapsedMs = configuration.warmupMs;
    elapsedMs <= configuration.durationMs;
    elapsedMs += configuration.gcIntervalMs
  ) {
    gcCheckpoints.push({
      elapsedMs,
      scheduledAtMs: elapsedMs,
      ok: true,
      after: heapSnapshot(heapAt(elapsedMs)),
    });
  }
  const finalBrowserTiming = browserTiming({
    includeBuckets: true,
    windowDurationMs: configuration.requiredMeasuredDurationMs,
  });
  finalBrowserTiming.instrumentationWindows = gcCheckpoints.map((checkpoint, index) => ({
    name: `phase9-forced-gc:${checkpoint.scheduledAtMs}`,
    startTime: 1_000 + index * 200,
    endTime: 1_100 + index * 200,
  }));
  return {
    configuration: {
      ...configuration,
      drawingEngineMode: "scene-canary",
      drawingInteractionSurfaceMode: "overlay",
      drawingRasterBackend: "worker",
      drawingCoordinateProjectorMode: "batch",
      drawingDocumentAuthority: "document",
      bars: 10_000,
      dpr: 1.5,
      seed: DRAWING_SOAK_FIXED_CONTRACT.seed,
      intervalSeconds: DRAWING_SOAK_FIXED_CONTRACT.intervalSeconds,
      mockEndTime: DRAWING_SOAK_FIXED_CONTRACT.mockEndTime,
      headless: false,
    },
    fixture: {
      name: DRAWING_SOAK_FIXED_CONTRACT.fixtureName,
      entities: DRAWING_SOAK_FIXED_CONTRACT.fixtureEntities,
      points: DRAWING_SOAK_FIXED_CONTRACT.fixturePoints,
      seed: DRAWING_SOAK_FIXED_CONTRACT.seed,
      rawSha256: DRAWING_SOAK_FIXED_CONTRACT.fixtureRawSha256,
    },
    environment: {
      productionBuild: true,
      productionBuildVerification: "managed-vite-preview",
      refreshRateHz: 1_000 / 16.7,
      buildEnvironment: { NODE_ENV: "production" },
    },
    context: {
      git: {
        commit: "a".repeat(40),
        buildInputFingerprint: "b".repeat(64),
        buildInputsDirty: false,
      },
      browser: { name: "Chromium" },
      machine: { platform: "win32" },
    },
    readiness: {
      browserWindowInitial: {
        headed: true,
        windowState: "normal",
        visibilityState: "visible",
        hidden: false,
        devicePixelRatio: 1.5,
      },
      browserWindowFinal: {
        headed: true,
        windowState: "normal",
        visibilityState: "visible",
        hidden: false,
        devicePixelRatio: 1.5,
      },
      refreshRatePreflight: {
        frameMedianMs: 16.7,
        refreshRateHz: 1_000 / 16.7,
      },
      drawingEngineDomEvidenceInitial: { passed: true },
      drawingEngineDomEvidenceFinal: { passed: true },
      probeStopped: { started: true, stopped: true },
      workerTargetsInitial: [{
        sessionId: "drawing-worker-session",
        targetId: "drawing-worker",
      }],
      workerTargetsFinal: [{
        sessionId: "drawing-worker-session",
        targetId: "drawing-worker",
      }],
    },
    samples,
    gcCheckpoints,
    cycles: Array.from({
      length: Math.floor(
        (configuration.durationMs - configuration.warmupMs)
          / configuration.workloadIntervalMs,
      ),
    }, (_, index) => {
      const viewportRevision = index + 10;
      return {
        elapsedMs: configuration.warmupMs
          + configuration.workloadIntervalMs * (index + 1),
        passed: true,
        currentPaintPassed: true,
        queueConverged: true,
        previousStamp: stamp(viewportRevision - 1),
        viewportRevision,
        workerJobCycleDelta: 4,
        workerResultCycleDelta: 1,
        stalePublishCycleDelta: 0,
        runtime: runtime(viewportRevision),
      };
    }),
    diagnostics: {
      sampleErrors: [],
      consoleErrors: [],
      runtimeExceptions: [],
      networkFailures: [],
      longTasks: [],
    },
    browserTiming: finalBrowserTiming,
  };
}

test("accepts a complete stable short soak as smoke evidence only", () => {
  const assessment = assessDrawingSoak(buildPassingReport());

  assert.equal(assessment.passed, false);
  assert.equal(assessment.formalEligible, false);
  assert.equal(assessment.smokeAcceptance.passed, true);
  assert.deepEqual(assessment.failureReasons, ["formalEligibility"]);
  assert.equal(assessment.summary.observedDurationMs, 12_000);
  assert.equal(assessment.summary.observedSamples, 13);
  assert.equal(assessment.summary.gc.checkpoints, 7);
});

test("accepts only a full 66 minute configuration as formal Phase 9 evidence", () => {
  const report = buildPassingReport({ configuration: DRAWING_SOAK_DEFAULTS });
  const assessment = assessDrawingSoak(report);

  assert.equal(isFormalDrawingSoakConfiguration(report.configuration), true);
  assert.equal(assessment.formalEligible, true);
  assert.equal(assessment.formalAcceptance.passed, true);
  assert.equal(assessment.passed, true);
});

test("fails closed when worker heap or runtime cache limits are missing", () => {
  const report = buildPassingReport();
  for (const sample of report.samples) {
    sample.workerVisible = false;
    sample.heap.workers = [];
    delete sample.runtime.cacheBudgetBytes;
    delete sample.runtime.cacheHardLimitBytes;
  }

  const assessment = assessDrawingSoak(report);

  assert.equal(assessment.passed, false);
  assert.equal(assessment.checks.workerHeapVisible.passed, false);
  assert.equal(assessment.checks.cacheEvidence.passed, false);
  assert.equal(assessment.checks.cacheBudget.passed, false);
  assert.ok(assessment.failureReasons.includes("workerHeapVisible"));
  assert.ok(assessment.failureReasons.includes("cacheEvidence"));

  const unboundedMetadata = buildPassingReport();
  unboundedMetadata.samples[0].runtime.cacheRecentRequestCount = 513;
  assert.equal(assessDrawingSoak(unboundedMetadata).checks.cacheBudget.passed, false);
});

test("rejects natural and post-GC retained-heap growth", () => {
  const report = buildPassingReport({
    heapAt: (elapsedMs) => 100 * MIB + ((elapsedMs - 2_000) / 1_000) * 3 * MIB,
  });

  const assessment = assessDrawingSoak(report);

  assert.equal(assessment.passed, false);
  assert.equal(assessment.checks.naturalHeapDelta.passed, false);
  assert.equal(assessment.checks.retainedHeapDelta.passed, false);
  assert.equal(assessment.checks.retainedHeapSlope.passed, false);
  assert.equal(assessment.checks.retainedHeapPlateau.passed, false);
});

test("rejects incomplete sample coverage and oversized sample gaps", () => {
  const report = buildPassingReport();
  report.samples.splice(4, 3);

  const assessment = assessDrawingSoak(report);

  assert.equal(assessment.checks.sampleCoverage.passed, false);
  assert.equal(assessment.checks.sampleGap.passed, false);
});

test("rejects cache, stamp, queue, cycle, and diagnostic regressions", () => {
  const report = buildPassingReport();
  report.samples[0].runtime.cacheBytesMax = 65 * MIB;
  report.samples[1].runtime.queueDepthCurrent = 1;
  report.samples[2].runtime.stalePublishDelta = 1;
  report.samples[3].runtime.lastPaintedStamp = stamp(999);
  report.cycles[0].passed = false;
  report.diagnostics.runtimeExceptions.push({ text: "boom" });

  const assessment = assessDrawingSoak(report);

  assert.equal(assessment.passed, false);
  assert.equal(assessment.checks.cacheBudget.passed, false);
  assert.equal(assessment.checks.runtimeInvariants.passed, false);
  assert.equal(assessment.checks.workloadCycles.passed, false);
  assert.equal(assessment.checks.diagnostics.passed, false);
});

test("does not accept missing or coerced numeric probe evidence", () => {
  const cases = [
    ["missing cache max", (report) => delete report.samples[0].runtime.cacheBytesMax],
    ["null page heap", (report) => { report.samples[0].heap.page.usedSize = null; }],
    ["aggregate mismatch", (report) => { report.samples[0].heap.aggregateUsedSize += 1; }],
    ["null worker heap", (report) => { report.samples[0].heap.workers[0].usedSize = null; }],
    ["stale published stamp", (report) => {
      report.samples[0].runtime.lastPublishedStamp = stamp(999);
    }],
    ["null diagnostics", (report) => {
      for (const key of Object.keys(report.diagnostics)) report.diagnostics[key] = null;
    }],
    ["missing DOM evidence", (report) => { report.samples[0].dom = null; }],
    ["missing performance evidence", (report) => { report.samples[0].performance = null; }],
  ];

  for (const [label, mutate] of cases) {
    const report = buildPassingReport();
    mutate(report);
    assert.equal(assessDrawingSoak(report).smokeAcceptance.passed, false, label);
  }
});

test("rejects failed or duplicate GC checkpoints and incomplete churn evidence", () => {
  const failedGc = buildPassingReport();
  failedGc.gcCheckpoints[0].ok = false;
  assert.equal(assessDrawingSoak(failedGc).checks.gcEvidence.passed, false);

  const duplicateGc = buildPassingReport();
  duplicateGc.gcCheckpoints[1].elapsedMs = duplicateGc.gcCheckpoints[0].elapsedMs;
  assert.equal(assessDrawingSoak(duplicateGc).checks.gcEvidence.passed, false);

  const missingCycleEvidence = buildPassingReport();
  delete missingCycleEvidence.cycles[0].currentPaintPassed;
  assert.equal(assessDrawingSoak(missingCycleEvidence).checks.workloadCycles.passed, false);

  const nonMonotonic = buildPassingReport();
  nonMonotonic.cycles[2].viewportRevision = nonMonotonic.cycles[1].viewportRevision;
  nonMonotonic.cycles[2].runtime = runtime(nonMonotonic.cycles[2].viewportRevision);
  nonMonotonic.cycles[2].previousStamp = stamp(nonMonotonic.cycles[2].viewportRevision - 1);
  assert.equal(assessDrawingSoak(nonMonotonic).checks.viewportChurn.passed, false);
});

test("rejects duplicate samples and a non-canonical fixed scene", () => {
  const duplicate = buildPassingReport();
  duplicate.samples.push(structuredClone(duplicate.samples[0]));
  assert.equal(assessDrawingSoak(duplicate).checks.sampleEvidence.passed, false);

  const wrongScene = buildPassingReport();
  wrongScene.configuration.dpr = 2;
  assert.equal(assessDrawingSoak(wrongScene).checks.fixedSceneContract.passed, false);
});

test("normalizes the real provider stamp/stale shape before strict assessment", () => {
  const raw = runtime(12);
  delete raw.lastPaintedStamp;
  delete raw.stalePublishDelta;
  raw.stalePublishCount = 0;

  const normalized = normalizeDrawingSoakRuntimeEvidence(raw);

  assert.deepEqual(normalized.lastPaintedStamp, raw.lastPublishedStamp);
  assert.equal(normalized.stalePublishDelta, 0);
});

test("fails closed for final DOM fallback, missing Long Task support, or worker churn", () => {
  const developmentBuild = buildPassingReport();
  developmentBuild.environment.buildEnvironment.NODE_ENV = "development";
  assert.equal(
    assessDrawingSoak(developmentBuild).checks.productionHarness.passed,
    false,
  );

  const finalDomFallback = buildPassingReport();
  finalDomFallback.readiness.drawingEngineDomEvidenceFinal.passed = false;
  assert.equal(
    assessDrawingSoak(finalDomFallback).checks.productionHarness.passed,
    false,
  );

  const unsupportedLongTasks = buildPassingReport();
  unsupportedLongTasks.browserTiming.longTaskSupported = false;
  assert.equal(
    assessDrawingSoak(unsupportedLongTasks).checks.productionHarness.passed,
    false,
  );

  const workerChurn = buildPassingReport();
  workerChurn.samples.at(-1).heap.workers[0].sessionId = "replacement-session";
  workerChurn.readiness.workerTargetsFinal[0].sessionId = "replacement-session";
  assert.equal(assessDrawingSoak(workerChurn).checks.workerLifecycle.passed, false);

  const duplicateWorker = buildPassingReport();
  duplicateWorker.samples[0].heap.workers.push({
    sessionId: "leaked-session",
    targetId: "leaked-worker",
    usedSize: 1,
  });
  duplicateWorker.samples[0].heap.aggregateUsedSize += 1;
  assert.equal(assessDrawingSoak(duplicateWorker).checks.sampleEvidence.passed, false);
});

test("accepts evidence at duration boundary but rejects a shortened formal profile", () => {
  const report = buildPassingReport();
  assert.equal(report.samples.at(-1).elapsedMs, TEST_CONFIGURATION.durationMs);
  assert.equal(report.gcCheckpoints.at(-1).elapsedMs, TEST_CONFIGURATION.durationMs);
  assert.equal(assessDrawingSoak(report).checks.sampleEvidence.passed, true);
  assert.equal(assessDrawingSoak(report).checks.gcEvidence.passed, true);

  const shortened = { ...DRAWING_SOAK_DEFAULTS, durationMs: 65 * 60 * 1_000 };
  assert.equal(isFormalDrawingSoakConfiguration(shortened), false);
});

test("formal configuration evidence never fills in missing or coerced fields", () => {
  assert.equal(isFormalDrawingSoakConfiguration({}), false);

  const missing = { ...DRAWING_SOAK_DEFAULTS };
  delete missing.durationMs;
  assert.equal(isFormalDrawingSoakConfiguration(missing), false);

  const coerced = { ...DRAWING_SOAK_DEFAULTS, durationMs: String(DRAWING_SOAK_DEFAULTS.durationMs) };
  assert.equal(isFormalDrawingSoakConfiguration(coerced), false);

  const report = buildPassingReport();
  delete report.configuration.gcIntervalMs;
  const assessment = assessDrawingSoak(report);
  assert.equal(assessment.checks.configurationEvidence.passed, false);
  assert.equal(assessment.smokeAcceptance.passed, false);
});

test("input/frame timing histograms are complete, bounded, and inside the fixed SLO", () => {
  const missing = buildPassingReport();
  delete missing.samples[0].browserTiming.metrics.frameIntervalMs;
  assert.equal(assessDrawingSoak(missing).checks.sampleEvidence.passed, false);

  const corrupt = buildPassingReport();
  corrupt.browserTiming.metrics.frameIntervalMs.bucketCounts[0] = 99;
  assert.equal(assessDrawingSoak(corrupt).checks.productionHarness.passed, false);
  assert.equal(assessDrawingSoak(corrupt).checks.inputFrameLatency.passed, false);

  const overBudget = buildPassingReport();
  overBudget.configuration.frameIntervalP95Ms = 5;
  assert.equal(assessDrawingSoak(overBudget).checks.inputFrameLatency.passed, false);

  const regressed = buildPassingReport();
  regressed.samples[2].browserTiming.metrics.inputToNextPaintMs.totalCount = 1;
  regressed.samples[2].browserTiming.metrics.inputToNextPaintMs.captureObserved = 1;
  regressed.samples[2].browserTiming.captureStats.inputToNextPaintMs.observed = 1;
  assert.equal(assessDrawingSoak(regressed).checks.browserTimingProgress.passed, false);
});

test("refresh-rate, scene fallback, and Long Task attribution evidence fail closed", () => {
  const wrongRefreshRate = buildPassingReport();
  wrongRefreshRate.environment.refreshRateHz = 120;
  wrongRefreshRate.browserTiming.refreshRateHz = 120;
  let assessment = assessDrawingSoak(wrongRefreshRate);
  assert.equal(assessment.checks.refreshRateProfile.passed, false);
  assert.equal(assessment.checks.productionHarness.passed, false);

  const sceneFallback = buildPassingReport();
  sceneFallback.samples[3].runtime.sceneFallbackCount = 1;
  sceneFallback.samples[3].runtime.sceneRuntimeFaultCount = 1;
  sceneFallback.samples[3].runtime.sceneFallbackDelta = 1;
  sceneFallback.samples[3].runtime.sceneFallbackLastReason = "worker init failed";
  assessment = assessDrawingSoak(sceneFallback);
  assert.equal(assessment.checks.runtimeInvariants.passed, false);

  const recoveredStartupFallback = buildPassingReport();
  for (const sample of recoveredStartupFallback.samples) {
    sample.runtime.sceneFallbackCount = 1;
    sample.runtime.sceneRuntimeFaultCount = 1;
    sample.runtime.sceneFallbackDelta = 0;
    sample.runtime.sceneFallbackLastReason = "startup worker init failed";
  }
  assessment = assessDrawingSoak(recoveredStartupFallback);
  assert.equal(assessment.checks.runtimeInvariants.passed, false);

  const excludedInstrumentationTask = buildPassingReport();
  excludedInstrumentationTask.browserTiming.longTaskCounts = {
    total: 1,
    retained: 1,
    dropped: 0,
    excluded: 1,
    attributable: 0,
  };
  excludedInstrumentationTask.browserTiming.rawLongTasks = [{
    startTime: 1_002,
    duration: 55,
  }];
  assessment = assessDrawingSoak(excludedInstrumentationTask);
  assert.equal(assessment.checks.longTaskAttribution.passed, true);
  assert.equal(assessment.checks.productionHarness.passed, true);

  const drawingLongTask = buildPassingReport();
  drawingLongTask.browserTiming.longTaskCounts = {
    total: 1,
    retained: 1,
    dropped: 0,
    excluded: 0,
    attributable: 1,
  };
  drawingLongTask.browserTiming.rawLongTasks = [{ startTime: 2_000, duration: 75 }];
  drawingLongTask.diagnostics.longTasks.push({ startTime: 2_000, duration: 75 });
  assessment = assessDrawingSoak(drawingLongTask);
  assert.equal(assessment.checks.longTaskAttribution.passed, false);
  assert.equal(assessment.checks.diagnostics.passed, false);

  const inconsistentCounts = buildPassingReport();
  inconsistentCounts.browserTiming.longTaskCounts = {
    total: 2,
    retained: 1,
    dropped: 0,
    excluded: 1,
    attributable: 0,
  };
  inconsistentCounts.browserTiming.rawLongTasks = [{ startTime: 1_002, duration: 55 }];
  assessment = assessDrawingSoak(inconsistentCounts);
  assert.equal(assessment.checks.productionHarness.passed, false);

  const oversizedInstrumentationWindow = buildPassingReport();
  oversizedInstrumentationWindow.browserTiming.instrumentationWindows[0].endTime += 20_000;
  assessment = assessDrawingSoak(oversizedInstrumentationWindow);
  assert.equal(assessment.checks.longTaskAttribution.passed, false);
});

test("external backing and embedder heap evidence is required and leak-gated independently", () => {
  const missing = buildPassingReport();
  delete missing.samples[0].heap.page.backingStorageSize;
  assert.equal(assessDrawingSoak(missing).checks.sampleEvidence.passed, false);

  const leaking = buildPassingReport();
  const applyExternalGrowth = (heap, index) => {
    const backing = 8 * MIB + index * 2 * MIB;
    const embedder = 4 * MIB + index * 2 * MIB;
    heap.aggregateBackingStorageSize = backing;
    heap.page.backingStorageSize = backing - 2 * MIB;
    heap.aggregateEmbedderHeapUsedSize = embedder;
    heap.page.embedderHeapUsedSize = embedder - MIB;
  };
  leaking.samples.forEach((sample, index) => applyExternalGrowth(sample.heap, index));
  leaking.gcCheckpoints.forEach((checkpoint, index) => applyExternalGrowth(checkpoint.after, index));
  const assessment = assessDrawingSoak(leaking);
  assert.equal(assessment.checks.backingStorageNaturalDelta.passed, false);
  assert.equal(assessment.checks.backingStorageRetainedSlope.passed, false);
  assert.equal(assessment.checks.embedderHeapNaturalDelta.passed, false);
  assert.equal(assessment.checks.embedderHeapRetainedSlope.passed, false);
});

test("fixed fixture identity and per-cycle worker attribution fail closed", () => {
  const wrongFixture = buildPassingReport();
  wrongFixture.fixture.rawSha256 = "0".repeat(64);
  assert.equal(assessDrawingSoak(wrongFixture).checks.fixedSceneContract.passed, false);

  const missingWorkerWork = buildPassingReport();
  missingWorkerWork.cycles[0].workerJobCycleDelta = 0;
  missingWorkerWork.cycles[0].workerResultCycleDelta = 0;
  const assessment = assessDrawingSoak(missingWorkerWork);
  assert.equal(assessment.checks.workloadCycles.passed, false);
  assert.equal(assessment.checks.workerWorkload.passed, false);
});

test("Theil-Sen slope remains robust to one heap outlier", () => {
  const samples = [0, 1, 2, 3, 4].map((hour) => ({
    elapsedMs: hour * 3_600_000,
    heap: { aggregateUsedSize: hour === 2 ? 500 * MIB : 100 * MIB + hour * MIB },
  }));

  assert.ok(Math.abs(theilSenSlopeBytesPerHour(samples) - MIB) < 0.001);
});
