import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const FRONTEND_ROOT = fileURLToPath(new URL("..", import.meta.url));

function digest(hexCharacter) {
  return `sha256:${hexCharacter.repeat(64)}`;
}

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

function workerIdentity(jobId, value) {
  return {
    schemaVersion: 1,
    jobId,
    generation: jobId,
    stamp: { ...value },
  };
}

function commonArtifact(drillId, injectionKind) {
  return {
    schemaVersion: "drawing-rollback-drill/v2",
    drillId,
    completed: false,
    passed: true,
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

function paintReceipt(value = stamp()) {
  return {
    kind: "drawing-scene-bridge-paint-ack",
    observedAt: "2026-07-16T08:00:59.000Z",
    stamp: { ...value },
  };
}

function preservedOutcome() {
  const currentStamp = stamp();
  return {
    beforeDigest: digest("a"),
    afterDigest: digest("a"),
    beforeEntityCount: 9,
    afterEntityCount: 9,
    queueDepthCurrent: 0,
    lastRequestedStamp: { ...currentStamp },
    lastPublishedStamp: { ...currentStamp },
    lastPaintedStamp: { ...currentStamp },
    paintReceipt: paintReceipt(currentStamp),
  };
}

function workerInitArtifact() {
  return {
    ...commonArtifact("worker-init-failure", "worker-constructor-throws"),
    observations: {
      workerConstructorAttempts: { before: 0, after: 1 },
      workerConstructionFailures: { before: 0, after: 1 },
      fallbackBackend: "main-thread",
      scenePublicationCountDelta: 1,
      workerJobs: { before: 0, after: 0 },
    },
    outcome: preservedOutcome(),
  };
}

function offscreenArtifact() {
  return {
    ...commonArtifact("offscreen-canvas-unsupported", "offscreen-canvas-unavailable"),
    observations: {
      workerCreations: { before: 0, after: 1 },
      offscreenSupported: false,
      firstRequest: {
        requestId: "offscreen-request-1",
        backendBefore: "worker",
        resultKind: "typed-fallback",
        backendAfter: "main-thread",
      },
      secondRequest: {
        requestId: "offscreen-request-2",
        backendBefore: "main-thread",
        resultKind: "main-thread",
        backendAfter: "main-thread",
      },
      finalBackend: "main-thread",
      workerRoundTrips: {
        before: 0,
        afterFirstRequest: 1,
        afterSecondRequest: 1,
      },
      typedResults: { before: 0, after: 1 },
      bitmapResults: { before: 0, after: 0 },
      scenePublications: { before: 0, after: 2 },
    },
    outcome: preservedOutcome(),
  };
}

function indexedDbVariant(kind) {
  const transactionId = `idb-${kind}-transaction`;
  const pendingDocumentDigest = digest(kind === "quota" ? "d" : "e");
  const durableBytesDigest = digest(kind === "quota" ? "1" : "2");
  const durableDocumentDigest = digest(kind === "quota" ? "3" : "4");
  const manifestBytesDigest = digest(kind === "quota" ? "5" : "6");
  const retryDurableBytesDigest = digest(kind === "quota" ? "7" : "8");
  const retryManifestBytesDigest = digest(kind === "quota" ? "9" : "a");
  return {
    kind,
    transactionId,
    errorReceipt: {
      transactionId,
      operation: kind === "quota" ? "transaction-write" : "database-open",
      name: kind === "quota" ? "QuotaExceededError" : "Error",
      message: kind === "quota"
        ? "The quota has been exceeded."
        : "drawing IndexedDB upgrade is blocked",
      observedAt: "2026-07-16T08:00:21.000Z",
    },
    durableRecord: {
      beforeFailure: {
        bytesDigest: durableBytesDigest,
        documentDigest: durableDocumentDigest,
      },
      afterFailure: {
        bytesDigest: durableBytesDigest,
        documentDigest: durableDocumentDigest,
      },
    },
    manifest: {
      beforeFailure: { bytesDigest: manifestBytesDigest },
      afterFailure: { bytesDigest: manifestBytesDigest },
    },
    stateReceipts: [
      {
        stage: "before-write",
        transactionId,
        observedAt: "2026-07-16T08:00:20.000Z",
        pendingDocumentDigest,
        dirty: true,
      },
      {
        stage: "after-failure",
        transactionId,
        observedAt: "2026-07-16T08:00:22.000Z",
        pendingDocumentDigest,
        dirty: true,
      },
      {
        stage: "after-retry",
        transactionId,
        observedAt: "2026-07-16T08:00:25.000Z",
        pendingDocumentDigest,
        dirty: false,
      },
    ],
    retryReceipt: {
      kind: "retry-commit",
      transactionId,
      receiptId: `retry-${kind}`,
      attemptedAt: "2026-07-16T08:00:23.000Z",
      committedAt: "2026-07-16T08:00:24.000Z",
      documentDigest: pendingDocumentDigest,
      durableRecordBytesDigest: retryDurableBytesDigest,
      manifestBytesDigest: retryManifestBytesDigest,
    },
    coldReloadReceipt: {
      kind: "cold-reload",
      sourceTransactionId: transactionId,
      receiptId: `cold-reload-${kind}`,
      beforeBrowserInstanceId: `browser-before-${kind}`,
      afterBrowserInstanceId: `browser-after-${kind}`,
      observedAt: "2026-07-16T08:00:26.000Z",
      documentDigest: pendingDocumentDigest,
      durableRecordBytesDigest: retryDurableBytesDigest,
      manifestBytesDigest: retryManifestBytesDigest,
    },
    failureMetrics: { before: 0, after: 1 },
  };
}

function indexedDbArtifact() {
  return {
    ...commonArtifact("indexeddb-quota-blocked", "indexeddb-quota-and-blocked"),
    variants: [indexedDbVariant("quota"), indexedDbVariant("blocked")],
  };
}

function staleGenerationArtifact() {
  const staleStamp = stamp({ viewportRevision: 18 });
  const currentStamp = stamp();
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
    identities: {
      returned: workerIdentity(29, staleStamp),
      accepted: workerIdentity(30, currentStamp),
      published: workerIdentity(30, currentStamp),
      latestSubmitted: workerIdentity(30, currentStamp),
    },
    submittedHeaders: [
      workerIdentity(29, staleStamp),
      workerIdentity(30, currentStamp),
    ],
    outcome: {
      ...preservedOutcome(),
      lastRequestedStamp: { ...currentStamp },
      lastPublishedStamp: { ...currentStamp },
      lastPaintedStamp: { ...currentStamp },
      paintReceipt: paintReceipt(currentStamp),
    },
  };
}

function gestureVariant(kind) {
  const transactionId = `transaction-${kind}`;
  const gestureId = `gesture-${kind}`;
  return {
    kind,
    transactionId,
    gestureId,
    events: [
      {
        type: "pointer-down",
        transactionId,
        gestureId,
        observedAt: "2026-07-16T08:00:10.000Z",
        activeAfter: true,
      },
      {
        type: "boundary-change",
        transactionId,
        gestureId,
        observedAt: "2026-07-16T08:00:11.000Z",
        boundaryKind: kind,
        beforeValue: kind === "chart-type" ? "candlestick" : "1m",
        afterValue: kind === "chart-type" ? "line" : "5m",
        activeBefore: true,
      },
      {
        type: "gesture-cancel",
        transactionId,
        gestureId,
        observedAt: "2026-07-16T08:00:12.000Z",
        reason: kind === "chart-type" ? "surface-dispose" : "coordinate-change",
        activeAfter: false,
      },
    ],
    canonical: {
      before: {
        scopeKey: "binance:spot:BTCUSDT__main",
        digest: digest(kind === "chart-type" ? "b" : "c"),
        documentRevision: 7,
      },
      after: {
        scopeKey: "binance:spot:BTCUSDT__main",
        digest: digest(kind === "chart-type" ? "b" : "c"),
        documentRevision: 7,
      },
    },
  };
}

function activeGestureArtifact() {
  return {
    ...commonArtifact("active-gesture-chart-boundary", "active-gesture-chart-boundary"),
    variants: [gestureVariant("chart-type"), gestureVariant("interval")],
  };
}

function seriesRebuildArtifact() {
  const currentStamp = stamp({ surfaceGeneration: 4 });
  return {
    ...commonArtifact("series-rebuild-before-export", "series-rebuild-before-export-capture"),
    checkpointEvents: [
      {
        type: "export-prepare",
        observedAt: "2026-07-16T08:00:10.000Z",
        leaseId: "export-lease-old",
        surfaceGeneration: 3,
      },
      {
        type: "series-rebuild-start",
        observedAt: "2026-07-16T08:00:11.000Z",
        fromSurfaceGeneration: 3,
      },
      {
        type: "series-rebuild-complete",
        observedAt: "2026-07-16T08:00:12.000Z",
        fromSurfaceGeneration: 3,
        surfaceGeneration: 4,
      },
      {
        type: "stale-lease-revalidate",
        observedAt: "2026-07-16T08:00:13.000Z",
        leaseId: "export-lease-old",
        surfaceGeneration: 3,
        valid: false,
      },
      {
        type: "fresh-lease-revalidate",
        observedAt: "2026-07-16T08:00:14.000Z",
        leaseId: "export-lease-fresh",
        surfaceGeneration: 4,
        valid: true,
      },
      {
        type: "export-capture",
        observedAt: "2026-07-16T08:00:15.000Z",
        leaseId: "export-lease-fresh",
        surfaceGeneration: 4,
        png: {
          digest: digest("b"),
          bytes: 128_000,
          widthPx: 1_920,
          heightPx: 1_080,
        },
        drawingPixelDiffCount: 4_096,
        controlPixelSampleCount: 512,
        controlPixelDiffCount: 0,
      },
      {
        type: "lease-restored",
        observedAt: "2026-07-16T08:00:16.000Z",
        leaseId: "export-lease-fresh",
        surfaceGeneration: 4,
      },
    ],
    outcome: {
      beforeDigest: digest("c"),
      afterDigest: digest("c"),
      queueDepthCurrent: 0,
      lastRequestedStamp: { ...currentStamp },
      lastPublishedStamp: { ...currentStamp },
      lastPaintedStamp: { ...currentStamp },
      paintReceipt: paintReceipt(currentStamp),
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
      paintReceipt: paintReceipt(finalStamp),
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
        sourceRevision: "shared-source-revision",
        rolloutEnvironment: "scene-canary-rollout",
        buildFingerprint: digest("d"),
        assetDigest: digest("f"),
        origin: "http://127.0.0.1:15173",
        profileId: "phase9-cross-build-profile",
        browserInstanceId: "browser-canary",
        serverInstanceId: "server-canary",
      },
      legacy: {
        mode: "legacy",
        productionBuild: true,
        sourceRevision: "shared-source-revision",
        rolloutEnvironment: "legacy-rollout",
        buildFingerprint: digest("e"),
        assetDigest: digest("0"),
        origin: "http://127.0.0.1:15173",
        profileId: "phase9-cross-build-profile",
        browserInstanceId: "browser-legacy",
        serverInstanceId: "server-legacy",
      },
    },
    restartReceipts: {
      browser: {
        kind: "browser",
        beforeInstanceId: "browser-canary",
        afterInstanceId: "browser-legacy",
        beforeBuildFingerprint: digest("d"),
        afterBuildFingerprint: digest("e"),
        profileId: "phase9-cross-build-profile",
        scopeKey: "binance:spot:BTCUSDT__main",
        stoppedAt: "2026-07-16T08:00:30.000Z",
        startedAt: "2026-07-16T08:00:35.000Z",
      },
      server: {
        kind: "server",
        beforeInstanceId: "server-canary",
        afterInstanceId: "server-legacy",
        beforeBuildFingerprint: digest("d"),
        afterBuildFingerprint: digest("e"),
        profileId: "phase9-cross-build-profile",
        scopeKey: "binance:spot:BTCUSDT__main",
        stoppedAt: "2026-07-16T08:00:31.000Z",
        startedAt: "2026-07-16T08:00:36.000Z",
      },
    },
    snapshot: {
      writeReceipt: {
        kind: "compatibility-write",
        observedAt: "2026-07-16T08:00:20.000Z",
        buildFingerprint: digest("d"),
        profileId: "phase9-cross-build-profile",
        scopeKey: "binance:spot:BTCUSDT__main",
        documentDigest: digest("1"),
        sourceBytesDigest: digest("2"),
        entityCount: 9,
      },
      readReceipt: {
        kind: "legacy-read",
        observedAt: "2026-07-16T08:00:50.000Z",
        buildFingerprint: digest("e"),
        profileId: "phase9-cross-build-profile",
        scopeKey: "binance:spot:BTCUSDT__main",
        documentDigest: digest("1"),
        entityCount: 9,
        visibleEntityCount: 9,
        renderedKinds: [
          "line",
          "axis-line",
          "angle-measure",
          "text",
          "fibonacci",
          "position",
          "shape",
          "freehand",
          "highlighter",
        ],
        sourceBytesDigestBefore: digest("2"),
        sourceBytesDigestAfter: digest("2"),
      },
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
    paintReceipt: paintReceipt(stamp()),
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
  assert.ok(result.failures.includes("worker-construction-failure-count-invalid"));
  assert.ok(result.failures.includes("document-digest-mismatch"));
});

test("dedicated JSON contracts validate but cannot close drills without a controlled runner", () => {
  const artifacts = completeArtifacts();
  for (const id of DRAWING_ROLLBACK_DRILL_IDS) {
    const result = assessDrawingRollbackDrillArtifact(id, artifacts[id]);
    assert.equal(result.passed, false);
    assert.equal(result.contractPassed, true, `${id}: ${result.failures.join(", ")}`);
    assert.equal(result.trustedRunnerAccepted, false);
    assert.equal(result.completionAuthority, "trusted-controlled-browser-runner");
    assert.deepEqual(result.failures, [
      "external-artifact-untrusted-controlled-runner-required",
    ]);
  }
});

test("dedicated v2 contracts derive from evidence and ignore asserted completion/pass flags", () => {
  const artifact = workerInitArtifact();
  artifact.completed = false;
  artifact.passed = false;
  assert.equal(
    assessDrawingRollbackDrillArtifact("worker-init-failure", artifact).contractPassed,
    true,
  );

  artifact.completed = true;
  artifact.passed = true;
  artifact.observations.workerConstructionFailures.after = 0;
  const invalid = assessDrawingRollbackDrillArtifact("worker-init-failure", artifact);
  assert.equal(invalid.contractPassed, false);
  assert.ok(invalid.failures.includes("worker-construction-failure-count-invalid"));

  const legacySchema = workerInitArtifact();
  legacySchema.schemaVersion = "drawing-rollback-drill/v1";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "worker-init-failure",
    legacySchema,
  ).failures.includes("dedicated-schema-mismatch"));
});

