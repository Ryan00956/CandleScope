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
  const workerInit = drillId === "worker-init-failure";
  const offscreen = drillId === "offscreen-canvas-unsupported";
  const workerTargets = workerInit ? [] : [{
    targetId: "drawing-worker-1",
    path: "assets/drawing.worker-test.js",
    active: !offscreen,
    manifestBacked: true,
    constructorProvenanceAccepted: true,
    networkProvenanceAccepted: true,
    assetAccepted: true,
    assetDigest: digest("e"),
    expectedAssetDigest: digest("e"),
  }];
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
    buildAuthority: {
      kind: "controlled-browser-build-authority",
      drillId,
      capturedAt: "2026-07-16T08:00:59.500Z",
      authoritative: true,
      fullBuildAuthoritative: !offscreen,
      assetBuildAuthoritative: true,
      buildId: "controlled-build-1",
      buildFingerprint: digest("b"),
      assetDigest: digest("c"),
      currentAssetDigest: digest("c"),
      buildInputDigest: digest("d"),
      currentBuildInputDigest: digest("d"),
      gitRevision: "0123456789abcdef",
      managedOrigin: "http://127.0.0.1:4173",
      observedOrigin: "http://127.0.0.1:4173",
      href: "http://127.0.0.1:4173/",
      matchesManagedOrigin: true,
      matchesManagedDocument: true,
      entryAssetsLoaded: true,
      networkAssetsPassed: !offscreen,
      networkAssetAuthorityPassed: true,
      networkQuiescencePassed: true,
      browserLoadedAssetsAccepted: true,
      domLoadedAssetsAccepted: true,
      expectedEntriesPresentInDom: true,
      distMatchesBuild: true,
      buildInputsMatch: true,
      gitMatchesBuild: true,
      managedOriginGuardPassed: true,
      workerDiagnosticsPassed: true,
      handlerSettlementsPassed: true,
      workerLifecycle: {
        kind: workerInit
          ? "construction-failed-before-target"
          : offscreen
            ? "detached-after-typed-fallback"
            : "active-worker",
        accepted: true,
        drawingWorkerTargetCount: workerTargets.length,
        activeDrawingWorkerTargetCount: workerTargets.filter((target) => target.active).length,
        detachedDrawingWorkerTargetCount: workerTargets.filter((target) => !target.active).length,
        constructionFaultCount: workerInit ? 1 : 0,
        assetAuthorityAccepted: true,
        targets: workerTargets,
      },
    },
    injection: {
      kind: injectionKind,
      armed: true,
      observed: true,
      buildAuthorityCurrent: true,
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

function configuredEnvironmentWorkerRequest() {
  return {
    engineMode: "scene-canary",
    backend: "worker",
    engineModeSource: "environment",
    backendSource: "environment",
  };
}

function cleanSceneCanaryRuntime(overrides = {}) {
  return {
    engineMode: "scene-canary",
    scenePublicationReady: true,
    attachedPrimitiveCount: 1,
    backend: "worker",
    backendSource: "environment",
    workerResultDelayMs: 0,
    workerAvailability: "available",
    workerUnavailableReason: null,
    offscreenSupported: true,
    queueDepthMax: 0,
    inFlightMax: 0,
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    workerJobDelta: 0,
    workerResultDelta: 0,
    pendingDropDelta: 0,
    staleResultDropDelta: 0,
    stalePublishCount: 0,
    sceneFallbackCount: 0,
    sceneRuntimeFaultCount: 0,
    legacyFallbackSucceededCount: 0,
    ...overrides,
  };
}

function workerInitArtifact() {
  return {
    ...commonArtifact("worker-init-failure", "worker-constructor-throws"),
    observations: {
      configuredRequest: configuredEnvironmentWorkerRequest(),
      runtime: cleanSceneCanaryRuntime({
        backend: "main-thread",
        workerAvailability: "unavailable",
        workerUnavailableReason: "construction-failed",
      }),
      workerConstructorAttempts: { before: 0, after: 1 },
      workerConstructionFailures: { before: 0, after: 1 },
      fallbackBackend: "main-thread",
      scenePublicationCountDelta: 1,
      workerJobs: { before: 0, after: 0 },
      stalePublishCount: { before: 0, after: 0 },
    },
    outcome: preservedOutcome(),
  };
}

function offscreenArtifact() {
  const common = commonArtifact(
    "offscreen-canvas-unsupported",
    "offscreen-canvas-unavailable",
  );
  return {
    ...common,
    injection: {
      ...common.injection,
      capabilityReceipt: {
        realm: "drawing-worker-global",
        capability: "OffscreenCanvas",
        supported: false,
        beforeType: "function",
        afterType: "undefined",
      },
    },
    observations: {
      configuredRequest: configuredEnvironmentWorkerRequest(),
      runtime: cleanSceneCanaryRuntime({
        backend: "main-thread",
        workerAvailability: "disposed",
      }),
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

function indexedDbFaultFields(kind, runId, faultId, authorityTokenSha256) {
  return {
    runId,
    faultId,
    authorityTokenSha256,
    variant: kind,
  };
}

function indexedDbRecordReceipt({
  scopeKey,
  documentRevision,
  entityCount,
  canonicalBytesDigest,
  documentDigest,
}) {
  return {
    kind: "canonical-structured-clone-record",
    documentSchemaVersion: 1,
    scopeKey,
    documentRevision,
    entityCount,
    canonicalBytesDigest,
    documentDigest,
  };
}

function indexedDbManifestReceipt({
  scopeKey,
  documentRevision,
  entityCount,
  rawBytesDigest,
}) {
  return {
    kind: "drawing-document-manifest",
    manifestSchemaVersion: 1,
    scopeKey,
    revision: documentRevision,
    count: entityCount,
    rawBytesDigest,
  };
}

function indexedDbQuotaNativeReceipt({
  faultFields,
  transactionId,
  receiptId,
  productErrorReceiptId,
}) {
  const origin = "http://127.0.0.1:4173";
  const sacrificialDbName = `candlescope-rollback-quota-${faultFields.runId}-${faultFields.faultId}`;
  const usageReceipt = (quotaBytes, overrideActive, observedAt) => ({
    method: "Storage.getUsageAndQuota",
    origin,
    usageBytes: 4_096,
    quotaBytes,
    overrideActive,
    observedAt,
  });
  const afterCacheExpiry = usageReceipt(1, true, "2026-07-16T08:00:54.960Z");
  return {
    kind: "cdp-storage-quota-override",
    receiptId,
    ...faultFields,
    transactionId,
    origin,
    overrideActive: true,
    overrideCleared: true,
    releaseAccepted: true,
    forcedCleanup: false,
    productErrorReceiptId,
    quotaPlan: {
      kind: "nonzero-below-existing-usage",
      quotaSizeBytes: 1,
      baselineUsageBytes: 4_096,
      baselineUsageExceedsQuota: true,
    },
    sacrificialDbName,
    preparation: {
      prepared: true,
      databaseName: sacrificialDbName,
      storeName: "quota-probe",
      baselineKey: "baseline",
      baselineCommitted: true,
      connectionKeptOpen: true,
      preparedAt: "2026-07-16T08:00:19.500Z",
    },
    cacheExpiryGuard: {
      kind: "indexeddb-bucket-space-cache-expiry",
      cacheTimeLimitMs: 30_000,
      guardMs: 5_000,
      requestedWaitMs: 35_000,
      elapsedMs: 35_000,
      startedAt: "2026-07-16T08:00:19.950Z",
      completedAt: "2026-07-16T08:00:54.950Z",
      verification: afterCacheExpiry,
    },
    probe: {
      attempted: true,
      attemptedAt: "2026-07-16T08:00:55.000Z",
      databaseName: sacrificialDbName,
      storeName: "quota-probe",
      transactionMode: "readwrite",
      settled: "abort",
      requestError: null,
      transactionError: {
        name: "QuotaExceededError",
        observedAt: "2026-07-16T08:00:55.020Z",
      },
      abortEvent: {
        type: "abort",
        isTrusted: true,
        observedAt: "2026-07-16T08:00:55.030Z",
      },
      nativeQuotaExceeded: true,
      observedAt: "2026-07-16T08:00:55.040Z",
    },
    cleanup: {
      databaseName: sacrificialDbName,
      storeName: "quota-probe",
      connectionClosed: true,
      deletion: { status: "success" },
      databaseStillPresent: false,
      forcedCleanup: false,
      completed: true,
      completedAt: "2026-07-16T08:00:55.500Z",
    },
    overrideCommand: {
      method: "Storage.overrideQuotaForOrigin",
      origin,
      quotaSize: 1,
      accepted: true,
      observedAt: "2026-07-16T08:00:19.800Z",
    },
    clearCommand: {
      method: "Storage.overrideQuotaForOrigin",
      origin,
      quotaSizeOmitted: true,
      accepted: true,
      observedAt: "2026-07-16T08:00:55.400Z",
    },
    usageAndQuota: {
      before: usageReceipt(10_000_000, false, "2026-07-16T08:00:19.600Z"),
      overridden: usageReceipt(1, true, "2026-07-16T08:00:19.900Z"),
      afterCacheExpiry,
      restored: usageReceipt(10_000_000, false, "2026-07-16T08:00:55.600Z"),
    },
  };
}

function indexedDbBlockedNativeReceipt({
  faultFields,
  transactionId,
  receiptId,
  productErrorReceiptId,
}) {
  const sacrificialDbName = `candlescope-rollback-blocked-${faultFields.runId}-${faultFields.faultId}`;
  return {
    kind: "native-indexeddb-blocked-event",
    receiptId,
    ...faultFields,
    transactionId,
    sacrificialDbName,
    productErrorReceiptId,
    keeperConnection: {
      connectionId: "blocked-keeper-connection",
      databaseName: sacrificialDbName,
      openedVersion: 1,
      openedAt: "2026-07-16T08:00:19.900Z",
      closedAt: "2026-07-16T08:00:22.200Z",
    },
    upgradeOpenRequest: {
      requestId: "blocked-upgrade-request",
      databaseName: sacrificialDbName,
      requestedVersion: 2,
      startedAt: "2026-07-16T08:00:20.100Z",
      settled: "success-after-keeper-close",
      settledAt: "2026-07-16T08:00:22.300Z",
      blockedEvent: {
        type: "blocked",
        isTrusted: true,
        databaseName: sacrificialDbName,
        oldVersion: 1,
        newVersion: 2,
        observedAt: "2026-07-16T08:00:20.150Z",
      },
    },
    cleanup: {
      keeperClosed: true,
      upgradeRequestSettled: true,
      deleteRequested: true,
      deleteSucceeded: true,
      databaseAbsent: true,
      databaseName: sacrificialDbName,
      completedAt: "2026-07-16T08:00:22.600Z",
    },
  };
}

function indexedDbVariant(kind, runId) {
  const transactionId = `idb-${kind}-transaction`;
  const faultId = `indexeddb-${kind}-fault-1`;
  const authorityTokenSha256 = digest(kind === "quota" ? "b" : "c");
  const faultFields = indexedDbFaultFields(kind, runId, faultId, authorityTokenSha256);
  const faultBinding = {
    kind: "controlled-indexeddb-fault-binding",
    ...faultFields,
  };
  const scopeKey = "binance:spot:BTCUSDT__main";
  const documentRevision = 8;
  const entityCount = 10;
  const pendingDocumentDigest = digest(kind === "quota" ? "d" : "e");
  const durableBytesDigest = digest(kind === "quota" ? "1" : "2");
  const durableDocumentDigest = digest(kind === "quota" ? "3" : "4");
  const manifestBytesDigest = digest(kind === "quota" ? "5" : "6");
  const retryDurableBytesDigest = digest(kind === "quota" ? "7" : "8");
  const retryManifestBytesDigest = digest(kind === "quota" ? "9" : "a");
  const oldRecord = indexedDbRecordReceipt({
    scopeKey,
    documentRevision: documentRevision - 1,
    entityCount: entityCount - 1,
    canonicalBytesDigest: durableBytesDigest,
    documentDigest: durableDocumentDigest,
  });
  const oldManifest = indexedDbManifestReceipt({
    scopeKey,
    documentRevision: documentRevision - 1,
    entityCount: entityCount - 1,
    rawBytesDigest: manifestBytesDigest,
  });
  const retryRecord = indexedDbRecordReceipt({
    scopeKey,
    documentRevision,
    entityCount,
    canonicalBytesDigest: retryDurableBytesDigest,
    documentDigest: pendingDocumentDigest,
  });
  const retryManifest = indexedDbManifestReceipt({
    scopeKey,
    documentRevision,
    entityCount,
    rawBytesDigest: retryManifestBytesDigest,
  });
  const pendingIdentity = {
    scopeKey,
    documentRevision,
    entityCount,
    documentDigest: pendingDocumentDigest,
  };
  const nativeReceiptId = `native-${kind}`;
  const productErrorReceiptId = `product-error-${kind}`;
  const nativeReceipt = kind === "quota"
    ? indexedDbQuotaNativeReceipt({
      faultFields,
      transactionId,
      receiptId: nativeReceiptId,
      productErrorReceiptId,
    })
    : indexedDbBlockedNativeReceipt({
      faultFields,
      transactionId,
      receiptId: nativeReceiptId,
      productErrorReceiptId,
    });
  const currentStamp = stamp({ scopeKey, documentRevision });
  const timeline = kind === "quota" ? {
    beforeWrite: "2026-07-16T08:00:55.100Z",
    error: "2026-07-16T08:00:55.200Z",
    afterFailure: "2026-07-16T08:00:55.300Z",
    retryAttempted: "2026-07-16T08:00:55.700Z",
    retryCommitted: "2026-07-16T08:00:55.800Z",
    afterRetry: "2026-07-16T08:00:55.900Z",
  } : {
    beforeWrite: "2026-07-16T08:00:20.000Z",
    error: "2026-07-16T08:00:21.000Z",
    afterFailure: "2026-07-16T08:00:22.000Z",
    retryAttempted: "2026-07-16T08:00:23.000Z",
    retryCommitted: "2026-07-16T08:00:24.000Z",
    afterRetry: "2026-07-16T08:00:25.000Z",
  };
  return {
    kind,
    transactionId,
    faultBinding,
    nativeReceipt,
    errorReceipt: {
      receiptId: productErrorReceiptId,
      ...faultFields,
      transactionId,
      nativeReceiptId,
      operation: kind === "quota" ? "transaction-write" : "database-open",
      name: kind === "quota" ? "QuotaExceededError" : "Error",
      message: kind === "quota"
        ? "The quota has been exceeded."
        : "drawing IndexedDB upgrade is blocked",
      source: "drawing-persistence-flush",
      caughtByProduct: true,
      observedAt: timeline.error,
    },
    durableRecord: {
      beforeFailure: { ...oldRecord },
      afterFailure: { ...oldRecord },
    },
    manifest: {
      beforeFailure: { ...oldManifest },
      afterFailure: { ...oldManifest },
    },
    stateReceipts: [
      {
        stage: "before-write",
        ...faultFields,
        transactionId,
        observedAt: timeline.beforeWrite,
        ...pendingIdentity,
        dirty: true,
      },
      {
        stage: "after-failure",
        ...faultFields,
        transactionId,
        observedAt: timeline.afterFailure,
        ...pendingIdentity,
        dirty: true,
      },
      {
        stage: "after-retry",
        ...faultFields,
        transactionId,
        observedAt: timeline.afterRetry,
        ...pendingIdentity,
        dirty: false,
      },
    ],
    retryReceipt: {
      kind: "retry-commit",
      ...faultFields,
      transactionId,
      receiptId: `retry-${kind}`,
      attemptedAt: timeline.retryAttempted,
      committedAt: timeline.retryCommitted,
      durableRecord: { ...retryRecord },
      manifest: { ...retryManifest },
    },
    coldReloadReceipt: {
      kind: "cold-reload",
      ...faultFields,
      transactionId,
      sourceTransactionId: transactionId,
      receiptId: `cold-reload-${kind}`,
      beforeDocumentInstanceId: `document-before-${kind}`,
      afterDocumentInstanceId: `document-after-${kind}`,
      restoreSource: "v2",
      observedAt: "2026-07-16T08:00:59.250Z",
      restoredDocument: { ...pendingIdentity },
      durableRecord: { ...retryRecord },
      manifest: { ...retryManifest },
      queueDepthCurrent: 0,
      dirty: false,
      lastRequestedStamp: { ...currentStamp },
      lastPublishedStamp: { ...currentStamp },
      lastPaintedStamp: { ...currentStamp },
      paintReceipt: paintReceipt(currentStamp),
    },
    failureMetrics: { before: 0, after: 1 },
  };
}

function indexedDbArtifact() {
  const common = commonArtifact("indexeddb-quota-blocked", "indexeddb-quota-and-blocked");
  return {
    ...common,
    variants: [
      indexedDbVariant("quota", common.provenance.runId),
      indexedDbVariant("blocked", common.provenance.runId),
    ],
  };
}

function assertIndexedDbMutation(kind, mutate, reason, label = reason) {
  const artifact = indexedDbArtifact();
  const variant = artifact.variants.find((value) => value.kind === kind);
  assert.ok(variant, `${kind} fixture missing`);
  mutate(variant, artifact);
  const result = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", artifact);
  assert.equal(result.contractPassed, false, label);
  assert.ok(result.failures.includes(reason), `${label}: ${result.failures.join(", ")}`);
}

function staleGenerationArtifact() {
  const staleStamp = stamp({ viewportRevision: 18 });
  const currentStamp = stamp();
  const common = commonArtifact("worker-stale-generation", "worker-stale-generation");
  return {
    ...common,
    injection: {
      ...common.injection,
      delayMs: 96,
    },
    observations: {
      staleResultDropDelta: 12,
      stalePublishDelta: 0,
      stalePublishCount: { before: 0, after: 0 },
      workerJobDelta: 30,
      workerResultDelta: 4,
      queueDepthMax: 2,
      queueDepthCurrent: 0,
      inFlightMax: 1,
      inFlightCurrent: 0,
      runtime: cleanSceneCanaryRuntime({
        workerResultDelayMs: 96,
        queueDepthMax: 2,
        inFlightMax: 1,
        workerJobDelta: 30,
        workerResultDelta: 4,
        pendingDropDelta: 12,
        staleResultDropDelta: 12,
      }),
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

test("dedicated contracts require a current per-drill controlled build authority receipt", () => {
  for (const [label, mutate, reason] of [
    [
      "missing receipt",
      (artifact) => { delete artifact.buildAuthority; },
      "per-drill-build-authority-missing",
    ],
    [
      "not authoritative",
      (artifact) => { artifact.buildAuthority.authoritative = false; },
      "per-drill-build-not-authoritative",
    ],
    [
      "asset digest drift",
      (artifact) => { artifact.buildAuthority.currentAssetDigest = digest("e"); },
      "per-drill-asset-digest-mismatch",
    ],
    [
      "build input drift",
      (artifact) => { artifact.buildAuthority.currentBuildInputDigest = digest("e"); },
      "per-drill-build-input-digest-mismatch",
    ],
    [
      "git revision drift",
      (artifact) => { artifact.buildAuthority.gitRevision = "fedcba9876543210"; },
      "per-drill-git-revision-mismatch",
    ],
    [
      "managed origin drift",
      (artifact) => { artifact.buildAuthority.observedOrigin = "http://127.0.0.1:4174"; },
      "per-drill-managed-origin-mismatch",
    ],
    [
      "entry asset rejection",
      (artifact) => { artifact.buildAuthority.entryAssetsLoaded = false; },
      "per-drill-entry-assets-not-proven",
    ],
  ]) {
    const artifact = workerInitArtifact();
    mutate(artifact);
    const result = assessDrawingRollbackDrillArtifact("worker-init-failure", artifact);
    assert.ok(result.failures.includes(reason), `${label}: ${result.failures.join(", ")}`);
  }

  for (const [drillId, artifact, reason] of [
    [
      "worker-init-failure",
      workerInitArtifact(),
      "worker-init-current-build-authority-not-proven",
    ],
    [
      "offscreen-canvas-unsupported",
      offscreenArtifact(),
      "offscreen-current-build-authority-not-proven",
    ],
    [
      "worker-stale-generation",
      staleGenerationArtifact(),
      "stale-generation-current-build-authority-not-proven",
    ],
  ]) {
    artifact.injection.buildAuthorityCurrent = false;
    const result = assessDrawingRollbackDrillArtifact(drillId, artifact);
    assert.ok(result.failures.includes(reason), `${drillId}: ${result.failures.join(", ")}`);
  }
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

test("worker-init drill requires the configured scene-canary worker request and clean fallback runtime", () => {
  for (const [label, mutate, reason] of [
    [
      "configured request",
      (artifact) => { artifact.observations.configuredRequest.backendSource = "default"; },
      "worker-init-configured-environment-worker-request-invalid-or-missing",
    ],
    [
      "scene canary",
      (artifact) => { artifact.observations.runtime.engineMode = "legacy"; },
      "worker-init-runtime-not-scene-canary",
    ],
    [
      "main thread fallback",
      (artifact) => { artifact.observations.runtime.backend = "worker"; },
      "worker-init-runtime-backend-not-main-thread",
    ],
    [
      "environment backend",
      (artifact) => { artifact.observations.runtime.backendSource = "default"; },
      "worker-init-runtime-backend-source-not-environment",
    ],
    [
      "unavailable worker",
      (artifact) => { artifact.observations.runtime.workerAvailability = "available"; },
      "worker-init-worker-availability-not-unavailable",
    ],
    [
      "construction reason",
      (artifact) => { artifact.observations.runtime.workerUnavailableReason = "transport-error"; },
      "worker-init-unavailable-reason-not-construction-failed",
    ],
    [
      "single primitive",
      (artifact) => { artifact.observations.runtime.attachedPrimitiveCount = 0; },
      "worker-init-attached-primitive-count-not-one",
    ],
    [
      "zero scene fallback",
      (artifact) => { artifact.observations.runtime.sceneFallbackCount = 1; },
      "worker-init-scene-fallback-observed-or-missing",
    ],
    [
      "zero runtime fault",
      (artifact) => { artifact.observations.runtime.sceneRuntimeFaultCount = 1; },
      "worker-init-runtime-fault-observed-or-missing",
    ],
    [
      "zero legacy fallback",
      (artifact) => { artifact.observations.runtime.legacyFallbackSucceededCount = 1; },
      "worker-init-legacy-fallback-observed-or-missing",
    ],
    [
      "zero stale publication runtime",
      (artifact) => { artifact.observations.runtime.stalePublishCount = 1; },
      "worker-init-stale-publish-observed-or-missing",
    ],
    [
      "zero stale publication receipt",
      (artifact) => { artifact.observations.stalePublishCount.after = 1; },
      "worker-init-stale-publish-counter-not-zero-before-and-after",
    ],
  ]) {
    const artifact = workerInitArtifact();
    mutate(artifact);
    const assessment = assessDrawingRollbackDrillArtifact("worker-init-failure", artifact);
    assert.equal(assessment.contractPassed, false, label);
    assert.ok(assessment.failures.includes(reason), label);
  }
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

test("Offscreen drill requires a worker-global capability receipt and a clean environment runtime", () => {
  for (const [label, mutate, reason] of [
    [
      "worker-global capability",
      (artifact) => { artifact.injection.capabilityReceipt.realm = "page-global"; },
      "offscreen-worker-global-capability-receipt-invalid-or-missing",
    ],
    [
      "configured request",
      (artifact) => { artifact.observations.configuredRequest.engineModeSource = "url"; },
      "offscreen-configured-environment-worker-request-invalid-or-missing",
    ],
    [
      "environment backend",
      (artifact) => { artifact.observations.runtime.backendSource = "default"; },
      "offscreen-runtime-backend-source-not-environment",
    ],
    [
      "single primitive",
      (artifact) => { artifact.observations.runtime.attachedPrimitiveCount = 0; },
      "offscreen-attached-primitive-count-not-one",
    ],
    [
      "zero scene fallback",
      (artifact) => { artifact.observations.runtime.sceneFallbackCount = 1; },
      "offscreen-scene-fallback-observed-or-missing",
    ],
    [
      "zero runtime fault",
      (artifact) => { artifact.observations.runtime.sceneRuntimeFaultCount = 1; },
      "offscreen-runtime-fault-observed-or-missing",
    ],
    [
      "zero legacy fallback",
      (artifact) => { artifact.observations.runtime.legacyFallbackSucceededCount = 1; },
      "offscreen-legacy-fallback-observed-or-missing",
    ],
  ]) {
    const artifact = offscreenArtifact();
    mutate(artifact);
    const assessment = assessDrawingRollbackDrillArtifact(
      "offscreen-canvas-unsupported",
      artifact,
    );
    assert.equal(assessment.contractPassed, false, label);
    assert.ok(assessment.failures.includes(reason), label);
  }
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

test("stale-generation drill requires exact 96ms pressure, bounded runtime, and zero fallback", () => {
  for (const [label, mutate, reason] of [
    [
      "injection delay",
      (artifact) => { artifact.injection.delayMs = 95; },
      "stale-generation-injection-delay-not-96ms",
    ],
    [
      "runtime delay",
      (artifact) => { artifact.observations.runtime.workerResultDelayMs = 95; },
      "stale-generation-runtime-delay-not-96ms",
    ],
    [
      "worker backend",
      (artifact) => { artifact.observations.runtime.backend = "main-thread"; },
      "stale-generation-runtime-backend-not-worker",
    ],
    [
      "worker available",
      (artifact) => { artifact.observations.runtime.workerAvailability = "unavailable"; },
      "stale-generation-worker-not-available",
    ],
    [
      "queue max exactly two",
      (artifact) => { artifact.observations.runtime.queueDepthMax = 1; },
      "stale-generation-runtime-queue-depth-max-not-two",
    ],
    [
      "inflight max exactly one",
      (artifact) => { artifact.observations.runtime.inFlightMax = 0; },
      "stale-generation-runtime-inflight-max-not-one",
    ],
    [
      "pending latest drop",
      (artifact) => { artifact.observations.runtime.pendingDropDelta = 0; },
      "stale-generation-pending-drop-not-observed",
    ],
    [
      "stale publication before and after",
      (artifact) => { artifact.observations.stalePublishCount.after = 1; },
      "stale-generation-publish-count-not-zero-before-and-after",
    ],
    [
      "runtime stale publication",
      (artifact) => { artifact.observations.runtime.stalePublishCount = 1; },
      "stale-generation-runtime-stale-publish-observed-or-missing",
    ],
    [
      "zero scene fallback",
      (artifact) => { artifact.observations.runtime.sceneFallbackCount = 1; },
      "stale-generation-scene-fallback-observed-or-missing",
    ],
    [
      "zero runtime fault",
      (artifact) => { artifact.observations.runtime.sceneRuntimeFaultCount = 1; },
      "stale-generation-runtime-fault-observed-or-missing",
    ],
    [
      "zero legacy fallback",
      (artifact) => { artifact.observations.runtime.legacyFallbackSucceededCount = 1; },
      "stale-generation-legacy-fallback-observed-or-missing",
    ],
  ]) {
    const artifact = staleGenerationArtifact();
    mutate(artifact);
    const assessment = assessDrawingRollbackDrillArtifact(
      "worker-stale-generation",
      artifact,
    );
    assert.equal(assessment.contractPassed, false, label);
    assert.ok(assessment.failures.includes(reason), label);
  }
});

test("IndexedDB drill remains external-artifact-untrusted after its strict contract passes", () => {
  const valid = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", indexedDbArtifact());
  assert.equal(valid.passed, false);
  assert.equal(valid.contractPassed, true, valid.failures.join(", "));
  assert.equal(valid.trustedRunnerAccepted, false);
  assert.deepEqual(valid.failures, ["external-artifact-untrusted-controlled-runner-required"]);

  const emptyNativeQuotaMessage = indexedDbArtifact();
  emptyNativeQuotaMessage.variants[0].errorReceipt.message = "";
  const emptyMessageAssessment = assessDrawingRollbackDrillArtifact(
    "indexeddb-quota-blocked",
    emptyNativeQuotaMessage,
  );
  assert.equal(emptyMessageAssessment.contractPassed, true, emptyMessageAssessment.failures.join(", "));

  const missingQuotaMessage = indexedDbArtifact();
  delete missingQuotaMessage.variants[0].errorReceipt.message;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "indexeddb-quota-blocked",
    missingQuotaMessage,
  ).failures.includes("indexeddb-quota-error-receipt-invalid"));

  const oneVariant = indexedDbArtifact();
  oneVariant.variants.pop();
  const missing = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", oneVariant);
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes("indexeddb-variant-count-mismatch"));
  assert.ok(missing.failures.includes("indexeddb-blocked-variant-missing"));

  for (const [kind, mutate, reason, label] of [
    [
      "quota",
      (variant) => { variant.faultBinding.runId = "phase9-other-run"; },
      "indexeddb-quota-fault-binding-invalid",
      "fault binding must match the controlled run",
    ],
    [
      "blocked",
      (variant) => { variant.nativeReceipt.authorityTokenSha256 = digest("f"); },
      "indexeddb-blocked-native-fault-binding-mismatch",
      "native receipt must carry the bound token digest",
    ],
    [
      "quota",
      (variant) => { variant.errorReceipt.faultId = "foreign-fault"; },
      "indexeddb-quota-error-receipt-invalid",
      "product error must carry the bound fault id",
    ],
    [
      "blocked",
      (variant) => { variant.stateReceipts[1].authorityTokenSha256 = digest("f"); },
      "indexeddb-blocked-state-receipt-sequence-invalid",
      "pending state receipts must carry the bound token digest",
    ],
    [
      "quota",
      (variant) => { variant.retryReceipt.runId = "phase9-other-run"; },
      "indexeddb-quota-retry-identity-invalid",
      "retry must remain bound to the controlled run",
    ],
    [
      "blocked",
      (variant) => { variant.coldReloadReceipt.faultId = "foreign-fault"; },
      "indexeddb-blocked-cold-reload-identity-invalid",
      "cold reload must remain bound to the fault",
    ],
    [
      "quota",
      (_variant, artifact) => { artifact.injection.buildAuthorityCurrent = false; },
      "indexeddb-current-build-authority-not-proven",
      "injection must be attached to the current build",
    ],
  ]) {
    assertIndexedDbMutation(kind, mutate, reason, label);
  }

  const duplicateFault = indexedDbArtifact();
  duplicateFault.variants[1].faultBinding.faultId = duplicateFault.variants[0].faultBinding.faultId;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "indexeddb-quota-blocked",
    duplicateFault,
  ).failures.includes("indexeddb-fault-ids-not-distinct"));

  const duplicateTransaction = indexedDbArtifact();
  duplicateTransaction.variants[1].transactionId = duplicateTransaction.variants[0].transactionId;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "indexeddb-quota-blocked",
    duplicateTransaction,
  ).failures.includes("indexeddb-transaction-ids-not-distinct"));

  const duplicateNativeReceipt = indexedDbArtifact();
  duplicateNativeReceipt.variants[1].nativeReceipt.receiptId =
    duplicateNativeReceipt.variants[0].nativeReceipt.receiptId;
  assert.ok(assessDrawingRollbackDrillArtifact(
    "indexeddb-quota-blocked",
    duplicateNativeReceipt,
  ).failures.includes("indexeddb-native-receipt-ids-not-distinct"));
});

test("IndexedDB failure preserves the exact old record and manifest while pending identity stays stable", () => {
  for (const [mutate, reason, label] of [
    [
      (variant) => { variant.durableRecord.afterFailure.canonicalBytesDigest = digest("f"); },
      "indexeddb-quota-durable-record-changed-on-failure",
      "canonical structured-clone bytes changed",
    ],
    [
      (variant) => { variant.durableRecord.afterFailure.documentDigest = digest("f"); },
      "indexeddb-quota-durable-record-changed-on-failure",
      "old canonical document changed",
    ],
    [
      (variant) => { variant.durableRecord.afterFailure.documentRevision += 1; },
      "indexeddb-quota-durable-record-changed-on-failure",
      "old durable revision changed",
    ],
    [
      (variant) => { variant.durableRecord.beforeFailure.documentSchemaVersion = 2; },
      "indexeddb-quota-old-durable-record-invalid",
      "old record schema is not canonical v1",
    ],
    [
      (variant) => { variant.manifest.afterFailure.rawBytesDigest = digest("f"); },
      "indexeddb-quota-manifest-changed-on-failure",
      "raw manifest bytes changed",
    ],
    [
      (variant) => { variant.manifest.afterFailure.count += 1; },
      "indexeddb-quota-manifest-changed-on-failure",
      "decoded manifest count changed",
    ],
    [
      (variant) => { variant.manifest.beforeFailure.revision += 1; },
      "indexeddb-quota-old-record-manifest-mismatch",
      "old manifest no longer describes the old record",
    ],
    [
      (variant) => { variant.manifest.beforeFailure.manifestSchemaVersion = 2; },
      "indexeddb-quota-old-manifest-invalid",
      "old manifest schema is not v1",
    ],
    [
      (variant) => { variant.stateReceipts[1].scopeKey = "binance:spot:ETHUSDT__main"; },
      "indexeddb-quota-pending-document-state-mismatch",
      "pending scope changed after failure",
    ],
    [
      (variant) => { variant.stateReceipts[2].documentRevision += 1; },
      "indexeddb-quota-pending-document-state-mismatch",
      "pending revision changed after retry",
    ],
    [
      (variant) => { variant.stateReceipts[1].entityCount += 1; },
      "indexeddb-quota-pending-document-state-mismatch",
      "pending entity count changed after failure",
    ],
    [
      (variant) => { variant.stateReceipts[1].documentDigest = digest("f"); },
      "indexeddb-quota-pending-document-state-mismatch",
      "pending document digest changed after failure",
    ],
    [
      (variant) => {
        for (const state of variant.stateReceipts) state.documentRevision = 7;
      },
      "indexeddb-quota-pending-document-not-newer-than-durable",
      "pending document must be newer than the preserved record",
    ],
    [
      (variant) => { variant.stateReceipts[1].dirty = false; },
      "indexeddb-quota-dirty-state-transition-invalid",
      "failed write must remain dirty",
    ],
    [
      (variant) => { variant.stateReceipts[0].documentDigest = "not-a-digest"; },
      "indexeddb-quota-pending-document-receipt-invalid",
      "pending receipt digest must be canonical",
    ],
    [
      (variant) => { variant.failureMetrics.after = variant.failureMetrics.before; },
      "indexeddb-quota-failure-metric-missing",
      "failure metric must advance",
    ],
  ]) {
    assertIndexedDbMutation("quota", mutate, reason, label);
  }
});

test("IndexedDB retry durably commits the pending record and decoded manifest identity", () => {
  for (const [mutate, reason, label] of [
    [
      (variant) => { variant.retryReceipt.durableRecord.canonicalBytesDigest = "not-a-digest"; },
      "indexeddb-quota-retry-durable-record-invalid",
      "retry canonical bytes digest is invalid",
    ],
    [
      (variant) => { variant.retryReceipt.durableRecord.documentDigest = digest("f"); },
      "indexeddb-quota-retry-durable-record-pending-mismatch",
      "retry document digest does not equal pending",
    ],
    [
      (variant) => { variant.retryReceipt.durableRecord.entityCount += 1; },
      "indexeddb-quota-retry-durable-record-pending-mismatch",
      "retry durable entity count does not equal pending",
    ],
    [
      (variant) => { variant.retryReceipt.manifest.rawBytesDigest = "not-a-digest"; },
      "indexeddb-quota-retry-manifest-invalid",
      "retry raw manifest digest is invalid",
    ],
    [
      (variant) => { variant.retryReceipt.manifest.manifestSchemaVersion = 2; },
      "indexeddb-quota-retry-manifest-invalid",
      "retry manifest schema is not v1",
    ],
    [
      (variant) => { variant.retryReceipt.manifest.scopeKey = "binance:spot:ETHUSDT__main"; },
      "indexeddb-quota-retry-manifest-pending-mismatch",
      "retry manifest scope does not equal pending",
    ],
    [
      (variant) => { variant.retryReceipt.manifest.revision += 1; },
      "indexeddb-quota-retry-manifest-pending-mismatch",
      "retry manifest revision does not equal pending",
    ],
    [
      (variant) => { variant.retryReceipt.manifest.count += 1; },
      "indexeddb-quota-retry-manifest-pending-mismatch",
      "retry manifest count does not equal pending",
    ],
    [
      (variant) => { variant.retryReceipt.committedAt = "2026-07-16T08:00:22.900Z"; },
      "indexeddb-quota-retry-identity-invalid",
      "retry commit predates its attempt",
    ],
    [
      (variant) => { variant.retryReceipt.attemptedAt = "2026-07-16T08:00:30.000Z"; },
      "indexeddb-quota-receipt-order-invalid",
      "retry occurs after the after-retry state receipt",
    ],
  ]) {
    assertIndexedDbMutation("quota", mutate, reason, label);
  }
});

test("IndexedDB cold reload proves a fresh v2 document instance and current paint", () => {
  for (const [mutate, reason, label] of [
    [
      (variant) => {
        const receipt = variant.coldReloadReceipt;
        receipt.beforeBrowserInstanceId = receipt.beforeDocumentInstanceId;
        receipt.afterBrowserInstanceId = receipt.afterDocumentInstanceId;
        delete receipt.beforeDocumentInstanceId;
        delete receipt.afterDocumentInstanceId;
      },
      "indexeddb-quota-cold-reload-document-instance-invalid",
      "legacy browser instance field names cannot prove a fresh document instance",
    ],
    [
      (variant) => {
        variant.coldReloadReceipt.afterDocumentInstanceId =
          variant.coldReloadReceipt.beforeDocumentInstanceId;
      },
      "indexeddb-quota-cold-reload-document-instance-invalid",
      "cold reload reused the same document instance",
    ],
    [
      (variant) => { variant.coldReloadReceipt.restoreSource = "legacy"; },
      "indexeddb-quota-cold-reload-source-not-v2",
      "restore source is not v2",
    ],
    [
      (variant) => { variant.coldReloadReceipt.restoredDocument.documentDigest = digest("f"); },
      "indexeddb-quota-cold-reload-document-pending-mismatch",
      "restored document does not equal pending",
    ],
    [
      (variant) => { variant.coldReloadReceipt.durableRecord.canonicalBytesDigest = digest("f"); },
      "indexeddb-quota-cold-reload-durable-record-mismatch",
      "cold reload record is not the exact retry record",
    ],
    [
      (variant) => { variant.coldReloadReceipt.manifest.rawBytesDigest = digest("f"); },
      "indexeddb-quota-cold-reload-manifest-mismatch",
      "cold reload manifest is not the exact retry manifest",
    ],
    [
      (variant) => { variant.coldReloadReceipt.queueDepthCurrent = 1; },
      "indexeddb-quota-cold-reload-state-not-converged",
      "cold reload queue did not converge",
    ],
    [
      (variant) => { variant.coldReloadReceipt.dirty = true; },
      "indexeddb-quota-cold-reload-state-not-converged",
      "cold reload document remained dirty",
    ],
    [
      (variant) => { variant.coldReloadReceipt.lastRequestedStamp.documentRevision += 1; },
      "indexeddb-quota-cold-reload-current-stamp-invalid",
      "requested stamp is not the restored revision",
    ],
    [
      (variant) => { variant.coldReloadReceipt.lastPaintedStamp.viewportRevision += 1; },
      "indexeddb-quota-cold-reload-current-stamp-invalid",
      "painted stamp is not current",
    ],
    [
      (variant) => { variant.coldReloadReceipt.paintReceipt.stamp.viewportRevision += 1; },
      "indexeddb-quota-cold-reload-paint-receipt-invalid",
      "independent paint receipt does not acknowledge the painted stamp",
    ],
    [
      (variant) => { variant.coldReloadReceipt.observedAt = "2026-07-16T08:00:58.000Z"; },
      "indexeddb-quota-receipt-order-invalid",
      "cold reload receipt predates its paint receipt",
    ],
  ]) {
    assertIndexedDbMutation("quota", mutate, reason, label);
  }
});

test("quota variant requires a native run-bound cache-expiry probe and explicit restoration", () => {
  for (const [mutate, reason, label] of [
    [
      (variant) => { variant.nativeReceipt.kind = "synthetic-quota-error"; },
      "indexeddb-quota-native-receipt-kind-invalid",
      "quota receipt is synthetic",
    ],
    [
      (variant) => { variant.nativeReceipt.runId = "phase9-other-run"; },
      "indexeddb-quota-native-fault-binding-mismatch",
      "quota receipt is from another run",
    ],
    [
      (variant) => { variant.nativeReceipt.origin = "http://127.0.0.1:4174"; },
      "indexeddb-quota-native-origin-mismatch",
      "quota override targets another origin",
    ],
    [
      (variant) => {
        const databaseName = "foreign-quota-database";
        variant.nativeReceipt.sacrificialDbName = databaseName;
        variant.nativeReceipt.preparation.databaseName = databaseName;
        variant.nativeReceipt.probe.databaseName = databaseName;
        variant.nativeReceipt.cleanup.databaseName = databaseName;
      },
      "indexeddb-quota-sacrificial-database-invalid",
      "quota evidence is not bound to the exact run-scoped database",
    ],
    [
      (variant) => {
        const databaseName = "candlescope-drawings-v2";
        variant.nativeReceipt.sacrificialDbName = databaseName;
        variant.nativeReceipt.preparation.databaseName = databaseName;
        variant.nativeReceipt.probe.databaseName = databaseName;
        variant.nativeReceipt.cleanup.databaseName = databaseName;
      },
      "indexeddb-quota-sacrificial-database-invalid",
      "quota probe targets the product database",
    ],
    [
      (variant) => { variant.nativeReceipt.preparation.baselineCommitted = false; },
      "indexeddb-quota-preparation-invalid",
      "quota baseline did not commit before the override",
    ],
    [
      (variant) => { variant.nativeReceipt.preparation.storeName = "foreign-store"; },
      "indexeddb-quota-preparation-invalid",
      "quota preparation store is not the exact sacrificial probe store",
    ],
    [
      (variant) => { variant.nativeReceipt.preparation.baselineKey = "foreign-baseline"; },
      "indexeddb-quota-preparation-invalid",
      "quota preparation baseline key is not exact",
    ],
    [
      (variant) => {
        variant.nativeReceipt.preparation.preparedAt = "2026-07-16T08:00:19.700Z";
      },
      "indexeddb-quota-native-receipt-order-invalid",
      "quota baseline preparation occurred after the before-usage receipt",
    ],
    [
      (variant) => { variant.nativeReceipt.cacheExpiryGuard.requestedWaitMs = 34_999; },
      "indexeddb-quota-cache-expiry-guard-invalid",
      "quota bucket-space cache wait was requested for less than 35 seconds",
    ],
    [
      (variant) => { variant.nativeReceipt.cacheExpiryGuard.elapsedMs = 34_999; },
      "indexeddb-quota-cache-expiry-guard-invalid",
      "quota bucket-space cache wait elapsed for less than 35 seconds",
    ],
    [
      (variant) => { variant.nativeReceipt.cacheExpiryGuard.guardMs = 4_999; },
      "indexeddb-quota-cache-expiry-guard-invalid",
      "quota cache limit and guard arithmetic drifted",
    ],
    [
      (variant) => {
        variant.nativeReceipt.cacheExpiryGuard.completedAt = "2026-07-16T08:00:19.949Z";
      },
      "indexeddb-quota-native-receipt-order-invalid",
      "quota cache wait timestamps are not ordered",
    ],
    [
      (variant) => {
        variant.nativeReceipt.probe.transactionError = null;
        variant.nativeReceipt.probe.nativeQuotaExceeded = false;
      },
      "indexeddb-quota-probe-invalid",
      "quota probe transaction succeeded",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.databaseName = "foreign-quota-database"; },
      "indexeddb-quota-probe-invalid",
      "quota probe targets another database",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.storeName = "foreign-store"; },
      "indexeddb-quota-probe-invalid",
      "quota probe targets another store",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.transactionMode = "readonly"; },
      "indexeddb-quota-probe-invalid",
      "quota probe is not a native readwrite transaction",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.settled = "success"; },
      "indexeddb-quota-probe-invalid",
      "quota probe did not settle through a native transaction abort",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.transactionError.name = "AbortError"; },
      "indexeddb-quota-probe-invalid",
      "quota probe transaction reports the wrong native error",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.abortEvent.isTrusted = false; },
      "indexeddb-quota-native-trusted-abort-invalid",
      "quota probe abort event is not trusted browser evidence",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.completed = false; },
      "indexeddb-quota-native-cleanup-invalid",
      "quota cleanup did not complete",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.connectionClosed = false; },
      "indexeddb-quota-native-cleanup-invalid",
      "quota probe connection remained open",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.storeName = "foreign-store"; },
      "indexeddb-quota-native-cleanup-invalid",
      "quota cleanup targets another store",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.deletion.status = "error"; },
      "indexeddb-quota-native-cleanup-invalid",
      "quota probe database deletion failed",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.databaseStillPresent = true; },
      "indexeddb-quota-native-cleanup-invalid",
      "quota probe database remains present",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.forcedCleanup = true; },
      "indexeddb-quota-native-cleanup-invalid",
      "quota lifecycle only completed through forced cleanup",
    ],
    [
      (variant) => { variant.nativeReceipt.forcedCleanup = true; },
      "indexeddb-quota-native-override-state-invalid",
      "quota controller reports forced cleanup",
    ],
    [
      (variant) => { variant.nativeReceipt.overrideCommand.quotaSize = 0; },
      "indexeddb-quota-native-override-command-invalid",
      "zero-byte quota would take Chromium's unlimited path",
    ],
    [
      (variant) => { variant.nativeReceipt.quotaPlan.kind = "zero-byte-quota"; },
      "indexeddb-quota-plan-invalid",
      "quota plan does not use the nonzero-below-existing-usage strategy",
    ],
    [
      (variant) => { variant.nativeReceipt.quotaPlan.quotaSizeBytes = 0; },
      "indexeddb-quota-plan-invalid",
      "quota plan requests Chromium's zero-byte unlimited path",
    ],
    [
      (variant) => { variant.nativeReceipt.quotaPlan.baselineUsageBytes += 1; },
      "indexeddb-quota-plan-invalid",
      "quota plan baseline usage drifts from the protocol before receipt",
    ],
    [
      (variant) => { variant.nativeReceipt.quotaPlan.baselineUsageExceedsQuota = false; },
      "indexeddb-quota-plan-invalid",
      "quota plan does not prove existing usage exceeds its one-byte quota",
    ],
    [
      (variant) => {
        variant.nativeReceipt.usageAndQuota.before.usageBytes = 1;
        variant.nativeReceipt.quotaPlan.baselineUsageBytes = 1;
      },
      "indexeddb-quota-native-usage-receipts-invalid",
      "baseline usage does not exceed the fixed one-byte quota",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.before.quotaBytes = 1; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "baseline quota is not greater than the fixed one-byte override",
    ],
    [
      (variant) => { variant.nativeReceipt.clearCommand.quotaSize = 0; },
      "indexeddb-quota-native-clear-command-invalid",
      "quota clear command did not omit quotaSize",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.before.method = "Storage.getCookies"; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "before snapshot is not Storage.getUsageAndQuota",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.overridden.quotaBytes = 0; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "overridden quota is not the exact one-byte plan",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.afterCacheExpiry.quotaBytes = 0; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "post-cache-expiry quota is not the exact one-byte plan",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.before.overrideActive = true; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "quota override was already active before preparation",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.overridden.overrideActive = false; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "immediate protocol receipt does not report an active override",
    ],
    [
      (variant) => {
        variant.nativeReceipt.usageAndQuota.afterCacheExpiry.overrideActive = false;
      },
      "indexeddb-quota-native-usage-receipts-invalid",
      "post-cache-expiry protocol receipt lost the override",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.restored.overrideActive = true; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "restored protocol receipt still reports an active override",
    ],
    [
      (variant) => { variant.nativeReceipt.usageAndQuota.restored.quotaBytes += 1; },
      "indexeddb-quota-native-usage-receipts-invalid",
      "restored quota does not equal the before snapshot",
    ],
    [
      (variant) => { variant.nativeReceipt.overrideActive = false; },
      "indexeddb-quota-native-override-state-invalid",
      "quota override was not active during the fault",
    ],
    [
      (variant) => { variant.nativeReceipt.productErrorReceiptId = "foreign-error"; },
      "indexeddb-quota-product-error-binding-mismatch",
      "native quota evidence is not bound to the product error",
    ],
    [
      (variant) => {
        variant.nativeReceipt.usageAndQuota.overridden.observedAt = "2026-07-16T08:00:19.750Z";
      },
      "indexeddb-quota-native-receipt-order-invalid",
      "quota observation predates the override command",
    ],
    [
      (variant) => {
        variant.nativeReceipt.usageAndQuota.before.observedAt = "2026-07-16T08:00:20.050Z";
      },
      "indexeddb-quota-native-receipt-order-invalid",
      "native quota setup did not finish before the bound before-write receipt",
    ],
    [
      (variant) => { variant.nativeReceipt.probe.observedAt = "2026-07-16T08:00:55.150Z"; },
      "indexeddb-quota-native-receipt-order-invalid",
      "quota probe settled after the product write began",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.completedAt = "2026-07-16T08:00:55.350Z"; },
      "indexeddb-quota-native-receipt-order-invalid",
      "quota cleanup predates the override clear command",
    ],
    [
      (variant) => { variant.retryReceipt.attemptedAt = "2026-07-16T08:00:55.550Z"; },
      "indexeddb-quota-native-receipt-order-invalid",
      "product retry began before restored quota was observed",
    ],
    [
      (variant) => { variant.errorReceipt.nativeReceiptId = "foreign-native-receipt"; },
      "indexeddb-quota-error-receipt-invalid",
      "product error is not bound back to native evidence",
    ],
  ]) {
    assertIndexedDbMutation("quota", mutate, reason, label);
  }
});

