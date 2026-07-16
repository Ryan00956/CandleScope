import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_ROLLBACK_DRILL_IDS,
  DRAWING_ROLLBACK_DRILL_MANIFEST,
  appendNodeTestTapTail,
  assessDrawingRollbackDrillArtifact,
  assessDrawingRollbackDrills,
  assessPhase6StaleGenerationReport,
  parseNodeTestTapPassCount,
} from "./drawing-rollback-drills.mjs";

function stamp(overrides = {}) {
  return {
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 7,
    surfaceGeneration: 3,
    dataRevision: 11,
    projectionRevision: 13,
    lineageIndexRevision: 17,
    viewportRevision: 19,
    themeRevision: 23,
    widthCssPx: 996,
    heightCssPx: 764,
    dpr: 1.5,
    ...overrides,
  };
}

function commonArtifact(drillId, injectionKind) {
  return {
    schemaVersion: "drawing-rollback-drill/v1",
    drillId,
    completed: true,
    environment: {
      productionBuild: true,
      headed: true,
      visibilityState: "visible",
      windowState: "normal",
      browserVersion: "Chrome/150.0.7871.124",
    },
    provenance: {
      buildRevision: "0123456789abcdef",
      runId: `phase9-${drillId}-1`,
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:01:00.000Z",
    },
    injection: {
      kind: injectionKind,
      armed: true,
      observed: true,
    },
    diagnostics: {
      crashCount: 0,
      runtimeExceptions: [],
      unhandledRejections: [],
      unexpectedConsoleErrors: [],
    },
  };
}

function preservedOutcome() {
  return {
    canonicalDocumentPreserved: true,
    beforeDigest: "sha256:drawing-document",
    afterDigest: "sha256:drawing-document",
    beforeEntityCount: 9,
    afterEntityCount: 9,
    currentPaintConverged: true,
    queueDepthCurrent: 0,
    lastRequestedStamp: stamp(),
    lastPublishedStamp: stamp(),
    lastPaintedStamp: stamp(),
  };
}

function workerInitArtifact() {
  return {
    ...commonArtifact("worker-init-failure", "worker-constructor-throws"),
    observations: {
      workerConstructorAttempted: true,
      workerConstructionFailed: true,
      fallbackBackend: "main-thread",
      scenePublicationReady: true,
      workerJobDelta: 0,
    },
    outcome: preservedOutcome(),
  };
}

function offscreenArtifact() {
  return {
    ...commonArtifact("offscreen-canvas-unsupported", "offscreen-canvas-unavailable"),
    observations: {
      workerCreated: true,
      offscreenSupported: false,
      backend: "worker",
      typedResultCount: 3,
      bitmapResultCount: 0,
      scenePublicationReady: true,
    },
    outcome: preservedOutcome(),
  };
}

function indexedDbVariant(kind) {
  return {
    kind,
    injectionArmed: true,
    injectionObserved: true,
    writeRejected: true,
    durableSnapshotPreserved: true,
    manifestPreserved: true,
    pendingDocumentRetained: true,
    retrySucceeded: true,
    restoredAfterRetryMatchesPending: true,
    pendingDigest: `sha256:${kind}-pending`,
    restoredDigest: `sha256:${kind}-pending`,
    failureMetricDelta: 1,
  };
}

function indexedDbArtifact() {
  return {
    ...commonArtifact("indexeddb-quota-blocked", "indexeddb-quota-and-blocked"),
    variants: [indexedDbVariant("quota"), indexedDbVariant("blocked")],
  };
}

function staleGenerationArtifact() {
  return {
    ...commonArtifact("worker-stale-generation", "worker-stale-generation"),
    observations: {
      staleResultDropDelta: 12,
      stalePublishDelta: 0,
      workerJobDelta: 30,
      workerResultDelta: 4,
      queueDepthMax: 2,
      queueDepthCurrent: 0,
      inFlightMax: 1,
      inFlightCurrent: 0,
    },
    outcome: preservedOutcome(),
  };
}

function gestureVariant(kind) {
  return {
    kind,
    pointerDownObserved: true,
    gestureActiveBeforeBoundary: true,
    boundaryChanged: true,
    pointerCancelObserved: true,
    oldScopeMutationCount: 0,
    uncommittedMutationCount: 0,
    newSurfaceReady: true,
    currentPaintConverged: true,
    beforeDigest: `sha256:${kind}`,
    afterDigest: `sha256:${kind}`,
  };
}