test("aggregate acceptance never promotes schema-only or Phase 6 partial artifacts", () => {
  const artifacts = completeArtifacts({ phase6: true });
  const result = assessDrawingRollbackDrills({ artifacts });
  assert.equal(result.phase9RollbackDrillsPassed, false);
  assert.equal(result.externalArtifactsCanCompleteDrills, false);
  assert.equal(result.completionAuthority, "trusted-controlled-browser-runner");
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

test("Phase 6 evidence rejects missing queue limits, mismatched stamps, and inferred paint stamps", () => {
  const missingQueue = phase6Report();
  delete missingQueue.scenarios[0].rawRuns[0].phase6Probe.runtime.queueDepthMax;
  assert.equal(assessPhase6StaleGenerationReport(missingQueue).contractPassed, false);

  const mismatch = phase6Report();
  mismatch.scenarios[0].rawRuns[0].phase6Probe.runtime.lastPublishedStamp.viewportRevision += 1;
  assert.equal(assessPhase6StaleGenerationReport(mismatch).contractPassed, false);

  const inferredPaint = phase6Report();
  delete inferredPaint.scenarios[0].rawRuns[0].phase6Probe.runtime.paintReceipt;
  assert.equal(assessPhase6StaleGenerationReport(inferredPaint).contractPassed, false);

  for (const [field, value] of [
    ["queueDepthMax", -1],
    ["inFlightMax", -1],
    ["queueDepthMax", 1.5],
    ["inFlightMax", 0.5],
  ]) {
    const invalidCounter = phase6Report();
    invalidCounter.scenarios[0].rawRuns[0].phase6Probe.runtime[field] = value;
    assert.equal(
      assessPhase6StaleGenerationReport(invalidCounter).contractPassed,
      false,
      `${field}=${value}`,
    );
  }
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

  const inferredPaint = workerInitArtifact();
  delete inferredPaint.outcome.paintReceipt;
  const inferredPaintResult = assessDrawingRollbackDrillArtifact(
    "worker-init-failure",
    inferredPaint,
  );
  assert.equal(inferredPaintResult.contractPassed, false);
  assert.ok(inferredPaintResult.failures.includes(
    "independent-paint-receipt-invalid-or-missing",
  ));
});

test("Offscreen unsupported falls back once and remains sticky without a second worker round-trip", () => {
  const valid = assessDrawingRollbackDrillArtifact(
    "offscreen-canvas-unsupported",
    offscreenArtifact(),
  );
  assert.equal(valid.contractPassed, true, valid.failures.join(", "));

  const secondRoundTrip = offscreenArtifact();
  secondRoundTrip.observations.workerRoundTrips.afterSecondRequest = 2;
  const secondRoundTripResult = assessDrawingRollbackDrillArtifact(
    "offscreen-canvas-unsupported",
    secondRoundTrip,
  );
  assert.ok(secondRoundTripResult.failures.includes(
    "offscreen-second-request-used-worker-round-trip",
  ));

  const nonSticky = offscreenArtifact();
  nonSticky.observations.secondRequest.backendBefore = "worker";
  nonSticky.observations.finalBackend = "worker";
  const nonStickyResult = assessDrawingRollbackDrillArtifact(
    "offscreen-canvas-unsupported",
    nonSticky,
  );
  assert.ok(nonStickyResult.failures.includes("offscreen-second-request-not-sticky-before"));
  assert.ok(nonStickyResult.failures.includes("offscreen-final-backend-not-main-thread"));

  const noInitialRoundTrip = offscreenArtifact();
  noInitialRoundTrip.observations.workerRoundTrips.afterFirstRequest = 0;
  noInitialRoundTrip.observations.workerRoundTrips.afterSecondRequest = 0;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "offscreen-canvas-unsupported",
    noInitialRoundTrip,
  ).failures.includes("offscreen-first-worker-round-trip-not-observed"));

  const extraInitialRoundTrip = offscreenArtifact();
  extraInitialRoundTrip.observations.workerRoundTrips.afterFirstRequest = 2;
  extraInitialRoundTrip.observations.workerRoundTrips.afterSecondRequest = 2;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "offscreen-canvas-unsupported",
    extraInitialRoundTrip,
  ).failures.includes("offscreen-first-worker-round-trip-not-observed"));
});