test("quota cache expiry duration is authoritative from monotonic elapsed time", () => {
  const artifact = indexedDbArtifact();
  const quota = artifact.variants.find((variant) => variant.kind === "quota");
  quota.nativeReceipt.cacheExpiryGuard.completedAt = "2026-07-16T08:00:54.949Z";
  const result = assessDrawingRollbackDrillArtifact("indexeddb-quota-blocked", artifact);
  assert.equal(result.contractPassed, true, result.failures.join(", "));
});

test("blocked variant requires a trusted native sacrificial database lifecycle and cleanup", () => {
  for (const [mutate, reason, label] of [
    [
      (variant) => { variant.nativeReceipt.kind = "synthetic-blocked-event"; },
      "indexeddb-blocked-native-receipt-kind-invalid",
      "blocked receipt is synthetic",
    ],
    [
      (variant) => { variant.nativeReceipt.authorityTokenSha256 = digest("f"); },
      "indexeddb-blocked-native-fault-binding-mismatch",
      "blocked receipt is not bound to the authority token",
    ],
    [
      (variant) => { variant.nativeReceipt.sacrificialDbName = "candlescope-drawings-v2"; },
      "indexeddb-blocked-sacrificial-database-invalid",
      "blocked proof targets the production database",
    ],
    [
      (variant) => { variant.nativeReceipt.keeperConnection.openedVersion = 2; },
      "indexeddb-blocked-keeper-lifecycle-invalid",
      "keeper did not hold version one",
    ],
    [
      (variant) => { variant.nativeReceipt.upgradeOpenRequest.requestedVersion = 1; },
      "indexeddb-blocked-open-lifecycle-invalid",
      "upgrade request did not target version two",
    ],
    [
      (variant) => { variant.nativeReceipt.upgradeOpenRequest.blockedEvent.isTrusted = false; },
      "indexeddb-blocked-native-trusted-event-invalid",
      "blocked event is not native trusted browser evidence",
    ],
    [
      (variant) => {
        variant.nativeReceipt.upgradeOpenRequest.blockedEvent.databaseName = "foreign-db";
      },
      "indexeddb-blocked-native-trusted-event-invalid",
      "blocked event targets another database",
    ],
    [
      (variant) => { variant.nativeReceipt.productErrorReceiptId = "foreign-error"; },
      "indexeddb-blocked-product-error-binding-mismatch",
      "native blocked evidence is not bound to the product error",
    ],
    [
      (variant) => { variant.errorReceipt.caughtByProduct = false; },
      "indexeddb-blocked-product-error-binding-mismatch",
      "blocked error was not observed by the product flush",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.deleteSucceeded = false; },
      "indexeddb-blocked-native-cleanup-invalid",
      "sacrificial database deletion failed",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.databaseAbsent = false; },
      "indexeddb-blocked-native-cleanup-invalid",
      "sacrificial database still exists",
    ],
    [
      (variant) => {
        variant.nativeReceipt.keeperConnection.closedAt = "2026-07-16T08:00:20.120Z";
      },
      "indexeddb-blocked-native-receipt-order-invalid",
      "keeper closed before the native blocked event",
    ],
    [
      (variant) => {
        variant.nativeReceipt.keeperConnection.openedAt = "2026-07-16T08:00:20.050Z";
      },
      "indexeddb-blocked-native-receipt-order-invalid",
      "sacrificial keeper did not open before the bound before-write receipt",
    ],
    [
      (variant) => { variant.nativeReceipt.cleanup.completedAt = "2026-07-16T08:00:23.500Z"; },
      "indexeddb-blocked-native-receipt-order-invalid",
      "retry began before sacrificial cleanup completed",
    ],
    [
      (variant) => { variant.errorReceipt.message = "generic blocked"; },
      "indexeddb-blocked-error-message-mismatch",
      "product blocked error message is not exact",
    ],
  ]) {
    assertIndexedDbMutation("blocked", mutate, reason, label);
  }
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