function activeGestureArtifact() {
  return {
    ...commonArtifact("active-gesture-chart-boundary", "active-gesture-chart-boundary"),
    variants: [gestureVariant("chart-type"), gestureVariant("interval")],
  };
}

function seriesRebuildArtifact() {
  return {
    ...commonArtifact("series-rebuild-before-export", "series-rebuild-before-export-capture"),
    observations: {
      prepareCompleted: true,
      rebuildStartedAfterPrepare: true,
      rebuildCompletedBeforeCapture: true,
      surfaceGenerationAdvanced: true,
      staleLeaseRejected: true,
      freshLeaseAcquired: true,
      captureCompleted: true,
      drawingsIncluded: true,
      leaseRestored: true,
    },
    outcome: {
      currentPaintConverged: true,
      beforeDigest: "sha256:export-document",
      afterDigest: "sha256:export-document",
      lastRequestedStamp: stamp({ surfaceGeneration: 4 }),
      lastPublishedStamp: stamp({ surfaceGeneration: 4 }),
    },
  };
}

function continuousDprArtifact() {
  const configurations = [
    [1, 900, 600],
    [1.5, 1100, 700],
    [2, 1200, 800],
    [1.5, 1000, 650],
    [1, 900, 600],
    [2, 1200, 800],
  ];
  const transitions = configurations.map(([dpr, widthCssPx, heightCssPx], index) => ({
    dpr,
    widthCssPx,
    heightCssPx,
    overlayDprSynchronized: true,
    workerResultCurrent: true,
    queueDepthCurrent: 0,
    lastRequestedStamp: stamp({ dpr, widthCssPx, heightCssPx, viewportRevision: 30 + index }),
    lastPublishedStamp: stamp({ dpr, widthCssPx, heightCssPx, viewportRevision: 30 + index }),
  }));
  const finalStamp = transitions.at(-1).lastPublishedStamp;
  return {
    ...commonArtifact("continuous-dpr-resize", "continuous-dpr-resize"),
    transitions,
    outcome: {
      ...preservedOutcome(),
      lastRequestedStamp: { ...finalStamp },
      lastPublishedStamp: { ...finalStamp },
      lastPaintedStamp: { ...finalStamp },
    },
  };
}

function crossBuildArtifact() {
  return {
    ...commonArtifact("canary-to-legacy-snapshot", "canary-build-to-legacy-build"),
    builds: {
      canary: {
        mode: "scene-canary",
        productionBuild: true,
        buildRevision: "canary-revision",
        origin: "http://127.0.0.1:15173",
        profileId: "phase9-cross-build-profile",
      },
      legacy: {
        mode: "legacy",
        productionBuild: true,
        buildRevision: "legacy-revision",
        origin: "http://127.0.0.1:15173",
        profileId: "phase9-cross-build-profile",
      },
    },
    snapshot: {
      compatibilityWriteObserved: true,
      legacyReadObserved: true,
      canaryDigest: "sha256:compatibility-snapshot",
      legacyDigest: "sha256:compatibility-snapshot",
      canaryEntityCount: 9,
      legacyEntityCount: 9,
      allNineKindsCovered: true,
      legacyRendererVisible: true,
      sourceBytesUnchangedByRead: true,
    },
  };
}

function phase6MeasuredRun(overrides = {}) {
  const runtime = {
    engineMode: "scene-canary",
    backend: "worker",
    backendSource: "environment",
    canonicalRawPreserved: true,
    scenePublicationReady: true,
    workerJobDelta: 98,
    workerResultDelta: 1,
    staleResultDropDelta: 34,
    stalePublishDelta: 0,
    queueDepthMax: 2,
    queueDepthCurrent: 0,
    inFlightMax: 1,
    inFlightCurrent: 0,
    lastRequestedStamp: stamp(),
    lastPublishedStamp: stamp(),
    lastPaintedStamp: stamp(),
    ...overrides.runtime,
  };
  return {
    warmup: false,
    browserWindow: {
      headed: true,
      windowState: "normal",
      visibilityState: "visible",
      hidden: false,
      devicePixelRatio: 1.5,
    },
    restore: {
      passed: true,
      runtimeSummaryMatchesSaved: true,
      savedDrawingCountBeforeReload: 64,
      savedDrawingCountAfterReload: 64,
      loadedDrawingCountAfterReload: 64,
    },
    diagnostics: {
      consoleErrors: [],
      networkFailures: [],
      runtimeExceptions: [],
    },
    ...overrides,
    phase6Probe: {
      started: true,
      backpressureDelayMs: 96,
      fallbackRequested: false,
      runtime,
      ...overrides.phase6Probe,
    },
  };
}