test("stale-generation drill proves returned, accepted, published, and latest identities", () => {
  const valid = assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    staleGenerationArtifact(),
  );
  assert.equal(valid.contractPassed, true, valid.failures.join(", "));

  for (const [identity, reason] of [
    ["returned", "returned-worker-identity-invalid-or-missing"],
    ["accepted", "accepted-worker-identity-invalid-or-missing"],
    ["published", "published-worker-identity-invalid-or-missing"],
    ["latestSubmitted", "latest-submitted-worker-identity-invalid-or-missing"],
  ]) {
    const missing = staleGenerationArtifact();
    delete missing.identities[identity];
    assert.ok(assessDrawingRollbackDrillArtifact(
      "worker-stale-generation",
      missing,
    ).failures.includes(reason), identity);
  }

  const notStale = staleGenerationArtifact();
  notStale.identities.returned = structuredClone(notStale.identities.latestSubmitted);
  assert.ok(assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    notStale,
  ).failures.includes("returned-worker-identity-not-stale"));

  const acceptedWrong = staleGenerationArtifact();
  acceptedWrong.identities.accepted.jobId -= 1;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    acceptedWrong,
  ).failures.includes("accepted-worker-identity-not-latest-submitted"));

  const publishedWrong = staleGenerationArtifact();
  publishedWrong.identities.published.stamp.viewportRevision -= 1;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    publishedWrong,
  ).failures.includes("published-worker-identity-not-accepted"));

  for (const [mutate, label] of [
    [(identity) => { identity.jobId = 0; }, "zero-job"],
    [(identity) => { identity.generation = 0; }, "zero-generation"],
    [(identity) => { identity.jobId = Number.MAX_SAFE_INTEGER + 1; }, "unsafe-job"],
    [
      (identity) => { identity.generation = Number.MAX_SAFE_INTEGER + 1; },
      "unsafe-generation",
    ],
    [(identity) => { identity.schemaVersion = 2; }, "wrong-schema"],
  ]) {
    const invalidIdentity = staleGenerationArtifact();
    mutate(invalidIdentity.identities.returned);
    const assessment = assessDrawingRollbackDrillArtifact(
      "worker-stale-generation",
      invalidIdentity,
    );
    assert.ok(
      assessment.failures.includes("returned-worker-identity-invalid-or-missing"),
      label,
    );
  }

  const neverSubmitted = staleGenerationArtifact();
  neverSubmitted.identities.returned = workerIdentity(
    28,
    stamp({ viewportRevision: 17 }),
  );
  assert.ok(assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    neverSubmitted,
  ).failures.includes("returned-worker-identity-was-never-submitted-or-is-latest"));

  const unsafeSubmittedHeader = staleGenerationArtifact();
  unsafeSubmittedHeader.submittedHeaders[0].jobId = Number.MAX_SAFE_INTEGER + 1;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    unsafeSubmittedHeader,
  ).failures.includes("submitted-worker-header-sequence-invalid-or-too-small"));

  for (const [field, value, reason] of [
    ["workerJobDelta", -1, "latest-wins-pressure-not-proven"],
    ["workerResultDelta", -1, "latest-wins-pressure-not-proven"],
    ["workerJobDelta", 5.5, "latest-wins-pressure-not-proven"],
    ["workerResultDelta", 1.5, "latest-wins-pressure-not-proven"],
    ["queueDepthMax", -1, "worker-queue-depth-unbounded-or-missing"],
    ["queueDepthMax", 1.5, "worker-queue-depth-unbounded-or-missing"],
    ["inFlightMax", -1, "worker-inflight-unbounded-or-missing"],
    ["inFlightMax", 0.5, "worker-inflight-unbounded-or-missing"],
  ]) {
    const invalidCounter = staleGenerationArtifact();
    invalidCounter.observations[field] = value;
    const assessment = assessDrawingRollbackDrillArtifact(
      "worker-stale-generation",
      invalidCounter,
    );
    assert.equal(assessment.contractPassed, false, `${field}=${value}`);
    assert.ok(assessment.failures.includes(reason), `${field}=${value}`);
  }
});

