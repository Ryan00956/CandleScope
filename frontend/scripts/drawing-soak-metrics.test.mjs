import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDrawingSoak,
  DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT,
  DRAWING_SOAK_DEFAULTS,
  DRAWING_SOAK_FIXED_CONTRACT,
  isFormalDrawingSoakConfiguration,
  normalizeDrawingSoakRuntimeEvidence,
  phase9MeasuredWorkloadDeadline,
  selectPhase9SoakDueAction,
  theilSenSlopeBytesPerHour,
} from "./drawing-soak-metrics.mjs";

const MIB = 1024 * 1024;

test("forces a workload deadline into the measured timing epoch", () => {
  assert.equal(phase9MeasuredWorkloadDeadline(5_003), 5_003);
  assert.equal(selectPhase9SoakDueAction({
    elapsedMs: 6_015,
    nextWorkloadAtMs: 5_003,
    nextSampleAtMs: 6_000,
    nextGcAtMs: 5_000,
  }), "workload");
  assert.equal(selectPhase9SoakDueAction({
    elapsedMs: 6_015,
    nextWorkloadAtMs: 7_003,
    nextSampleAtMs: 6_000,
    nextGcAtMs: 5_000,
  }), "sample");
  assert.throws(
    () => phase9MeasuredWorkloadDeadline(Number.NaN),
    /finite and non-negative/,
  );
  assert.throws(
    () => phase9MeasuredWorkloadDeadline(-1),
    /finite and non-negative/,
  );
});

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

const INPUT_TYPES = ["pointerdown", "pointermove", "pointerup", "wheel"];

function timingMetric({ includeBuckets = false, totalCount = 100 } = {}) {
  return {
    totalCount,
    invalidCount: 0,
    captureObserved: totalCount,
    bucketWidthMs: 16.7,
    histogramMaxMs: 1_000,
    bucketCount: 2,
    overflowCount: 0,
    p50Ms: 16.7,
    p95Ms: 16.7,
    p99Ms: 16.7,
    maxMs: 16.7,
    ...(includeBuckets ? { bucketCounts: [totalCount, 0] } : {}),
  };
}