function phase6Report() {
  return {
    schemaVersion: "drawing-engine-v2-perf/v1",
    acceptance: { kind: "phase6", passed: true },
    phase6Acceptance: { passed: true },
    environment: { productionBuild: true, dpr: 1.5 },
    configuration: {
      serverMode: "managed-preview",
      headless: false,
      smokeOnly: false,
      drawingEngineMode: "scene-canary",
      drawingRasterBackend: "worker",
    },
    scenarios: [{
      id: "phase6-worker-backpressure",
      passed: true,
      rawRuns: Array.from({ length: 5 }, () => phase6MeasuredRun()),
    }],
  };
}

function completeArtifacts({ phase6 = false } = {}) {
  return {
    "worker-init-failure": workerInitArtifact(),
    "offscreen-canvas-unsupported": offscreenArtifact(),
    "indexeddb-quota-blocked": indexedDbArtifact(),
    "worker-stale-generation": phase6 ? phase6Report() : staleGenerationArtifact(),
    "active-gesture-chart-boundary": activeGestureArtifact(),
    "series-rebuild-before-export": seriesRebuildArtifact(),
    "continuous-dpr-resize": continuousDprArtifact(),
    "canary-to-legacy-snapshot": crossBuildArtifact(),
  };
}

function passingComponentEvidence() {
  return Object.fromEntries(DRAWING_ROLLBACK_DRILL_MANIFEST.map((drill) => [drill.id, {
    passed: true,
    exitCode: 0,
    durationMs: 10,
    command: `tsx --test ${drill.id}`,
    passCount: drill.componentTest.minimumPassCount,
  }]));
}

test("manifest maps exactly the eight Phase 9 rollback drills", () => {
  assert.equal(DRAWING_ROLLBACK_DRILL_MANIFEST.length, 8);
  assert.equal(new Set(DRAWING_ROLLBACK_DRILL_IDS).size, 8);
  for (const drill of DRAWING_ROLLBACK_DRILL_MANIFEST) {
    assert.ok(drill.requiredEvidence.length > 0);
    assert.ok(drill.componentTest.files.length > 0);
    assert.ok(drill.componentTest.pattern.length > 0);
    assert.ok(drill.componentTest.minimumPassCount > 0);
  }
});

test("TAP evidence requires an explicit nonzero pass summary", () => {
  assert.equal(parseNodeTestTapPassCount("TAP version 13\n# pass 3\n# fail 0\n"), 3);
  assert.equal(parseNodeTestTapPassCount("TAP version 13\n# pass 0\n# skipped 4\n"), 0);
  assert.equal(parseNodeTestTapPassCount("TAP version 13\n1..0\n"), null);
  let tail = appendNodeTestTapTail("", "x".repeat(5_000), 100);
  tail = appendNodeTestTapTail(tail, "\n# pass 4\n# fail 0\n", 100);
  assert.equal(tail.length, 100);
  assert.equal(parseNodeTestTapPassCount(tail), 4);

  const componentEvidence = passingComponentEvidence();
  componentEvidence["worker-init-failure"].passCount = 0;
  const result = assessDrawingRollbackDrills({ componentEvidence });
  assert.equal(result.results[0].componentEvidencePassed, false);
  assert.equal(result.results[0].status, "missing");
});

test("missing artifacts fail closed even when every component test passes", () => {
  const result = assessDrawingRollbackDrills({ componentEvidence: passingComponentEvidence() });
  assert.equal(result.phase9RollbackDrillsPassed, false);
  assert.equal(result.completedCount, 0);
  assert.equal(result.partialCount, 8);
  assert.equal(result.missingCount, 0);
  assert.equal(result.invalidArtifactCount, 0);
  assert.ok(result.results.every((drill) => drill.status === "partial"));
});