test("IndexedDB drill requires both quota and blocked variants through retry restore", () => {
  const oneVariant = indexedDbArtifact();
  oneVariant.variants.pop();
  const missing = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", oneVariant);
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes("indexeddb-variant-count-mismatch"));
  assert.ok(missing.failures.includes("indexeddb-blocked-variant-missing"));

  for (const [mutate, reason] of [
    [
      (variant) => { variant.errorReceipt.name = "Error"; },
      "indexeddb-quota-error-receipt-invalid",
    ],
    [
      (variant) => { variant.durableRecord.afterFailure.bytesDigest = digest("f"); },
      "indexeddb-quota-durable-record-changed-on-failure",
    ],
    [
      (variant) => { variant.manifest.afterFailure.bytesDigest = digest("f"); },
      "indexeddb-quota-manifest-bytes-changed-on-failure",
    ],
    [
      (variant) => { variant.stateReceipts[1].dirty = false; },
      "indexeddb-quota-dirty-state-transition-invalid",
    ],
    [
      (variant) => { variant.retryReceipt.documentDigest = digest("f"); },
      "indexeddb-quota-retry-receipt-invalid",
    ],
    [
      (variant) => {
        variant.coldReloadReceipt.afterBrowserInstanceId =
          variant.coldReloadReceipt.beforeBrowserInstanceId;
      },
      "indexeddb-quota-cold-reload-receipt-invalid",
    ],
    [
      (variant) => { variant.retryReceipt.attemptedAt = "2026-07-16T08:00:30.000Z"; },
      "indexeddb-quota-receipt-order-invalid",
    ],
  ]) {
    const invalid = indexedDbArtifact();
    mutate(invalid.variants[0]);
    const result = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", invalid);
    assert.equal(result.contractPassed, false, reason);
    assert.ok(result.failures.includes(reason), `${reason}: ${result.failures.join(", ")}`);
  }

  const blockedError = indexedDbArtifact();
  blockedError.variants[1].errorReceipt.message = "generic blocked";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "indexeddb-quota-blocked",
    blockedError,
  ).failures.includes("indexeddb-blocked-error-message-mismatch"));
});

