import assert from "node:assert/strict";
import test from "node:test";

import {
  phase6ActionRequiresCurrentPaint,
  phase6BrowserProbeBootstrap,
  phase6SceneReadiness,
  waitForPhase6ActionCurrentPaint,
} from "./drawing-performance-phase6-browser.mjs";

test("Phase 6 scene readiness accepts a stable non-freehand scene without fake point gauges", () => {
  const stable = {
    scenePublicationReady: true,
    attachedPrimitiveCount: 1,
    stampCurrent: true,
    backend: "main-thread",
    rawPoints: 0,
    renderedPoints: 0,
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
  };
  assert.equal(phase6SceneReadiness(stable, { expectedRawPoints: 0 }), true);
  assert.equal(phase6SceneReadiness(stable, { expectedRawPoints: 32_768 }), false);
  assert.equal(phase6SceneReadiness(stable, { expectedRawPoints: 0, requireWorker: true }), false);
  assert.equal(phase6SceneReadiness({ ...stable, stampCurrent: false }), false);
});

function withWindow(value, callback) {
  const previous = globalThis.window;
  globalThis.window = value;
  return Promise.resolve(callback()).finally(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test("Phase 6 browser probe fails closed without the drawing perf handle", async () => {
  await withWindow({}, () => {
    assert.deepEqual(phase6BrowserProbeBootstrap(), {
      started: false,
      reason: "drawing-perf-handle-missing",
    });
  });
});

test("Phase 6 runner waits for viewport, backpressure, and main-thread fallback current paints", async () => {
  assert.equal(phase6ActionRequiresCurrentPaint("phase6-viewport"), true);
  assert.equal(phase6ActionRequiresCurrentPaint("phase6-worker-backpressure"), true);
  assert.equal(phase6ActionRequiresCurrentPaint("phase6-main-thread-fallback"), true);
  assert.equal(phase6ActionRequiresCurrentPaint("phase6-hit-index"), false);

  let calls = 0;
  const skipped = await waitForPhase6ActionCurrentPaint({
    action: "phase6-hit-index",
    previousStamp: null,
    timeoutMs: 50_000,
    waitForCurrentPaint: async () => {
      calls += 1;
      return { passed: true };
    },
  });
  assert.deepEqual(skipped, { required: false, result: null });
  assert.equal(calls, 0);
});

test("Phase 6 runner forwards the pre-action stamp and bounds the current-paint wait", async () => {
  const previousStamp = { scopeKey: "scope", viewportRevision: 2 };
  const paintedStamp = { scopeKey: "scope", viewportRevision: 3 };
  const calls = [];
  const waited = await waitForPhase6ActionCurrentPaint({
    action: "phase6-main-thread-fallback",
    previousStamp,
    timeoutMs: 45_000,
    waitForCurrentPaint: async (...args) => {
      calls.push(args);
      return {
        passed: true,
        previousStamp,
        requestedStamp: paintedStamp,
        paintedStamp,
      };
    },
  });
  assert.deepEqual(calls, [[previousStamp, 10_000]]);
  assert.equal(waited.required, true);
  assert.equal(waited.result.passed, true);
  assert.deepEqual(waited.result.paintedStamp, paintedStamp);
});

test("Phase 6 runner fails closed for a missing baseline or current-paint timeout", async () => {
  await assert.rejects(
    waitForPhase6ActionCurrentPaint({
      action: "phase6-viewport",
      previousStamp: null,
      timeoutMs: 100,
      waitForCurrentPaint: async () => ({ passed: true }),
    }),
    /baseline stamp is missing/,
  );
  await assert.rejects(
    waitForPhase6ActionCurrentPaint({
      action: "phase6-main-thread-fallback",
      previousStamp: { scopeKey: "scope", viewportRevision: 2 },
      timeoutMs: 100,
      waitForCurrentPaint: async () => ({
        passed: false,
        reason: "phase6-current-plan-paint-timeout",
      }),
    }),
    /did not reach a quiescent current paint.*phase6-current-plan-paint-timeout/,
  );
});

test("Phase 6 browser probe normalizes real counters, runtime, and stamp evidence", async () => {
  let counters = {
    workerJobCount: 2,
    workerResultCount: 1,
    workerQueueDropCount: 0,
    staleWorkerResultCount: 0,
    staleWorkerPublishCount: 0,
    anchorResolveCount: 4,
    finalProjectionCount: 8,
  };
  const phase6 = {
    backend: "worker",
    backendSource: "configured-worker",
    workerResultDelayMs: 96,
    sourceLineageExactResolveCount: 64,
    sourceLineageFallbackResolveCount: 0,
    sourceLineageUnresolvedResolveCount: 0,
    offscreenSupported: true,
    queueDepthMax: 2,
    inFlightMax: 1,
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    rawPoints: 32_768,
    renderedPoints: 4_096,
    lodRatio: 0.125,
    canonicalRawPreserved: true,
    vertexBudgetPassed: true,
    stalePublishCount: 0,
    lastRequestedStamp: { scopeKey: "scope", documentRevision: 2 },
    lastPublishedStamp: { scopeKey: "scope", documentRevision: 2 },
  };
  const handle = {
    report: () => ({
      counters,
      counterMaxima: counters,
      gauges: { workerQueue: 1, workerInFlight: 1, rawPoints: phase6.rawPoints,
        renderedPoints: phase6.renderedPoints, lodRatio: phase6.lodRatio },
      gaugeMaxima: { workerQueue: 2, workerInFlight: 1, rawPoints: phase6.rawPoints,
        renderedPoints: phase6.renderedPoints, cacheBytes: 1024 },
    }),
    readRuntimeSummary: () => ({
      effectiveEngineMode: "scene-canary",
      scenePublicationReady: true,
      attachedPrimitiveCount: 1,
    }),
    readPhase6Runtime: () => phase6,
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {},
  }, async () => {
    const started = phase6BrowserProbeBootstrap();
    assert.equal(started.started, true);
    const previousStamp = phase6.lastRequestedStamp;
    phase6.rawPoints = 32_768;
    phase6.renderedPoints = 32_768;
    phase6.lodRatio = 1;
    phase6.canonicalRawPreserved = false;
    phase6.vertexBudgetPassed = false;
    phase6.lastRequestedStamp = { scopeKey: "scope", documentRevision: 3 };
    phase6.lastPublishedStamp = { scopeKey: "scope", documentRevision: 3 };
    counters = {
      ...counters,
      workerJobCount: 5,
      workerResultCount: 4,
      workerQueueDropCount: 2,
      staleWorkerResultCount: 1,
      anchorResolveCount: 4,
      finalProjectionCount: 20,
    };
    const painted = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForCurrentPaint(previousStamp, 50);
    assert.equal(painted.passed, true);
    assert.deepEqual(painted.requestedStamp, phase6.lastRequestedStamp);
    const stopped = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.stop();
    assert.equal(stopped.runtime.engineMode, "scene-canary");
    assert.equal(stopped.runtime.workerJobDelta, 3);
    assert.equal(stopped.runtime.workerResultDelta, 3);
    assert.equal(stopped.runtime.pendingDropDelta, 2);
    assert.equal(stopped.runtime.staleResultDropDelta, 1);
    assert.equal(stopped.runtime.anchorResolveDelta, 0);
    assert.equal(stopped.runtime.finalProjectionDelta, 12);
    assert.equal(stopped.runtime.queueDepthMax, 2);
    assert.equal(stopped.runtime.queueDepthCurrent, 0);
    assert.equal(stopped.runtime.inFlightCurrent, 0);
    assert.equal(stopped.runtime.rawPointsMax, 32_768);
    assert.equal(stopped.runtime.renderedPointsMax, 32_768);
    assert.equal(stopped.runtime.lodRatio, 1);
    assert.equal(stopped.runtime.lodObservationPhase, "final");
    assert.equal(stopped.runtime.initialRawPoints, 32_768);
    assert.equal(stopped.runtime.initialRenderedPoints, 4_096);
    assert.equal(stopped.runtime.initialLodRatio, 0.125);
    assert.equal(stopped.runtime.finalRawPoints, 32_768);
    assert.equal(stopped.runtime.finalRenderedPoints, 32_768);
    assert.equal(stopped.runtime.finalLodRatio, 1);
    assert.equal(stopped.runtime.canonicalRawPreserved, false);
    assert.equal(stopped.runtime.vertexBudgetPassed, false);
    assert.equal(stopped.runtime.backendSource, "configured-worker");
    assert.equal(stopped.runtime.workerResultDelayMs, 96);
    assert.equal(stopped.runtime.sourceLineageExactResolveCount, 64);
    assert.equal(stopped.runtime.sourceLineageFallbackResolveCount, 0);
    assert.deepEqual(stopped.runtime.lastPaintedStamp, phase6.lastPublishedStamp);

    phase6.rawPoints = 32_768;
    phase6.renderedPoints = 4_096;
    phase6.lodRatio = 0.125;
    phase6.canonicalRawPreserved = true;
    phase6.vertexBudgetPassed = true;
    const activeStarted = phase6BrowserProbeBootstrap();
    assert.equal(activeStarted.started, true);
    phase6.rawPoints = 757;
    phase6.renderedPoints = 757;
    phase6.lodRatio = 1;
    const activeStopped = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.stop();
    assert.equal(activeStopped.runtime.rawPointsMax, 32_768);
    assert.equal(activeStopped.runtime.renderedPointsMax, 4_096);
    assert.equal(activeStopped.runtime.lodRatio, 0.125);
    assert.equal(activeStopped.runtime.lodObservationPhase, "initial");
    assert.equal(activeStopped.runtime.finalRawPoints, 757);
    assert.equal(activeStopped.runtime.finalRenderedPoints, 757);
    assert.equal(activeStopped.runtime.finalLodRatio, 1);
    assert.equal(activeStopped.runtime.canonicalRawPreserved, true);
    assert.equal(activeStopped.runtime.vertexBudgetPassed, true);

    const missingStarted = phase6BrowserProbeBootstrap();
    assert.equal(missingStarted.started, true);
    delete phase6.rawPoints;
    delete phase6.renderedPoints;
    delete phase6.lodRatio;
    delete phase6.canonicalRawPreserved;
    delete phase6.vertexBudgetPassed;
    const missingStopped = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.stop();
    assert.equal(missingStopped.runtime.finalRawPoints, null);
    assert.equal(missingStopped.runtime.finalRenderedPoints, null);
    assert.equal(missingStopped.runtime.finalLodRatio, null);
    assert.equal(missingStopped.runtime.canonicalRawPreserved, null);
    assert.equal(missingStopped.runtime.vertexBudgetPassed, null);
  });
});

test("Phase 6 browser probe waits through superseded paints for the latest requested stamp", async () => {
  const revision = (viewportRevision) => ({ scopeKey: "scope", viewportRevision });
  const phase6 = {
    lastRequestedStamp: revision(1),
    lastPublishedStamp: revision(1),
  };
  const handle = {
    report: () => ({ counters: {}, counterMaxima: {}, gauges: {}, gaugeMaxima: {} }),
    readRuntimeSummary: () => ({}),
    readPhase6Runtime: () => phase6,
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {},
  }, async () => {
    phase6BrowserProbeBootstrap();
    const previousStamp = phase6.lastRequestedStamp;
    const waiting = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForCurrentPaint(previousStamp, 250);
    phase6.lastRequestedStamp = revision(2);
    phase6.lastPublishedStamp = null;
    setTimeout(() => {
      phase6.lastRequestedStamp = revision(3);
      phase6.lastPublishedStamp = revision(2);
    }, 5);
    setTimeout(() => {
      phase6.lastPublishedStamp = revision(3);
    }, 30);
    const painted = await waiting;
    assert.equal(painted.passed, true);
    assert.deepEqual(painted.previousStamp, revision(1));
    assert.deepEqual(painted.requestedStamp, revision(3));
    assert.deepEqual(painted.paintedStamp, revision(3));
  });
});