test("an asserted pass flag cannot replace drill-specific browser evidence", () => {
  const artifact = {
    schemaVersion: "drawing-rollback-drill/v1",
    drillId: "worker-init-failure",
    passed: true,
  };
  const result = assessDrawingRollbackDrillArtifact("worker-init-failure", artifact);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes("production-build-not-proven"));
  assert.ok(result.failures.includes("worker-construction-failure-not-observed"));
  assert.ok(result.failures.includes("document-digest-mismatch"));
});

test("dedicated JSON contracts validate but cannot close drills without a controlled runner", () => {
  const artifacts = completeArtifacts();
  for (const id of DRAWING_ROLLBACK_DRILL_IDS) {
    const result = assessDrawingRollbackDrillArtifact(id, artifacts[id]);
    assert.equal(result.passed, false);
    assert.equal(result.contractPassed, true, `${id}: ${result.failures.join(", ")}`);
    assert.deepEqual(result.failures, ["controlled-browser-drill-runner-not-implemented"]);
  }
});

test("aggregate acceptance never promotes schema-only or Phase 6 partial artifacts", () => {
  const artifacts = completeArtifacts({ phase6: true });
  const result = assessDrawingRollbackDrills({ artifacts });
  assert.equal(result.phase9RollbackDrillsPassed, false);
  assert.equal(result.completedCount, 0);
  assert.equal(result.partialCount, 8);
  assert.equal(result.missingCount, 0);
  assert.equal(result.invalidArtifactCount, 0);

  delete artifacts["series-rebuild-before-export"];
  const incomplete = assessDrawingRollbackDrills({ artifacts });
  assert.equal(incomplete.phase9RollbackDrillsPassed, false);
  assert.equal(incomplete.completedCount, 0);
  assert.equal(incomplete.partialCount, 7);
  assert.equal(incomplete.missingCount, 1);
});

test("formal Phase 6 backpressure is partial because returned generation identity is absent", () => {
  const result = assessPhase6StaleGenerationReport(phase6Report());
  assert.equal(result.passed, false);
  assert.equal(result.contractPassed, true, result.failures.join(", "));
  assert.deepEqual(result.failures, ["phase6-worker-result-generation-identity-not-recorded"]);
  const routed = assessDrawingRollbackDrillArtifact("worker-stale-generation", phase6Report());
  assert.equal(routed.passed, false);
  assert.equal(routed.contractPassed, true);
  assert.equal(routed.evidenceKind, "phase6-formal-browser");
});

test("Phase 6 stale generation rejects smoke, insufficient runs, hidden windows, and stale publication", () => {
  const smoke = phase6Report();
  smoke.configuration.smokeOnly = true;
  assert.equal(assessPhase6StaleGenerationReport(smoke).contractPassed, false);

  const short = phase6Report();
  short.scenarios[0].rawRuns.length = 4;
  assert.ok(assessPhase6StaleGenerationReport(short).failures.includes(
    "phase6-backpressure-measured-run-coverage-too-small",
  ));

  const hidden = phase6Report();
  hidden.scenarios[0].rawRuns[0].browserWindow.visibilityState = "hidden";
  assert.equal(assessPhase6StaleGenerationReport(hidden).contractPassed, false);

  const stalePublish = phase6Report();
  stalePublish.scenarios[0].rawRuns[0].phase6Probe.runtime.stalePublishDelta = 1;
  assert.equal(assessPhase6StaleGenerationReport(stalePublish).contractPassed, false);
});

test("Phase 6 evidence rejects missing numeric queue limits and mismatched stamps", () => {
  const missingQueue = phase6Report();
  delete missingQueue.scenarios[0].rawRuns[0].phase6Probe.runtime.queueDepthMax;
  assert.equal(assessPhase6StaleGenerationReport(missingQueue).contractPassed, false);

  const mismatch = phase6Report();
  mismatch.scenarios[0].rawRuns[0].phase6Probe.runtime.lastPublishedStamp.viewportRevision += 1;
  assert.equal(assessPhase6StaleGenerationReport(mismatch).contractPassed, false);
});

test("worker fallback drills require exact data preservation and current stamps", () => {
  const workerInit = workerInitArtifact();
  workerInit.outcome.afterDigest = "sha256:changed";
  assert.equal(
    assessDrawingRollbackDrillArtifact("worker-init-failure", workerInit).contractPassed,
    false,
  );

  const offscreen = offscreenArtifact();
  offscreen.outcome.lastPublishedStamp.surfaceGeneration += 1;
  assert.equal(
    assessDrawingRollbackDrillArtifact("offscreen-canvas-unsupported", offscreen).contractPassed,
    false,
  );
});