test("gesture drill requires boundary-owned cancellation with unchanged same-scope canonical state", () => {
  const artifact = activeGestureArtifact();
  artifact.variants[0].pointerCancelObserved = false;
  artifact.variants[0].canonical.after.scopeKey = "binance:spot:ETHUSDT__main";
  artifact.variants[0].canonical.after.documentRevision = 8;
  const result = assessDrawingRollbackDrillArtifact("active-gesture-chart-boundary", artifact);
  assert.equal(result.contractPassed, false);
  assert.ok(result.failures.includes("chart-type-canonical-scope-mismatch"));
  assert.ok(result.failures.includes("chart-type-canonical-document-revision-changed"));

  const mismatchedIdentity = activeGestureArtifact();
  mismatchedIdentity.variants[0].events[2].gestureId = "different-gesture";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "active-gesture-chart-boundary",
    mismatchedIdentity,
  ).failures.includes("chart-type-gesture-event-identity-mismatch"));

  const noBoundaryChange = activeGestureArtifact();
  noBoundaryChange.variants[1].events[1].afterValue =
    noBoundaryChange.variants[1].events[1].beforeValue;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "active-gesture-chart-boundary",
    noBoundaryChange,
  ).failures.includes("interval-boundary-change-receipt-invalid"));

  for (const kindIndex of [0, 1]) {
    const invalidCancellation = activeGestureArtifact();
    const receipt = invalidCancellation.variants[kindIndex].events[2];
    receipt.reason = kindIndex === 0 ? "coordinate-change" : "surface-dispose";
    receipt.activeAfter = true;
    const kind = kindIndex === 0 ? "chart-type" : "interval";
    assert.ok(assessDrawingRollbackDrillArtifact(
      "active-gesture-chart-boundary",
      invalidCancellation,
    ).failures.includes(`${kind}-boundary-cancellation-receipt-invalid`));
  }

  const digestMutation = activeGestureArtifact();
  digestMutation.variants[1].canonical.after.digest = digest("f");
  assert.ok(assessDrawingRollbackDrillArtifact(
    "active-gesture-chart-boundary",
    digestMutation,
  ).failures.includes("interval-canonical-document-digest-mismatch"));

  const outOfOrder = activeGestureArtifact();
  outOfOrder.variants[1].events[2].observedAt = "2026-07-16T08:00:09.000Z";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "active-gesture-chart-boundary",
    outOfOrder,
  ).failures.includes("interval-gesture-event-order-invalid"));
});