function browserTiming({ includeBuckets = false, windowDurationMs = 1_000 } = {}) {
  return {
    windowDurationMs,
    refreshRateHz: 1_000 / 16.7,
    inputEvents: INPUT_TYPES.length * 100,
    inputEventCounts: Object.fromEntries(INPUT_TYPES.map((type) => [type, 100])),
    inputPaintFenceStats: Object.fromEntries(INPUT_TYPES.map((type) => [type, {
      eventCount: 100,
      completedEventCount: 100,
      droppedEventCount: 0,
      pendingEventCount: 0,
      frozenEventCount: 0,
      fenceCount: 100,
      coalescedEventCount: 0,
      maxEventsPerFence: 1,
      postRafInputCount: 0,
      inputWhileFrozenCount: 0,
      unattributedEventCount: 0,
      unattributedFenceCount: 0,
      countConservationPassed: true,
    }])),
    inputFenceOverall: {
      eventCount: INPUT_TYPES.length * 100,
      completedEventCount: INPUT_TYPES.length * 100,
      droppedEventCount: 0,
      pendingEventCount: 0,
      frozenEventCount: 0,
      fenceCount: 100,
      typeFenceCount: INPUT_TYPES.length * 100,
      postRafInputCount: 0,
      inputWhileFrozenCount: 0,
      unattributedEventCount: 0,
      unattributedFenceCount: 0,
      frameScheduled: false,
      frozenFenceCount: 0,
      staleFrameCallbackCount: 0,
      stalePostRafTaskCallbackCount: 0,
      countConservationPassed: true,
    },
    inputToNextPaintByType: Object.fromEntries(INPUT_TYPES.map((type) => [
      type,
      timingMetric({ includeBuckets }),
    ])),
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

function slowInputPostRafTaskFences(cycleCount, observedFenceCount = 400) {
  const entries = Array.from({ length: Math.min(64, observedFenceCount) }, (_, index) => {
    const handlerAtMs = 1_000 + index * 20;
    const lastRafAtMs = handlerAtMs - 5;
    const rafAtMs = handlerAtMs + 5;
    const postRafTaskAtMs = handlerAtMs + 16.7 - index * 0.001;
    const eventTimeStampMs = handlerAtMs - 1;
    return {
      fenceId: index + 1,
      cycle: (index % cycleCount) + 1,
      eventType: INPUT_TYPES[index % INPUT_TYPES.length],
      eventCount: 1,
      eventTimeStampMs,
      handlerAtMs,
      lastRafAtMs,
      rafAtMs,
      postRafTaskAtMs,
      eventToHandlerMs: handlerAtMs - eventTimeStampMs,
      handlerToRafMs: rafAtMs - handlerAtMs,
      rafToPostRafTaskMs: postRafTaskAtMs - rafAtMs,
      handlerToPostRafTaskMs: postRafTaskAtMs - handlerAtMs,
      eventToPostRafTaskMs: postRafTaskAtMs - eventTimeStampMs,
      conservativeTotalMs: postRafTaskAtMs - eventTimeStampMs,
    };
  });
  return {
    schemaVersion: "drawing-input-post-raf-task/v2",
    endpoint: "post-rAF-task",
    timestampAggregation: "per-type-cohort-earliest-independent",
    rankingMetric: "conservativeTotalMs",
    capacity: 64,
    observedFenceCount,
    retainedFenceCount: entries.length,
    omittedFenceCount: observedFenceCount - entries.length,
    performanceTimeOriginMs: 1_700_000_000_000,
    countConservationPassed: true,
    entries,
  };
}

function setTypedInputCount(timing, type, totalCount) {
  const includeBuckets = Array.isArray(timing.inputToNextPaintByType[type].bucketCounts);
  timing.inputEventCounts[type] = totalCount;
  Object.assign(timing.inputPaintFenceStats[type], {
    eventCount: totalCount,
    completedEventCount: totalCount,
    fenceCount: totalCount,
    coalescedEventCount: 0,
    maxEventsPerFence: 1,
  });
  timing.inputToNextPaintByType[type] = timingMetric({ includeBuckets, totalCount });
  const inputEvents = INPUT_TYPES.reduce(
    (total, inputType) => total + timing.inputEventCounts[inputType],
    0,
  );
  const typeFenceCount = INPUT_TYPES.reduce(
    (total, inputType) => total + timing.inputPaintFenceStats[inputType].fenceCount,
    0,
  );
  timing.inputEvents = inputEvents;
  timing.inputFenceOverall.eventCount = inputEvents;
  timing.inputFenceOverall.completedEventCount = inputEvents;
  timing.inputFenceOverall.typeFenceCount = typeFenceCount;
}

function eventLatencyMetricFromSamples(samplesMs) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const percentile = (value) => (
    sorted[Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)] ?? null
  );
  return {
    count: samplesMs.length,
    samplesMs: [...samplesMs],
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
  };
}

function eventLatencyMetric(count = 128, valueMs = 16) {
  return eventLatencyMetricFromSamples(Array.from({ length: count }, () => valueMs));
}