test("IndexedDB drill requires both quota and blocked variants through retry restore", () => {
  const oneVariant = indexedDbArtifact();
  oneVariant.variants.pop();
  const missing = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", oneVariant);
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes("indexeddb-variant-count-mismatch"));
  assert.ok(missing.failures.includes("indexeddb-blocked-variant-missing"));

  const failedRetry = indexedDbArtifact();
  failedRetry.variants[0].retrySucceeded = false;
  assert.equal(
    assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", failedRetry).contractPassed,
    false,
  );
});

test("gesture drill requires both boundaries and rejects old-scope mutation", () => {
  const artifact = activeGestureArtifact();
  artifact.variants[0].oldScopeMutationCount = 1;
  const result = assessDrawingRollbackDrillArtifact("active-gesture-chart-boundary", artifact);
  assert.equal(result.contractPassed, false);
  assert.ok(result.failures.includes("chart-type-old-scope-mutated"));
});

test("export rebuild drill requires stale lease rejection and fresh exact capture", () => {
  const artifact = seriesRebuildArtifact();
  artifact.observations.staleLeaseRejected = false;
  artifact.observations.freshLeaseAcquired = false;
  const result = assessDrawingRollbackDrillArtifact("series-rebuild-before-export", artifact);
  assert.equal(result.contractPassed, false);
  assert.ok(result.failures.includes("stale-export-lease-not-rejected"));
  assert.ok(result.failures.includes("fresh-export-lease-not-acquired"));
});

test("continuous DPR drill requires the full matrix on every current transition", () => {
  const noDpr2 = continuousDprArtifact();
  noDpr2.transitions = noDpr2.transitions.map((transition) => ({ ...transition, dpr: 1.5 }));
  assert.ok(assessDrawingRollbackDrillArtifact("continuous-dpr-resize", noDpr2).failures.includes(
    "dpr-matrix-incomplete",
  ));

  const stale = continuousDprArtifact();
  stale.transitions[2].workerResultCurrent = false;
  assert.equal(
    assessDrawingRollbackDrillArtifact("continuous-dpr-resize", stale).contractPassed,
    false,
  );

  const stampViewportMismatch = continuousDprArtifact();
  stampViewportMismatch.transitions[1].lastRequestedStamp.dpr = 2;
  stampViewportMismatch.transitions[1].lastPublishedStamp.dpr = 2;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "continuous-dpr-resize",
    stampViewportMismatch,
  ).failures.includes("transition-1-stamp-viewport-mismatch"));

  const revisionDidNotAdvance = continuousDprArtifact();
  revisionDidNotAdvance.transitions[2].lastRequestedStamp.viewportRevision = 31;
  revisionDidNotAdvance.transitions[2].lastPublishedStamp.viewportRevision = 31;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "continuous-dpr-resize",
    revisionDidNotAdvance,
  ).failures.includes("transition-2-viewport-revision-not-advanced"));

  const finalMismatch = continuousDprArtifact();
  finalMismatch.outcome.lastRequestedStamp.viewportRevision += 1;
  finalMismatch.outcome.lastPublishedStamp.viewportRevision += 1;
  finalMismatch.outcome.lastPaintedStamp.viewportRevision += 1;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "continuous-dpr-resize",
    finalMismatch,
  ).failures.includes("final-requested-stamp-does-not-match-last-transition"));
});

test("cross-build drill requires distinct builds sharing one origin and profile", () => {
  const artifact = crossBuildArtifact();
  artifact.builds.legacy.profileId = "different-profile";
  const result = assessDrawingRollbackDrillArtifact("canary-to-legacy-snapshot", artifact);
  assert.equal(result.contractPassed, false);
  assert.ok(result.failures.includes("cross-build-profile-mismatch"));
});

test("unknown drills and malformed component evidence fail closed", () => {
  assert.equal(assessDrawingRollbackDrillArtifact("not-a-drill", {}).passed, false);
  const componentEvidence = passingComponentEvidence();
  componentEvidence["worker-init-failure"].exitCode = null;
  const result = assessDrawingRollbackDrills({ componentEvidence });
  assert.equal(result.results[0].status, "missing");
  assert.equal(result.results[0].componentEvidencePassed, false);
});