test("export rebuild drill requires stale lease rejection and fresh exact capture", () => {
  const artifact = seriesRebuildArtifact();
  artifact.checkpointEvents[3].valid = true;
  artifact.checkpointEvents[4].valid = false;
  const result = assessDrawingRollbackDrillArtifact("series-rebuild-before-export", artifact);
  assert.equal(result.contractPassed, false);
  assert.ok(result.failures.includes("stale-export-lease-revalidation-invalid"));
  assert.ok(result.failures.includes("fresh-export-lease-revalidation-invalid"));

  const sameLease = seriesRebuildArtifact();
  sameLease.checkpointEvents[4].leaseId = sameLease.checkpointEvents[0].leaseId;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    sameLease,
  ).failures.includes("fresh-export-lease-revalidation-invalid"));

  const badGeneration = seriesRebuildArtifact();
  badGeneration.checkpointEvents[2].surfaceGeneration = 3;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    badGeneration,
  ).failures.includes("series-rebuild-generation-transition-invalid"));

  const invalidPng = seriesRebuildArtifact();
  invalidPng.checkpointEvents[5].png.digest = "sha256:not-a-real-digest";
  invalidPng.checkpointEvents[5].png.bytes = Number.MAX_SAFE_INTEGER + 1;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    invalidPng,
  ).failures.includes("export-png-receipt-invalid"));

  const pixelMismatch = seriesRebuildArtifact();
  pixelMismatch.checkpointEvents[5].drawingPixelDiffCount = 0;
  pixelMismatch.checkpointEvents[5].controlPixelDiffCount = 1;
  const pixelMismatchResult = assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    pixelMismatch,
  );
  assert.ok(pixelMismatchResult.failures.includes("export-drawing-pixel-diff-not-observed"));
  assert.ok(pixelMismatchResult.failures.includes(
    "export-control-pixel-diff-observed-or-missing",
  ));

  const outOfOrder = seriesRebuildArtifact();
  outOfOrder.checkpointEvents[2].observedAt = "2026-07-16T08:00:09.000Z";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    outOfOrder,
  ).failures.includes("export-checkpoint-order-invalid"));

  const wrongCheckpoint = seriesRebuildArtifact();
  wrongCheckpoint.checkpointEvents[1].type = "export-capture";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    wrongCheckpoint,
  ).failures.includes("export-checkpoint-sequence-invalid"));

  const inferredPaint = seriesRebuildArtifact();
  delete inferredPaint.outcome.lastPaintedStamp;
  delete inferredPaint.outcome.paintReceipt;
  const inferredPaintResult = assessDrawingRollbackDrillArtifact(
    "series-rebuild-before-export",
    inferredPaint,
  );
  assert.ok(inferredPaintResult.failures.includes(
    "post-export-independent-painted-stamp-missing",
  ));
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