test("Phase 6 browser probe times out while the current requested stamp is unpainted", async () => {
  const revision = (viewportRevision) => ({ scopeKey: "scope", viewportRevision });
  const phase6 = {
    lastRequestedStamp: revision(1),
    lastPublishedStamp: revision(1),
  };
  const handle = {
    report: () => ({ counters: {}, counterMaxima: {}, gauges: {}, gaugeMaxima: {} }),
    readRuntimeSummary: () => ({}),
    readPhase6Runtime: () => phase6,
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {},
  }, async () => {
    phase6BrowserProbeBootstrap();
    const previousStamp = phase6.lastRequestedStamp;
    phase6.lastRequestedStamp = revision(2);
    phase6.lastPublishedStamp = revision(1);
    const painted = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForCurrentPaint(previousStamp, 20);
    assert.equal(painted.passed, false);
    assert.equal(painted.reason, "phase6-current-plan-paint-timeout");
    assert.deepEqual(painted.requestedStamp, revision(2));
    assert.deepEqual(painted.paintedStamp, revision(1));
  });
});

test("Phase 6 browser probe derives hit oracle mismatches instead of trusting a claimed zero", async () => {
  const handle = {
    report: () => ({ counters: {}, counterMaxima: {}, gauges: {}, gaugeMaxima: {} }),
    readRuntimeSummary: () => ({}),
    readPhase6Runtime: () => ({
      lastRequestedStamp: { scopeKey: "scope", documentRevision: 4 },
      lastPublishedStamp: { scopeKey: "scope", documentRevision: 4 },
    }),
    runPhase6HitOracle: async (points) => ({
      queryCount: points.length,
      mismatchCount: 0,
      positiveHitCount: 99,
      maxCandidates: 4,
      totalSegments: 20,
      indexedResults: [{ entityId: "a" }, { entityId: "wrong" }],
      oracleResults: [{ entityId: "a" }, { entityId: "b" }],
    }),
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {},
  }, async () => {
    phase6BrowserProbeBootstrap();
    const oracle = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.runHitOracle([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    assert.equal(oracle.supported, true);
    assert.equal(oracle.queryCount, 2);
    assert.equal(oracle.mismatchCount, 1);
    assert.equal(oracle.positiveHitCount, 2);
    assert.equal(oracle.candidateCoverageCount, 1);
    assert.equal(oracle.maxCandidates, 4);
    assert.equal(oracle.currentPainted, true);
    assert.deepEqual(oracle.queriedStamp, { scopeKey: "scope", documentRevision: 4 });
  });
});

test("Phase 6 browser probe records missing oracle and forced fallback explicitly", async () => {
  const handle = {
    report: () => ({ counters: {}, counterMaxima: {}, gauges: {}, gaugeMaxima: {} }),
    readRuntimeSummary: () => ({}),
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {
      phase6ForceMainThreadFallback: true,
      phase6WorkerDelayMs: 96,
    },
  }, async () => {
    const started = phase6BrowserProbeBootstrap();
    assert.equal(started.fallbackRequested, true);
    assert.equal(started.backpressureDelayMs, 96);
    const oracle = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.runHitOracle([
      { x: 1, y: 2 },
    ]);
    assert.equal(oracle.supported, false);
    assert.equal(oracle.positiveHitCount, 0);
    assert.equal(oracle.candidateCoverageCount, 0);
    const stopped = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.stop();
    assert.equal(stopped.fallbackRequested, true);
  });
});
