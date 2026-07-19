import assert from "node:assert/strict";
import test from "node:test";

import {
  phase6ActionRequiresCurrentPaint,
  phase6ActionRequiresWorkerDrain,
  phase6BrowserProbeBootstrap,
  phase6LatestWorkerPaintConverged,
  phase6SceneReadiness,
  waitForPhase6ActionCurrentPaint,
  waitForPhase6ActionWorkerDrain,
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

function workerIdentity(jobId, stamp) {
  return {
    schemaVersion: 1,
    jobId,
    generation: jobId,
    stamp: { ...stamp },
  };
}

function paintReceipt(stamp, paintSequence = 1) {
  return {
    kind: "drawing-scene-bridge-paint-ack",
    observedAt: "2026-07-16T08:00:00.000Z",
    stamp: { ...stamp },
    attachmentRevision: 1,
    paintSequence,
  };
}

function runtimeStamp(overrides = {}) {
  return {
    scopeKey: "scope",
    documentRevision: 2,
    surfaceGeneration: 3,
    dataRevision: 5,
    projectionRevision: 7,
    lineageIndexRevision: 11,
    viewportRevision: 13,
    themeRevision: 17,
    widthCssPx: 996,
    heightCssPx: 764,
    dpr: 1.5,
    ...overrides,
  };
}

function convergedWorkerRuntime(overrides = {}) {
  const currentStamp = runtimeStamp();
  const identity = workerIdentity(8, currentStamp);
  return {
    backend: "worker",
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    workerResultDelta: 1,
    lastRequestedStamp: currentStamp,
    lastPublishedStamp: currentStamp,
    lastPaintedStamp: currentStamp,
    latestSubmittedWorkerIdentity: identity,
    publishedWorkerIdentity: identity,
    paintedWorkerIdentity: identity,
    paintReceipt: paintReceipt(currentStamp, 9),
    ...overrides,
  };
}

test("Phase 6 latest-worker convergence binds drain, publication, and exact paint identity", () => {
  const currentStamp = runtimeStamp();
  const converged = convergedWorkerRuntime();
  assert.equal(phase6LatestWorkerPaintConverged(converged), true);
  for (const mutation of [
    { queueDepthCurrent: 1 },
    { inFlightCurrent: 1 },
    { workerResultDelta: 0 },
    { workerResultDelta: 0.5 },
    { backend: "main-thread" },
    { publishedWorkerIdentity: workerIdentity(7, currentStamp) },
    { paintedWorkerIdentity: workerIdentity(7, currentStamp) },
    { lastPaintedStamp: runtimeStamp({ viewportRevision: 99 }) },
    { paintReceipt: paintReceipt(runtimeStamp({ viewportRevision: 99 }), 10) },
  ]) {
    assert.equal(phase6LatestWorkerPaintConverged({ ...converged, ...mutation }), false);
  }
});

test("Phase 6 latest-worker convergence rejects equal but malformed schema evidence", () => {
  const malformedStamps = [
    {},
    runtimeStamp({ scopeKey: "" }),
    runtimeStamp({ documentRevision: -1 }),
    runtimeStamp({ viewportRevision: Number.MAX_SAFE_INTEGER + 1 }),
    runtimeStamp({ widthCssPx: 0 }),
    runtimeStamp({ dpr: Number.NaN }),
  ];
  for (const malformedStamp of malformedStamps) {
    const identity = workerIdentity(8, malformedStamp);
    assert.equal(phase6LatestWorkerPaintConverged(convergedWorkerRuntime({
      lastRequestedStamp: malformedStamp,
      lastPublishedStamp: malformedStamp,
      lastPaintedStamp: malformedStamp,
      latestSubmittedWorkerIdentity: identity,
      publishedWorkerIdentity: identity,
      paintedWorkerIdentity: identity,
      paintReceipt: paintReceipt(malformedStamp, 9),
    })), false);
  }

  const currentStamp = runtimeStamp();
  for (const malformedIdentity of [
    {},
    { schemaVersion: 0, jobId: 8, generation: 8, stamp: currentStamp },
    { schemaVersion: 2, jobId: 8, generation: 8, stamp: currentStamp },
    { schemaVersion: 1, jobId: 0, generation: 8, stamp: currentStamp },
    { schemaVersion: 1, jobId: -1, generation: 8, stamp: currentStamp },
    { schemaVersion: 1, jobId: 8, generation: -1, stamp: currentStamp },
    {
      schemaVersion: 1,
      jobId: Number.MAX_SAFE_INTEGER + 1,
      generation: 8,
      stamp: currentStamp,
    },
  ]) {
    assert.equal(phase6LatestWorkerPaintConverged(convergedWorkerRuntime({
      latestSubmittedWorkerIdentity: malformedIdentity,
      publishedWorkerIdentity: malformedIdentity,
      paintedWorkerIdentity: malformedIdentity,
    })), false);
  }
});

test("Phase 6 latest-worker convergence remains closure-free after serialization", () => {
  const serializedPredicate = Function(
    `"use strict"; return (${phase6LatestWorkerPaintConverged.toString()});`,
  )();
  assert.equal(serializedPredicate(convergedWorkerRuntime()), true);

  const emptyStamp = {};
  const forgedIdentity = workerIdentity(8, emptyStamp);
  assert.equal(serializedPredicate(convergedWorkerRuntime({
    lastRequestedStamp: emptyStamp,
    lastPublishedStamp: emptyStamp,
    lastPaintedStamp: emptyStamp,
    latestSubmittedWorkerIdentity: forgedIdentity,
    publishedWorkerIdentity: forgedIdentity,
    paintedWorkerIdentity: forgedIdentity,
    paintReceipt: paintReceipt(emptyStamp, 9),
  })), false);
});

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

test("Phase 6 runner waits only for the backpressure worker drain and bounds the wait", async () => {
  assert.equal(phase6ActionRequiresWorkerDrain("phase6-worker-backpressure"), true);
  assert.equal(phase6ActionRequiresWorkerDrain("phase6-viewport"), false);

  let calls = 0;
  const skipped = await waitForPhase6ActionWorkerDrain({
    action: "phase6-viewport",
    timeoutMs: 50_000,
    waitForWorkerDrain: async () => {
      calls += 1;
      return { passed: true };
    },
  });
  assert.deepEqual(skipped, { required: false, result: null });
  assert.equal(calls, 0);

  const argumentsSeen = [];
  const waited = await waitForPhase6ActionWorkerDrain({
    action: "phase6-worker-backpressure",
    timeoutMs: 50_000,
    workerDelayMs: 192,
    waitForWorkerDrain: async (...args) => {
      argumentsSeen.push(args);
      return { passed: true, queueDepthCurrent: 0, inFlightCurrent: 0 };
    },
  });
  assert.deepEqual(argumentsSeen, [[2_000]]);
  assert.equal(waited.required, true);
  assert.equal(waited.result.passed, true);
});

test("Phase 6 runner fails closed when the latest exact worker does not drain", async () => {
  await assert.rejects(
    waitForPhase6ActionWorkerDrain({
      action: "phase6-worker-backpressure",
      timeoutMs: 100,
      waitForWorkerDrain: async () => ({
        passed: false,
        reason: "phase6-latest-worker-drain-timeout",
      }),
    }),
    /did not drain to the latest exact worker paint.*phase6-latest-worker-drain-timeout/,
  );
  await assert.rejects(
    waitForPhase6ActionWorkerDrain({
      action: "phase6-worker-backpressure",
      timeoutMs: 100,
      waitForWorkerDrain: null,
    }),
    /worker-drain probe is unavailable/,
  );
});

test("Phase 6 runner host-bounds a page worker-drain promise that never resolves", async () => {
  const startedAt = performance.now();
  await assert.rejects(
    waitForPhase6ActionWorkerDrain({
      action: "phase6-worker-backpressure",
      timeoutMs: 0,
      waitForWorkerDrain: () => new Promise(() => {}),
    }),
    /did not drain.*phase6-latest-worker-drain-host-timeout/,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 200, `host timeout fired too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_000, `host timeout leaked to the outer CDP boundary: ${elapsedMs}ms`);
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
  const initialStamp = runtimeStamp();
  const initialWorkerIdentity = workerIdentity(2, initialStamp);
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
    sceneFallbackCount: 0,
    sceneRuntimeFaultCount: 0,
    legacyFallbackSucceededCount: 0,
    sceneFallbackLastReason: null,
    cacheBytes: 2_048,
    cacheBytesMax: 4_096,
    cacheBudgetBytes: 64 * 1024 * 1024,
    cacheHardLimitBytes: 96 * 1024 * 1024,
    cacheEntryCount: 64,
    cacheBudgetEvictionCount: 3,
    cacheEntryBytes: 3_072,
    cacheEntryBudgetBytes: 63 * 1024 * 1024,
    cacheMetadataBytes: 1_024,
    cacheMetadataBudgetBytes: 1024 * 1024,
    cacheRecentHierarchyKeyCount: 128,
    cacheRecentHierarchyKeysPerRequestLimit: 3,
    cacheRecentRequestCount: 64,
    cacheRecentRequestLimit: 512,
    lastRequestedStamp: { ...initialStamp },
    lastPublishedStamp: { ...initialStamp },
    lastPaintedStamp: { ...initialStamp },
    paintReceipt: paintReceipt(initialStamp),
    submittedWorkerHeaders: [initialWorkerIdentity],
    returnedWorkerIdentity: null,
    acceptedWorkerIdentity: initialWorkerIdentity,
    publishedWorkerIdentity: initialWorkerIdentity,
    paintedWorkerIdentity: initialWorkerIdentity,
    latestSubmittedWorkerIdentity: initialWorkerIdentity,
  };
  const handle = {
    report: () => ({
      counters,
      counterMaxima: counters,
      gauges: { workerQueue: 1, workerInFlight: 1, rawPoints: phase6.rawPoints,
        renderedPoints: phase6.renderedPoints, lodRatio: phase6.lodRatio,
        cacheBytes: phase6.cacheBytes },
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
    const currentStamp = runtimeStamp({ documentRevision: 3, viewportRevision: 14 });
    const staleIdentity = workerIdentity(4, initialStamp);
    const currentIdentity = workerIdentity(5, currentStamp);
    phase6.lastRequestedStamp = { ...currentStamp };
    phase6.lastPublishedStamp = { ...currentStamp };
    phase6.lastPaintedStamp = { ...currentStamp };
    phase6.paintReceipt = paintReceipt(currentStamp, 2);
    phase6.submittedWorkerHeaders = [staleIdentity, currentIdentity];
    phase6.returnedWorkerIdentity = staleIdentity;
    phase6.acceptedWorkerIdentity = currentIdentity;
    phase6.publishedWorkerIdentity = currentIdentity;
    phase6.paintedWorkerIdentity = currentIdentity;
    phase6.latestSubmittedWorkerIdentity = currentIdentity;
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
    assert.equal(stopped.runtime.cacheBytes, 2_048);
    assert.equal(stopped.runtime.cacheBytesMax, 4_096);
    assert.equal(stopped.runtime.cacheBudgetBytes, 64 * 1024 * 1024);
    assert.equal(stopped.runtime.cacheHardLimitBytes, 96 * 1024 * 1024);
    assert.equal(stopped.runtime.cacheEntryCount, 64);
    assert.equal(stopped.runtime.cacheBudgetEvictionCount, 3);
    assert.equal(stopped.runtime.cacheEntryBytes, 3_072);
    assert.equal(stopped.runtime.cacheEntryBudgetBytes, 63 * 1024 * 1024);
    assert.equal(stopped.runtime.cacheMetadataBytes, 1_024);
    assert.equal(stopped.runtime.cacheMetadataBudgetBytes, 1024 * 1024);
    assert.equal(stopped.runtime.cacheRecentHierarchyKeyCount, 128);
    assert.equal(stopped.runtime.cacheRecentHierarchyKeysPerRequestLimit, 3);
    assert.equal(stopped.runtime.cacheRecentRequestCount, 64);
    assert.equal(stopped.runtime.cacheRecentRequestLimit, 512);
    assert.equal(stopped.runtime.sceneFallbackDelta, 0);
    assert.equal(stopped.runtime.sceneFallbackCount, 0);
    assert.equal(stopped.runtime.sceneRuntimeFaultCount, 0);
    assert.equal(stopped.runtime.legacyFallbackSucceededCount, 0);
    assert.equal(stopped.runtime.sceneFallbackLastReason, null);
    assert.deepEqual(stopped.runtime.lastPaintedStamp, phase6.lastPaintedStamp);
    assert.deepEqual(stopped.runtime.paintReceipt, phase6.paintReceipt);
    assert.deepEqual(stopped.runtime.submittedWorkerHeaders, [staleIdentity, currentIdentity]);
    assert.deepEqual(stopped.runtime.returnedWorkerIdentity, staleIdentity);
    assert.deepEqual(stopped.runtime.acceptedWorkerIdentity, currentIdentity);
    assert.deepEqual(stopped.runtime.publishedWorkerIdentity, currentIdentity);
    assert.deepEqual(stopped.runtime.paintedWorkerIdentity, currentIdentity);
    assert.deepEqual(stopped.runtime.latestSubmittedWorkerIdentity, currentIdentity);

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

    const fallbackStarted = phase6BrowserProbeBootstrap();
    assert.equal(fallbackStarted.started, true);
    phase6.sceneFallbackCount = 1;
    phase6.sceneRuntimeFaultCount = 1;
    phase6.sceneFallbackLastReason = "worker init failed";
    const fallbackStopped = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__.stop();
    assert.equal(fallbackStopped.runtime.sceneFallbackDelta, 1);
    assert.equal(fallbackStopped.runtime.sceneFallbackCount, 1);
    assert.equal(fallbackStopped.runtime.sceneRuntimeFaultCount, 1);
    assert.equal(fallbackStopped.runtime.sceneFallbackLastReason, "worker init failed");

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
  const revision = (viewportRevision) => runtimeStamp({ viewportRevision });
  const phase6 = {
    lastRequestedStamp: revision(1),
    lastPublishedStamp: revision(1),
    lastPaintedStamp: revision(1),
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
    phase6.lastPaintedStamp = null;
    setTimeout(() => {
      phase6.lastRequestedStamp = revision(3);
      phase6.lastPublishedStamp = revision(2);
      phase6.lastPaintedStamp = revision(2);
    }, 5);
    setTimeout(() => {
      phase6.lastPublishedStamp = revision(3);
      phase6.lastPaintedStamp = revision(3);
    }, 30);
    const painted = await waiting;
    assert.equal(painted.passed, true);
    assert.deepEqual(painted.previousStamp, revision(1));
    assert.deepEqual(painted.requestedStamp, revision(3));
    assert.deepEqual(painted.paintedStamp, revision(3));
  });
});

test("Phase 6 browser probe waits for the drained latest exact worker publication", async () => {
  const initialStamp = runtimeStamp({ viewportRevision: 1 });
  const currentStamp = runtimeStamp({ viewportRevision: 2 });
  const initialIdentity = workerIdentity(1, initialStamp);
  const latestIdentity = workerIdentity(2, currentStamp);
  let counters = {
    workerJobCount: 1,
    workerResultCount: 1,
    workerQueueDropCount: 0,
    staleWorkerResultCount: 0,
    staleWorkerPublishCount: 0,
  };
  const phase6 = {
    backend: "worker",
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    lastRequestedStamp: initialStamp,
    lastPublishedStamp: initialStamp,
    lastPaintedStamp: initialStamp,
    latestSubmittedWorkerIdentity: initialIdentity,
    publishedWorkerIdentity: initialIdentity,
    paintedWorkerIdentity: initialIdentity,
    paintReceipt: paintReceipt(initialStamp),
  };
  const handle = {
    report: () => ({
      counters,
      counterMaxima: counters,
      gauges: {
        workerQueue: phase6.queueDepthCurrent,
        workerInFlight: phase6.inFlightCurrent,
      },
      gaugeMaxima: { workerQueue: 2, workerInFlight: 1 },
    }),
    readRuntimeSummary: () => ({}),
    readPhase6Runtime: () => phase6,
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {},
  }, async () => {
    phase6BrowserProbeBootstrap();
    phase6.backend = "main-thread";
    phase6.queueDepthCurrent = 1;
    phase6.inFlightCurrent = 1;
    phase6.lastRequestedStamp = currentStamp;
    phase6.lastPublishedStamp = currentStamp;
    phase6.lastPaintedStamp = currentStamp;
    phase6.latestSubmittedWorkerIdentity = latestIdentity;
    counters = { ...counters, workerJobCount: 2 };

    const waiting = globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForWorkerDrain(250);
    setTimeout(() => {
      phase6.backend = "worker";
      phase6.queueDepthCurrent = 0;
      phase6.inFlightCurrent = 0;
      phase6.publishedWorkerIdentity = latestIdentity;
      phase6.paintedWorkerIdentity = latestIdentity;
      phase6.paintReceipt = paintReceipt(currentStamp, 2);
      counters = { ...counters, workerResultCount: 2 };
    }, 25);
    const drained = await waiting;
    assert.equal(drained.passed, true);
    assert.equal(drained.backend, "worker");
    assert.equal(drained.queueDepthCurrent, 0);
    assert.equal(drained.inFlightCurrent, 0);
    assert.equal(drained.workerResultDelta, 1);
    assert.deepEqual(drained.latestSubmittedWorkerIdentity, latestIdentity);
    assert.deepEqual(drained.publishedWorkerIdentity, latestIdentity);
    assert.deepEqual(drained.paintedWorkerIdentity, latestIdentity);
    assert.deepEqual(drained.paintReceipt, paintReceipt(currentStamp, 2));

    phase6.backend = "main-thread";
    phase6.queueDepthCurrent = 1;
    phase6.inFlightCurrent = 1;
    const timedOut = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForWorkerDrain(10);
    assert.equal(timedOut.passed, false);
    assert.equal(timedOut.reason, "phase6-latest-worker-drain-timeout");
  });
});

test("Phase 6 browser probe times out while the current requested stamp is unpainted", async () => {
  const revision = (viewportRevision) => runtimeStamp({ viewportRevision });
  const phase6 = {
    lastRequestedStamp: revision(1),
    lastPublishedStamp: revision(1),
    lastPaintedStamp: revision(1),
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
    phase6.lastPublishedStamp = revision(2);
    phase6.lastPaintedStamp = revision(1);
    const painted = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForCurrentPaint(previousStamp, 20);
    assert.equal(painted.passed, false);
    assert.equal(painted.reason, "phase6-current-plan-paint-timeout");
    assert.deepEqual(painted.requestedStamp, revision(2));
    assert.deepEqual(painted.paintedStamp, revision(1));
  });
});

test("Phase 6 browser probe rejects structurally empty paint stamps", async () => {
  const phase6 = {
    lastRequestedStamp: {},
    lastPublishedStamp: {},
    lastPaintedStamp: {},
  };
  const handle = {
    report: () => ({ counters: {}, counterMaxima: {}, gauges: {}, gaugeMaxima: {} }),
    readRuntimeSummary: () => null,
    readPhase6Runtime: () => phase6,
    runPhase6HitOracle: () => null,
  };
  await withWindow({
    __CANDLESCOPE_DRAWING_PERF__: handle,
    __CANDLESCOPE_DRAWING_PERF_CONFIG__: {},
  }, async () => {
    phase6BrowserProbeBootstrap();
    const painted = await globalThis.window.__CANDLESCOPE_PHASE6_PROBE__
      .waitForCurrentPaint(null, 5);
    assert.equal(painted.passed, false);
    assert.equal(painted.reason, "phase6-current-plan-paint-timeout");
  });
});

test("Phase 6 browser probe derives hit oracle mismatches instead of trusting a claimed zero", async () => {
  const handle = {
    report: () => ({ counters: {}, counterMaxima: {}, gauges: {}, gaugeMaxima: {} }),
    readRuntimeSummary: () => ({}),
    readPhase6Runtime: () => ({
      lastRequestedStamp: runtimeStamp({ documentRevision: 4 }),
      lastPublishedStamp: runtimeStamp({ documentRevision: 4 }),
      lastPaintedStamp: runtimeStamp({ documentRevision: 4 }),
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
    assert.deepEqual(oracle.queriedStamp, runtimeStamp({ documentRevision: 4 }));
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