test("cross-build drill allows one source revision but requires distinct rollout and build assets", () => {
  const validArtifact = crossBuildArtifact();
  assert.equal(validArtifact.builds.canary.sourceRevision, validArtifact.builds.legacy.sourceRevision);
  const valid = assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    validArtifact,
  );
  assert.equal(valid.contractPassed, true, valid.failures.join(", "));

  for (const [mutate, reason] of [
    [
      (artifact) => { artifact.builds.legacy.sourceRevision = ""; },
      "legacy-source-revision-missing",
    ],
    [
      (artifact) => {
        artifact.builds.legacy.rolloutEnvironment = artifact.builds.canary.rolloutEnvironment;
      },
      "cross-build-rollout-environments-not-distinct",
    ],
    [
      (artifact) => {
        artifact.builds.legacy.buildFingerprint = artifact.builds.canary.buildFingerprint;
      },
      "cross-build-fingerprints-not-distinct",
    ],
    [
      (artifact) => { artifact.builds.legacy.assetDigest = artifact.builds.canary.assetDigest; },
      "cross-build-asset-digests-not-distinct",
    ],
    [
      (artifact) => { artifact.builds.legacy.origin = "http://127.0.0.1:15174"; },
      "cross-build-origin-mismatch",
    ],
    [
      (artifact) => { artifact.builds.legacy.profileId = "different-profile"; },
      "cross-build-profile-mismatch",
    ],
    [
      (artifact) => { delete artifact.restartReceipts.browser; },
      "cross-build-browser-restart-receipt-invalid-or-missing",
    ],
    [
      (artifact) => {
        artifact.restartReceipts.server.afterInstanceId =
          artifact.restartReceipts.server.beforeInstanceId;
      },
      "cross-build-server-restart-receipt-invalid-or-missing",
    ],
  ]) {
    const artifact = crossBuildArtifact();
    mutate(artifact);
    const result = assessDrawingRollbackDrillArtifact("canary-to-legacy-snapshot", artifact);
    assert.equal(result.contractPassed, false, reason);
    assert.ok(result.failures.includes(reason), `${reason}: ${result.failures.join(", ")}`);
  }

  const digestMismatch = crossBuildArtifact();
  digestMismatch.snapshot.readReceipt.documentDigest = digest("3");
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    digestMismatch,
  ).failures.includes("cross-build-snapshot-digest-mismatch"));

  const wrongKindSet = crossBuildArtifact();
  wrongKindSet.snapshot.readReceipt.renderedKinds[0] = "not-a-drawing-kind";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    wrongKindSet,
  ).failures.includes("cross-build-kind-coverage-incomplete"));

  const tooFewEntities = crossBuildArtifact();
  tooFewEntities.snapshot.writeReceipt.entityCount = 8;
  tooFewEntities.snapshot.readReceipt.entityCount = 8;
  tooFewEntities.snapshot.readReceipt.visibleEntityCount = 8;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    tooFewEntities,
  ).failures.includes("cross-build-entity-count-mismatch"));

  const bytesMismatch = crossBuildArtifact();
  bytesMismatch.snapshot.readReceipt.sourceBytesDigestAfter = digest("4");
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    bytesMismatch,
  ).failures.includes("cross-build-source-bytes-digest-mismatch"));

  const restartBeforeWrite = crossBuildArtifact();
  restartBeforeWrite.restartReceipts.browser.stoppedAt = "2026-07-16T08:00:19.000Z";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    restartBeforeWrite,
  ).failures.includes("cross-build-browser-restart-order-invalid"));

  const unboundReceipt = crossBuildArtifact();
  unboundReceipt.snapshot.readReceipt.scopeKey = "binance:spot:ETHUSDT__main";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    unboundReceipt,
  ).failures.includes("legacy-read-receipt-build-binding-invalid"));

  const unboundRestart = crossBuildArtifact();
  unboundRestart.restartReceipts.browser.beforeBuildFingerprint = digest("f");
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    unboundRestart,
  ).failures.includes("cross-build-browser-restart-receipt-invalid-or-missing"));

  const malformedDigest = crossBuildArtifact();
  malformedDigest.builds.canary.assetDigest = "sha256:short";
  assert.ok(assessDrawingRollbackDrillArtifact(
    "canary-to-legacy-snapshot",
    malformedDigest,
  ).failures.includes("canary-asset-digest-invalid-or-missing"));
});