function eventLatencyCalibration(report) {
  const dispatchCounts = Object.fromEntries(INPUT_TYPES.map((type) => [type, 128]));
  return {
    schemaVersion: DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.schemaVersion,
    window: DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.window,
    configuration: {
      ...DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.configuration,
      categories: [...DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.configuration.categories],
    },
    provenance: {
      gitCommit: report.context.git.commit,
      buildInputFingerprint: report.context.git.buildInputFingerprint,
      productionBuildVerification: report.environment.productionBuildVerification,
      browserProduct: report.context.browser.version,
      userAgent: report.context.browser.userAgent,
      fixtureRawSha256: report.fixture.rawSha256,
      scenarioId: DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.scenarioId,
      viewport: { ...report.environment.viewport },
      dpr: report.environment.dpr,
      formalWindowEndedAt: "2026-07-16T00:00:00.000Z",
    },
    expectedDispatchCounts: structuredClone(dispatchCounts),
    actualDispatchCounts: structuredClone(dispatchCounts),
    trace: {
      byteLength: MIB,
      chunkCount: 2,
      sha256: "c".repeat(64),
      eventCount: 10_000,
      dataLossOccurred: false,
      maxBufferUsage: 0.25,
    },
    parser: {
      schemaVersion: "drawing-event-latency-trace/v2",
      passed: true,
      failureReasons: [],
      expectedDispatchCounts: structuredClone(dispatchCounts),
      metricSemantics: {
        frameSubmitByType: {
          start: "input-generation",
          end: "next-frame-submit",
          meaning: "documented-input-to-next-paint",
        },
        presentationByType: {
          start: "input-generation",
          end: "physical-presentation",
          meaning: "input-to-physical-presentation",
        },
      },
      eventLatency: {
        beginCount: 512,
        endCount: 512,
        pairedCount: 512,
        presentedPairCount: 512,
        terminationOnlyPairCount: 0,
        partialPresentationPairCount: 0,
      },
      frameSubmitByType: Object.fromEntries(INPUT_TYPES.map((type) => [
        type,
        eventLatencyMetric(),
      ])),
      presentationByType: Object.fromEntries(INPUT_TYPES.map((type) => [
        type,
        eventLatencyMetric(128, 20),
      ])),
      excluded: {
        hover: {
          frameSubmit: eventLatencyMetric(0),
          presentation: eventLatencyMetric(0),
        },
      },
      samples: INPUT_TYPES.flatMap((inputType) => (
        Array.from({ length: 128 }, () => ({
          inputType,
          generationToFrameSubmitMs: 16,
          frameSubmitToPresentationMs: 4,
          generationToPresentationMs: 20,
        }))
      )),
      diagnostics: {
        orphanEnds: [],
        openBegins: [],
        invalidEvents: [],
        nonMonotonicEvents: [],
        unknownTypes: [],
        countMismatches: [],
        orphanSubmitStageEnds: [],
        openSubmitStageBegins: [],
        invalidSubmitStages: [],
        nonMonotonicSubmitStages: [],
        unnestedSubmitStages: [],
        submitStageCardinalityMismatches: [],
        submitStagePresentationMismatches: [],
      },
      eventsInAnimationFrame: {
        supported: true,
        passed: true,
        reason: null,
        frameCount: 256,
        excludedFrameCount: 0,
        presentationByType: {
          pointerdown: eventLatencyMetric(128, 20),
          pointerup: eventLatencyMetric(128, 20),
        },
        mismatches: [],
        schemaErrors: [],
      },
    },
    acquisition: {
      passed: true,
      attemptCount: 1,
      startedAt: "2026-07-16T00:00:01.000Z",
      completedAt: "2026-07-16T00:00:02.000Z",
      failureReason: null,
    },
    attempts: [{
      attempt: 1,
      passed: true,
      startedAt: "2026-07-16T00:00:01.000Z",
      completedAt: "2026-07-16T00:00:02.000Z",
      failureReason: null,
    }],
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
  const cycleCount = Math.floor(
    (configuration.durationMs - configuration.warmupMs) / configuration.workloadIntervalMs,
  );
  finalBrowserTiming.slowInputPostRafTaskFences = slowInputPostRafTaskFences(cycleCount);
  const report = {
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
      viewport: { width: 1440, height: 900 },
      dpr: 1.5,
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
      browser: {
        name: "Chromium/150.0.0.0",
        version: "Chromium/150.0.0.0",
        userAgent: "Mozilla/5.0 test Chromium/150.0.0.0",
      },
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
      length: cycleCount,
    }, (_, index) => {
      const viewportRevision = index + 10;
      return {
        cycle: index + 1,
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
  report.eventLatencyCalibration = eventLatencyCalibration(report);
  return report;
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

test("locks the post-soak EventLatency calibration contract and exposes its summary", () => {
  assert.deepEqual(DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT, {
    schemaVersion: "drawing-event-latency-calibration/v1",
    window: "post-formal-soak",
    scenarioId: "phase6-freehand64-zoom-pan",
    inputTypes: ["pointerdown", "pointermove", "pointerup", "wheel"],
    configuration: {
      dispatchesPerType: 128,
      maxAttempts: 2,
      settleFramesPerInput: 6,
      p95ThresholdMs: 20,
      p99ThresholdMs: 33,
      p95MinimumSamples: 20,
      p99MinimumSamples: 100,
      maxTraceBytes: 64 * MIB,
      categories: ["input", "latency"],
    },
  });

  const assessment = assessDrawingSoak(buildPassingReport());
  assert.equal(assessment.checks.eventLatencyCalibration.passed, true);
  assert.equal(assessment.summary.eventLatencyCalibration.trace.passed, true);
  assert.equal(
    assessment.summary.eventLatencyCalibration.parser.frameSubmitByType.wheel.count,
    128,
  );
  assert.equal(
    assessment.summary.eventLatencyCalibration.parser.eventsInAnimationFrame.pointerupCount,
    128,
  );
});

test("EventLatency calibration is mandatory for both smoke and formal acceptance", () => {
  const smoke = buildPassingReport();
  delete smoke.eventLatencyCalibration;
  let assessment = assessDrawingSoak(smoke);
  assert.equal(assessment.checks.eventLatencyCalibration.passed, false);
  assert.equal(assessment.smokeAcceptance.passed, false);
  assert.ok(assessment.failureReasons.includes("eventLatencyCalibration"));

  const formal = buildPassingReport({ configuration: DRAWING_SOAK_DEFAULTS });
  delete formal.eventLatencyCalibration;
  assessment = assessDrawingSoak(formal);
  assert.equal(assessment.formalEligible, true);
  assert.equal(assessment.formalAcceptance.passed, false);
  assert.ok(assessment.failureReasons.includes("eventLatencyCalibration"));
});

test("EventLatency calibration fails closed on counts, SLO, cross-check, provenance, or trace loss", () => {
  const cases = [
    ["configuration", (calibration) => calibration.configuration.categories.reverse()],
    ["settle frames", (calibration) => { calibration.configuration.settleFramesPerInput = 5; }],
    ["expected count", (calibration) => {
      calibration.expectedDispatchCounts.pointermove = 127;
    }],
    ["actual count", (calibration) => {
      calibration.actualDispatchCounts.wheel = 127;
    }],
    ["parser count", (calibration) => {
      calibration.parser.frameSubmitByType.pointerup.count = 127;
      calibration.parser.frameSubmitByType.pointerup.samplesMs.pop();
    }],
    ["metric semantics", (calibration) => {
      calibration.parser.metricSemantics.frameSubmitByType.end = "physical-presentation";
    }],
    ["frame-submit summary", (calibration) => {
      Object.assign(calibration.parser.frameSubmitByType.wheel, eventLatencyMetric(128, 15));
    }],
    ["presentation summary", (calibration) => {
      Object.assign(calibration.parser.presentationByType.wheel, eventLatencyMetric(128, 19));
    }],
    ["segment conservation", (calibration) => {
      calibration.parser.samples[0].frameSubmitToPresentationMs = 3;
    }],
    ["p95 threshold", (calibration) => {
      calibration.parser.samples
        .filter((sample) => sample.inputType === "wheel")
        .forEach((sample) => {
          sample.generationToFrameSubmitMs = 20.1;
          sample.generationToPresentationMs = 24.1;
        });
      Object.assign(calibration.parser.frameSubmitByType.wheel, eventLatencyMetric(128, 20.1));
      Object.assign(calibration.parser.presentationByType.wheel, eventLatencyMetric(128, 24.1));
    }],
    ["p99 threshold", (calibration) => {
      const frameSubmitMetric = calibration.parser.frameSubmitByType.pointermove;
      const presentationMetric = calibration.parser.presentationByType.pointermove;
      const samples = calibration.parser.samples
        .filter((sample) => sample.inputType === "pointermove");
      samples.slice(-2).forEach((sample) => {
        sample.generationToFrameSubmitMs = 33.1;
        sample.generationToPresentationMs = 37.1;
      });
      frameSubmitMetric.samplesMs = Array.from({ length: 128 }, (_, index) => (
        index >= 126 ? 33.1 : 16
      ));
      frameSubmitMetric.p50Ms = 16;
      frameSubmitMetric.p95Ms = 16;
      frameSubmitMetric.p99Ms = 33.1;
      presentationMetric.samplesMs = Array.from({ length: 128 }, (_, index) => (
        index >= 126 ? 37.1 : 20
      ));
      presentationMetric.p50Ms = 20;
      presentationMetric.p95Ms = 20;
      presentationMetric.p99Ms = 37.1;
    }],
    ["cross-check unsupported", (calibration) => {
      calibration.parser.eventsInAnimationFrame.supported = false;
      calibration.parser.eventsInAnimationFrame.passed = null;
      calibration.parser.eventsInAnimationFrame.reason = "schema absent";
    }],
    ["cross-check count", (calibration) => {
      const metric = calibration.parser.eventsInAnimationFrame.presentationByType.pointerdown;
      metric.count = 127;
      metric.samplesMs.pop();
    }],
    ["cross-check values", (calibration) => {
      Object.assign(
        calibration.parser.eventsInAnimationFrame.presentationByType.pointerdown,
        eventLatencyMetric(128, 15),
      );
    }],
    ["provenance", (calibration) => {
      calibration.provenance.buildInputFingerprint = "d".repeat(64);
    }],
    ["browser provenance", (calibration) => {
      calibration.provenance.browserProduct = "Chromium/149.0.0.0";
    }],
    ["build provenance", (calibration) => {
      calibration.provenance.productionBuildVerification = "external-preview";
    }],
    ["fixture provenance", (calibration) => {
      calibration.provenance.fixtureRawSha256 = "e".repeat(64);
    }],
    ["viewport provenance", (calibration) => {
      calibration.provenance.viewport.width = 1439;
    }],
    ["DPR provenance", (calibration) => {
      calibration.provenance.dpr = 2;
    }],
    ["window ordering", (calibration) => {
      calibration.provenance.formalWindowEndedAt = "2026-07-16T00:00:01.500Z";
    }],
    ["data loss", (calibration) => {
      calibration.trace.dataLossOccurred = true;
    }],
    ["trace size", (calibration) => {
      calibration.trace.byteLength = 64 * MIB + 1;
    }],
    ["trace hash", (calibration) => {
      calibration.trace.sha256 = "not-a-hash";
    }],
    ["trace event count", (calibration) => {
      calibration.trace.eventCount = 0;
    }],
    ["trace chunks", (calibration) => {
      calibration.trace.chunkCount = 0;
    }],
    ["trace buffer usage", (calibration) => {
      calibration.trace.maxBufferUsage = 1.01;
    }],
    ["parser diagnostics", (calibration) => {
      calibration.parser.diagnostics.orphanEnds.push({ eventIndex: 1 });
    }],
    ["excluded hover", (calibration) => {
      Object.assign(calibration.parser.excluded.hover.presentation, eventLatencyMetric(1));
    }],
  ];
  for (const [label, mutate] of cases) {
    const report = buildPassingReport();
    mutate(report.eventLatencyCalibration);
    const assessment = assessDrawingSoak(report);
    assert.equal(assessment.checks.eventLatencyCalibration.passed, false, label);
    assert.equal(assessment.smokeAcceptance.passed, false, label);
  }
});

test("EventLatency frame-submit SLO is recomputed from raw segments despite forged summaries", () => {
  const report = buildPassingReport();
  report.eventLatencyCalibration.parser.samples
    .filter((sample) => sample.inputType === "pointerup")
    .forEach((sample) => {
      sample.generationToFrameSubmitMs = 40;
      sample.generationToPresentationMs = 44;
    });

  const assessment = assessDrawingSoak(report);
  const summary = assessment.summary.eventLatencyCalibration.parser;
  assert.equal(assessment.checks.eventLatencyCalibration.passed, false);
  assert.equal(summary.frameSubmitByType.pointerup.p95Ms, 40);
  assert.equal(summary.frameSubmitByType.pointerup.p99Ms, 40);
  assert.equal(summary.frameSubmitByType.pointerup.p95Passed, false);
});

test("EventLatency presentation latency is diagnostic while EIAF compares its sample multiset", () => {
  const report = buildPassingReport();
  const wheelSamples = report.eventLatencyCalibration.parser.samples
    .filter((sample) => sample.inputType === "wheel");
  for (const sample of wheelSamples) {
    sample.frameSubmitToPresentationMs = 84;
    sample.generationToPresentationMs = 100;
  }
  report.eventLatencyCalibration.parser.presentationByType.wheel = eventLatencyMetric(128, 100);

  let assessment = assessDrawingSoak(report);
  assert.equal(assessment.checks.eventLatencyCalibration.passed, true);
  assert.equal(
    assessment.summary.eventLatencyCalibration.parser.presentationByType.wheel.p99Ms,
    100,
  );

  const pointerdownSamples = report.eventLatencyCalibration.parser.samples
    .filter((sample) => sample.inputType === "pointerdown");
  pointerdownSamples.forEach((sample, index) => {
    sample.frameSubmitToPresentationMs = index;
    sample.generationToPresentationMs = 16 + index;
  });
  const presentationSamples = pointerdownSamples.map(
    (sample) => sample.generationToPresentationMs,
  );
  report.eventLatencyCalibration.parser.presentationByType.pointerdown =
    eventLatencyMetricFromSamples(presentationSamples);
  report.eventLatencyCalibration.parser.eventsInAnimationFrame.presentationByType.pointerdown =
    eventLatencyMetricFromSamples([...presentationSamples].reverse());

  assessment = assessDrawingSoak(report);
  assert.equal(assessment.checks.eventLatencyCalibration.passed, true);
  assert.equal(
    assessment.summary.eventLatencyCalibration.parser.eventsInAnimationFrame.passed,
    true,
  );
});

test("EventLatency acquisition attempts are bounded, ordered, and end in success", () => {
  const retried = buildPassingReport();
  retried.eventLatencyCalibration.acquisition.attemptCount = 2;
  retried.eventLatencyCalibration.acquisition.startedAt = "2026-07-16T00:00:00.500Z";
  retried.eventLatencyCalibration.attempts = [{
    attempt: 1,
    passed: false,
    startedAt: "2026-07-16T00:00:00.500Z",
    completedAt: "2026-07-16T00:00:00.750Z",
    failureReason: "technical: trace buffer pressure",
  }, {
    attempt: 2,
    passed: true,
    startedAt: "2026-07-16T00:00:01.000Z",
    completedAt: "2026-07-16T00:00:02.000Z",
    failureReason: null,
  }];
  assert.equal(
    assessDrawingSoak(retried).checks.eventLatencyCalibration.passed,
    true,
  );

  const malformed = buildPassingReport();
  malformed.eventLatencyCalibration.acquisition.attemptCount = 2;
  malformed.eventLatencyCalibration.attempts.push({
    attempt: 2,
    passed: true,
    startedAt: "2026-07-16T00:00:01.500Z",
    completedAt: "2026-07-16T00:00:02.000Z",
    failureReason: null,
  });
  assert.equal(
    assessDrawingSoak(malformed).checks.eventLatencyCalibration.passed,
    false,
  );

  const thresholdRetry = buildPassingReport();
  thresholdRetry.eventLatencyCalibration.acquisition.attemptCount = 2;
  thresholdRetry.eventLatencyCalibration.acquisition.startedAt = "2026-07-16T00:00:00.500Z";
  thresholdRetry.eventLatencyCalibration.attempts = [{
    attempt: 1,
    passed: false,
    startedAt: "2026-07-16T00:00:00.500Z",
    completedAt: "2026-07-16T00:00:00.750Z",
    failureReason: "threshold: p95 exceeded",
  }, {
    attempt: 2,
    passed: true,
    startedAt: "2026-07-16T00:00:01.000Z",
    completedAt: "2026-07-16T00:00:02.000Z",
    failureReason: null,
  }];
  assert.equal(
    assessDrawingSoak(thresholdRetry).checks.eventLatencyCalibration.passed,
    false,
  );
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

  const emptyMeasuredInput = buildPassingReport();
  const firstTiming = emptyMeasuredInput.samples[0].browserTiming;
  firstTiming.inputEvents = 0;
  for (const key of ["inputToNextPaintMs", "eventTimingMs", "mouseupSyncMs"]) {
    firstTiming.captureStats[key].observed = 0;
    Object.assign(firstTiming.metrics[key], {
      captureObserved: 0,
      totalCount: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
    });
  }
  assert.equal(assessDrawingSoak(emptyMeasuredInput).checks.sampleEvidence.passed, false);

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

test("typed input latency uses fail-closed nearest-rank sample eligibility", () => {
  const cases = [
    [19, false, false, false],
    [20, true, false, false],
    [99, true, false, false],
    [100, true, true, true],
  ];
  for (const [sampleCount, p95Eligible, p99Eligible, passed] of cases) {
    const report = buildPassingReport();
    setTypedInputCount(report.browserTiming, "pointerup", sampleCount);
    const actual = assessDrawingSoak(report).checks.inputFrameLatencyByType.actual.pointerup;
    assert.equal(actual.sampleCount, sampleCount);
    assert.equal(actual.eligibility.p95, p95Eligible);
    assert.equal(actual.eligibility.p99, p99Eligible);
    assert.equal(actual.passed, passed);
  }
});

test("typed input latency rejects an over-SLO type and per-type progress regression", () => {
  const overSlo = buildPassingReport();
  Object.assign(overSlo.browserTiming.inputToNextPaintByType.wheel, {
    bucketWidthMs: 20.1,
    p50Ms: 20.1,
    p95Ms: 20.1,
    p99Ms: 20.1,
    maxMs: 20.1,
  });
  let assessment = assessDrawingSoak(overSlo);
  assert.equal(assessment.checks.inputFrameLatencyByType.actual.wheel.p95Passed, false);
  assert.equal(assessment.checks.inputFrameLatencyByType.passed, false);

  const regressed = buildPassingReport();
  setTypedInputCount(regressed.samples[2].browserTiming, "wheel", 99);
  assessment = assessDrawingSoak(regressed);
  assert.equal(assessment.checks.sampleEvidence.passed, true);
  assert.equal(assessment.checks.browserTimingProgress.passed, false);
});

test("slow post-rAF-task evidence rejects unknown cycles, bad diagnostics, order, and capacity", () => {
  const noPreviousRaf = buildPassingReport();
  noPreviousRaf.browserTiming.slowInputPostRafTaskFences.entries[0].lastRafAtMs = null;
  assert.equal(
    assessDrawingSoak(noPreviousRaf).checks.inputPaintFenceEvidence.passed,
    true,
  );

  const cases = [
    ["unknown cycle", (trace) => { trace.entries[0].cycle = 999; }],
    ["bad delta", (trace) => { trace.entries[0].handlerToRafMs += 0.1; }],
    ["bad event delay", (trace) => { trace.entries[0].eventToHandlerMs += 0.1; }],
    ["bad conservative total", (trace) => { trace.entries[0].conservativeTotalMs += 0.1; }],
    ["wrong order", (trace) => {
      [trace.entries[0], trace.entries[1]] = [trace.entries[1], trace.entries[0]];
    }],
    ["wrong endpoint", (trace) => { trace.endpoint = "paint"; }],
    ["wrong aggregation", (trace) => { trace.timestampAggregation = "coupled"; }],
    ["wrong ranking metric", (trace) => { trace.rankingMetric = "handlerToPostRafTaskMs"; }],
    ["wrong capacity", (trace) => { trace.capacity = 65; }],
  ];
  for (const [label, mutate] of cases) {
    const report = buildPassingReport();
    mutate(report.browserTiming.slowInputPostRafTaskFences);
    assert.equal(
      assessDrawingSoak(report).checks.inputPaintFenceEvidence.passed,
      false,
      label,
    );
  }
});

test("typed fence accounting fails closed on missing fields and post-rAF contamination", () => {
  const missing = buildPassingReport();
  delete missing.samples[0].browserTiming.inputEventCounts.pointermove;
  assert.equal(assessDrawingSoak(missing).checks.sampleEvidence.passed, false);

  const contaminated = buildPassingReport();
  contaminated.browserTiming.inputPaintFenceStats.wheel.postRafInputCount = 1;
  contaminated.browserTiming.inputFenceOverall.postRafInputCount = 1;
  assert.equal(assessDrawingSoak(contaminated).checks.inputFrameLatencyByType.passed, false);

  const unattributed = buildPassingReport();
  unattributed.browserTiming.inputPaintFenceStats.pointerdown.unattributedEventCount = 1;
  unattributed.browserTiming.inputPaintFenceStats.pointerdown.unattributedFenceCount = 1;
  unattributed.browserTiming.inputFenceOverall.unattributedEventCount = 1;
  unattributed.browserTiming.inputFenceOverall.unattributedFenceCount = 1;
  assert.equal(assessDrawingSoak(unattributed).checks.inputFrameLatencyByType.passed, false);
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