test("unknown drills and malformed component evidence fail closed", () => {
  assert.equal(assessDrawingRollbackDrillArtifact("not-a-drill", {}).passed, false);
  const componentEvidence = passingComponentEvidence();
  componentEvidence["worker-init-failure"].exitCode = null;
  const result = assessDrawingRollbackDrills({ componentEvidence });
  assert.equal(result.results[0].status, "missing");
  assert.equal(result.results[0].componentEvidencePassed, false);

  const malformedStale = staleGenerationArtifact();
  malformedStale.submittedHeaders = [null, { jobId: 2 }];
  assert.doesNotThrow(() => assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    malformedStale,
  ));
  assert.equal(assessDrawingRollbackDrillArtifact(
    "worker-stale-generation",
    malformedStale,
  ).contractPassed, false);
});

test("CLI process preserves strict 0/8 sentinel and allow-incomplete exit semantics", () => {
  const cli = ["scripts/drawing-rollback-drills-cli.mjs"];
  const allowed = spawnSync(process.execPath, [...cli, "--allow-incomplete"], {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  const report = JSON.parse(allowed.stdout);
  assert.equal(report.assessment.requiredCount, 8);
  assert.equal(report.assessment.completedCount, 0);
  assert.equal(report.assessment.phase9RollbackDrillsPassed, false);
  assert.equal(report.assessment.externalArtifactsCanCompleteDrills, false);
  assert.equal(
    report.assessment.completionAuthority,
    "trusted-controlled-browser-runner",
  );

  const strict = spawnSync(process.execPath, cli, {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
  });
  assert.equal(strict.status, 1, strict.stderr);
  const strictReport = JSON.parse(strict.stdout);
  assert.equal(strictReport.assessment.completedCount, 0);
  assert.equal(strictReport.assessment.phase9RollbackDrillsPassed, false);
});
