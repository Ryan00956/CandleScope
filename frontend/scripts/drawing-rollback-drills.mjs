const DEDICATED_SCHEMA_VERSION = "drawing-rollback-drill/v2";
const PHASE6_SCHEMA_VERSION = "drawing-engine-v2-perf/v1";
const DRAWING_WORKER_SCHEMA_VERSION = 1;
const DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION = 1;
const DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION = 1;
const DRAWING_DOCUMENT_DATABASE_NAME = "candlescope-drawings-v2";

const DRAWING_KINDS = Object.freeze([
  "line",
  "axis-line",
  "angle-measure",
  "text",
  "fibonacci",
  "position",
  "shape",
  "freehand",
  "highlighter",
]);

const EXPORT_CHECKPOINT_TYPES = Object.freeze([
  "export-prepare",
  "series-rebuild-start",
  "series-rebuild-complete",
  "stale-lease-revalidate",
  "fresh-lease-revalidate",
  "export-capture",
  "lease-restored",
]);

const STAMP_FIELDS = Object.freeze([
  "scopeKey",
  "documentRevision",
  "surfaceGeneration",
  "dataRevision",
  "projectionRevision",
  "lineageIndexRevision",
  "viewportRevision",
  "themeRevision",
  "widthCssPx",
  "heightCssPx",
  "dpr",
]);

function componentTest(files, pattern, minimumPassCount) {
  return Object.freeze({ files: Object.freeze(files), pattern, minimumPassCount });
}

export const DRAWING_ROLLBACK_DRILL_MANIFEST = Object.freeze([
  Object.freeze({
    id: "worker-init-failure",
    title: "scene worker initialization failure",
    requiredEvidence: "headed production browser with a throwing drawing Worker constructor",
    currentCoverage: "component-only",
    missingEvidence: "browser constructor injection and current-paint/data-preservation proof",
    componentTest: componentTest([
      "src/features/drawings/worker/__tests__/drawingWorker.test.ts",
      "src/features/drawings/engine/__tests__/drawingSceneRuntime.test.ts",
    ], "client exposes forced fallback, construction, transport, protocol, and post failures|worker backend fails closed to the same indexed scene when Worker is unavailable", 2),
  }),
  Object.freeze({
    id: "offscreen-canvas-unsupported",
    title: "OffscreenCanvas unsupported",
    requiredEvidence: "headed production browser with OffscreenCanvas disabled inside the drawing worker",
    currentCoverage: "component-only",
    missingEvidence: "worker-global capability injection, sticky main-thread fallback, and a second request with no worker round-trip",
    componentTest: componentTest([
      "src/features/drawings/worker/__tests__/drawingWorker.test.ts",
      "src/features/drawings/engine/__tests__/drawingSceneRuntime.test.ts",
    ], "processor retains the typed fallback when the bitmap backing store exceeds its byte budget|bitmap capability fallback is sticky and avoids repeated worker round-trips", 2),
  }),
  Object.freeze({
    id: "indexeddb-quota-blocked",
    title: "IndexedDB quota and blocked",
    requiredEvidence: "headed production browser with deterministic quota and blocked variants",
    currentCoverage: "component-only",
    missingEvidence: "native browser quota/blocked injection, retry, and restored-pending-document proof",
    componentTest: componentTest([
      "src/features/drawings/persistence/__tests__/drawingDocumentRepository.test.ts",
      "src/features/drawings/persistence/__tests__/drawingPersistenceCoordinator.test.ts",
      "src/features/drawings/persistence/__tests__/legacyDrawingImporter.test.ts",
    ], "IDB failure preserves the previous record and manifest bytes|failed transaction retains dirty latest job, status, and old record|legacy compatibility write is single-shot and preserves old bytes on quota failure", 3),
  }),
  Object.freeze({
    id: "worker-stale-generation",
    title: "worker returns a stale generation",
    requiredEvidence: "formal Phase 6 headed production backpressure run or an equivalent dedicated browser drill",
    currentCoverage: "component-and-formal-backpressure",
    missingEvidence: "a controlled browser drill must record the returned and accepted worker generation identities",
    componentTest: componentTest([
      "src/features/drawings/worker/__tests__/drawingWorker.test.ts",
      "src/features/drawings/engine/__tests__/drawingSceneRuntime.test.ts",
    ], "client rejects matching-but-obsolete and unexpected results without publishing them|worker frame-stale preflight is a stale result drop, not a stale publication|a rejected worker publication increments the observable stale-publish invariant", 3),
  }),
  Object.freeze({
    id: "active-gesture-chart-boundary",
    title: "chart type or interval changes during an active gesture",
    requiredEvidence: "headed production browser variants for both chart-type and interval boundaries",
    currentCoverage: "component-only",
    missingEvidence: "active gesture to boundary-owned cancellation with an unchanged same-scope canonical document",
    componentTest: componentTest([
      "src/features/drawings/__tests__/drawingInteractionController.test.ts",
      "src/features/drawings/__tests__/drawingPersistenceLifecycle.test.ts",
      "scripts/chart-type-matrix.test.mjs",
      "scripts/short-switch-readiness.test.mjs",
    ], "surface disposal keeps transient state until the document barrier succeeds|requested symbol cannot mutate the previous active document|committed paint tickets reject non-exact surface and viewport coordinates|chart type matrix acceptance passes for the complete ordered contract|only the first warm step may prime from an already-active interval", 5),
  }),
  Object.freeze({
    id: "series-rebuild-before-export",
    title: "series rebuild immediately before export",
    requiredEvidence: "headed production browser rebuild between export preparation and capture",
    currentCoverage: "component-only",
    missingEvidence: "same-lease prepare/rebuild/capture race with exact drawing inclusion proof",
    componentTest: componentTest([
      "src/features/drawings/export/__tests__/drawingExportBarrier.test.ts",
      "src/features/drawings/legacy/__tests__/legacyPrimitiveRenderer.test.ts",
      "src/chart-adapter/__tests__/drawingScenePrimitiveBridge.test.ts",
    ], "export barrier runs the strict sequence and returns a complete idempotent lease|mismatched persistence and exact-scene identities fail closed|main-series replacement reattaches every entity after credential invalidation|scene bridge is idempotent and rejects stale surface generations", 4),
  }),
  Object.freeze({
    id: "continuous-dpr-resize",
    title: "continuous DPR and resize changes",
    requiredEvidence: "headed production browser session covering DPR 1, 1.5, and 2 plus repeated resize",
    currentCoverage: "component-and-static-browser",
    missingEvidence: "continuous same-session transitions and final worker/overlay/stamp convergence",
    componentTest: componentTest([
      "src/chart-adapter/__tests__/drawingFrameSnapshot.test.ts",
      "src/features/drawings/interaction/__tests__/liveInkController.test.ts",
      "scripts/drawing-performance-phase5.test.mjs",
      "scripts/drawing-performance-phase6.test.mjs",
    ], "theme, size, DPR, and surface have independent revision boundaries|live ink owns an exact DPR plot canvas and appends only new segments|phase5 requires distinct initial/final surfaces and rejects malformed pointer windows|formal Phase 6 rejects headless, hidden, and DPR-drifted browser evidence", 4),
  }),
  Object.freeze({
    id: "canary-to-legacy-snapshot",
    title: "legacy build reads the newest canary compatibility snapshot",
    requiredEvidence: "two production builds sharing one origin/profile: scene-canary write then legacy read",
    currentCoverage: "component-only",
    missingEvidence: "distinct rollout/build assets plus browser and server restart receipts in one same-origin/profile execution",
    componentTest: componentTest([
      "src/features/drawings/core/__tests__/drawingCodec.test.ts",
      "src/features/drawings/persistence/__tests__/legacyDrawingImporter.test.ts",
      "src/features/drawings/__tests__/drawingDocumentAuthority.test.ts",
      "src/features/drawings/legacy/__tests__/legacyPrimitiveRenderer.test.ts",
    ], "legacy v1, stroke v2, and mixed-anchor v3 freehand payloads round-trip|legacy importer reads v1/v2/v3 strictly without rewriting source bytes|drawing document authority only rolls back for the exact legacy value|renderer materializes and replaces snapshots in stable document z-order", 4),
  }),
]);

export const DRAWING_ROLLBACK_DRILL_IDS = Object.freeze(
  DRAWING_ROLLBACK_DRILL_MANIFEST.map((drill) => drill.id),
);

export function parseNodeTestTapPassCount(output) {
  const matches = [...String(output).matchAll(/^# pass (\d+)\s*$/gm)];
  if (matches.length === 0) return null;
  const value = Number(matches.at(-1)[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function appendNodeTestTapTail(previous, chunk, limit = 16_000) {
  if (!Number.isInteger(limit) || limit <= 0) return "";
  return `${String(previous)}${String(chunk)}`.slice(-limit);
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactZero(value) {
  return value === 0;
}

function emptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function sameNonEmptyString(left, right) {
  return nonEmptyString(left) && left === right;
}

function sha256Digest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sameSha256Digest(left, right) {
  return sha256Digest(left) && left === right;
}

function own(value, key) {
  return objectValue(value) !== null && Object.hasOwn(value, key);
}

function sameStamp(left, right) {
  const leftStamp = objectValue(left);
  const rightStamp = objectValue(right);
  if (!leftStamp || !rightStamp) return false;
  return STAMP_FIELDS.every((field) => leftStamp[field] === rightStamp[field])
    && nonEmptyString(leftStamp.scopeKey)
    && [
      "documentRevision",
      "surfaceGeneration",
      "dataRevision",
      "projectionRevision",
      "lineageIndexRevision",
      "viewportRevision",
      "themeRevision",
    ].every((field) => integer(leftStamp[field]) !== null && leftStamp[field] >= 0)
    && finiteNumber(leftStamp.widthCssPx) > 0
    && finiteNumber(leftStamp.heightCssPx) > 0
    && finiteNumber(leftStamp.dpr) > 0;
}

function validStamp(value) {
  return sameStamp(value, value);
}

function validWorkerIdentity(value) {
  const identity = objectValue(value);
  return identity !== null
    && identity.schemaVersion === DRAWING_WORKER_SCHEMA_VERSION
    && safePositiveInteger(identity.jobId) !== null
    && safePositiveInteger(identity.generation) !== null
    && validStamp(identity.stamp);
}

function sameWorkerIdentity(left, right) {
  return validWorkerIdentity(left)
    && validWorkerIdentity(right)
    && left.jobId === right.jobId
    && left.generation === right.generation
    && sameStamp(left.stamp, right.stamp);
}

function validCounterPair(value) {
  const pair = objectValue(value);
  return pair !== null
    && integer(pair.before) !== null
    && pair.before >= 0
    && integer(pair.after) !== null
    && pair.after >= pair.before;
}

function counterDelta(value) {
  return validCounterPair(value) ? value.after - value.before : null;
}

function exactZeroCounterPair(value) {
  return validCounterPair(value) && value.before === 0 && value.after === 0;
}

function validPaintReceipt(value, expectedStamp) {
  const receipt = objectValue(value);
  return receipt !== null
    && receipt.kind === "drawing-scene-bridge-paint-ack"
    && validTimestamp(receipt.observedAt)
    && sameStamp(receipt.stamp, expectedStamp);
}

function validRestartReceipt(value, kind, beforeInstanceId, afterInstanceId, binding) {
  const receipt = objectValue(value);
  if (!receipt) return false;
  const stoppedAtValid = validTimestamp(receipt.stoppedAt);
  const startedAtValid = validTimestamp(receipt.startedAt);
  return receipt.kind === kind
    && sameNonEmptyString(receipt.beforeInstanceId, beforeInstanceId)
    && sameNonEmptyString(receipt.afterInstanceId, afterInstanceId)
    && receipt.beforeInstanceId !== receipt.afterInstanceId
    && sameSha256Digest(receipt.beforeBuildFingerprint, binding?.beforeBuildFingerprint)
    && sameSha256Digest(receipt.afterBuildFingerprint, binding?.afterBuildFingerprint)
    && sameNonEmptyString(receipt.profileId, binding?.profileId)
    && sameNonEmptyString(receipt.scopeKey, binding?.scopeKey)
    && stoppedAtValid
    && startedAtValid
    && Date.parse(receipt.startedAt) >= Date.parse(receipt.stoppedAt);
}

function timestampsAreOrdered(values) {
  if (!Array.isArray(values) || values.length === 0 || !values.every(validTimestamp)) {
    return false;
  }
  return values.every((value, index) => (
    index === 0 || Date.parse(value) >= Date.parse(values[index - 1])
  ));
}

function validTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function addFailure(failures, condition, reason) {
  if (!condition) failures.push(reason);
}

function validateDedicatedCommon(drillId, artifact) {
  const failures = [];
  const report = objectValue(artifact);
  addFailure(failures, report !== null, "artifact-not-object");
  if (!report) return failures;

  const environment = objectValue(report.environment);
  const provenance = objectValue(report.provenance);
  const buildAuthority = objectValue(report.buildAuthority);
  const workerLifecycle = objectValue(buildAuthority?.workerLifecycle);
  const diagnostics = objectValue(report.diagnostics);
  const injection = objectValue(report.injection);

  addFailure(failures, report.schemaVersion === DEDICATED_SCHEMA_VERSION, "dedicated-schema-mismatch");
  addFailure(failures, report.drillId === drillId, "drill-id-mismatch");
  addFailure(failures, environment !== null, "environment-missing");
  addFailure(failures, environment?.productionBuild === true, "production-build-not-proven");
  addFailure(failures, environment?.headed === true, "headed-browser-not-proven");
  addFailure(failures, environment?.visibilityState === "visible", "visible-browser-not-proven");
  addFailure(failures, environment?.windowState === "normal", "normal-window-not-proven");
  addFailure(failures, nonEmptyString(environment?.browserVersion), "browser-version-missing");
  addFailure(failures, provenance !== null, "provenance-missing");
  addFailure(failures, nonEmptyString(provenance?.buildRevision), "build-revision-missing");
  addFailure(failures, nonEmptyString(provenance?.runId), "run-id-missing");
  addFailure(failures, validTimestamp(provenance?.startedAt), "started-at-invalid");
  addFailure(failures, validTimestamp(provenance?.completedAt), "completed-at-invalid");
  if (validTimestamp(provenance?.startedAt) && validTimestamp(provenance?.completedAt)) {
    addFailure(
      failures,
      Date.parse(provenance.completedAt) >= Date.parse(provenance.startedAt),
      "completion-precedes-start",
    );
  }
  addFailure(failures, buildAuthority !== null, "per-drill-build-authority-missing");
  addFailure(
    failures,
    buildAuthority?.kind === "controlled-browser-build-authority",
    "per-drill-build-authority-kind-invalid",
  );
  addFailure(failures, buildAuthority?.drillId === drillId, "per-drill-build-authority-id-mismatch");
  addFailure(failures, validTimestamp(buildAuthority?.capturedAt), "per-drill-build-authority-time-invalid");
  addFailure(failures, buildAuthority?.authoritative === true, "per-drill-build-not-authoritative");
  addFailure(
    failures,
    buildAuthority?.assetBuildAuthoritative === true,
    "per-drill-asset-build-not-authoritative",
  );
  addFailure(failures, nonEmptyString(buildAuthority?.buildId), "per-drill-build-id-missing");
  addFailure(failures, sha256Digest(buildAuthority?.buildFingerprint), "per-drill-build-fingerprint-invalid");
  addFailure(
    failures,
    sameSha256Digest(buildAuthority?.assetDigest, buildAuthority?.currentAssetDigest),
    "per-drill-asset-digest-mismatch",
  );
  addFailure(
    failures,
    sameSha256Digest(buildAuthority?.buildInputDigest, buildAuthority?.currentBuildInputDigest),
    "per-drill-build-input-digest-mismatch",
  );
  addFailure(
    failures,
    nonEmptyString(provenance?.buildRevision)
      && buildAuthority?.gitRevision === provenance.buildRevision,
    "per-drill-git-revision-mismatch",
  );
  addFailure(
    failures,
    nonEmptyString(buildAuthority?.managedOrigin)
      && buildAuthority?.observedOrigin === buildAuthority.managedOrigin,
    "per-drill-managed-origin-mismatch",
  );
  addFailure(failures, nonEmptyString(buildAuthority?.href), "per-drill-managed-document-missing");
  for (const [field, reason] of [
    ["matchesManagedOrigin", "per-drill-managed-origin-not-proven"],
    ["matchesManagedDocument", "per-drill-managed-document-not-proven"],
    ["entryAssetsLoaded", "per-drill-entry-assets-not-proven"],
    ["networkAssetAuthorityPassed", "per-drill-network-asset-authority-failed"],
    ["networkQuiescencePassed", "per-drill-network-quiescence-failed"],
    ["browserLoadedAssetsAccepted", "per-drill-browser-assets-not-accepted"],
    ["domLoadedAssetsAccepted", "per-drill-dom-assets-not-accepted"],
    ["expectedEntriesPresentInDom", "per-drill-entry-dom-assets-missing"],
    ["distMatchesBuild", "per-drill-dist-build-mismatch"],
    ["buildInputsMatch", "per-drill-build-inputs-mismatch"],
    ["gitMatchesBuild", "per-drill-git-build-mismatch"],
    ["managedOriginGuardPassed", "per-drill-origin-guard-failed"],
    ["workerDiagnosticsPassed", "per-drill-worker-diagnostics-failed"],
    ["handlerSettlementsPassed", "per-drill-handler-settlement-failed"],
  ]) {
    addFailure(failures, buildAuthority?.[field] === true, reason);
  }
  const workerTargets = Array.isArray(workerLifecycle?.targets) ? workerLifecycle.targets : null;
  const drawingWorkerTargetCount = integer(workerLifecycle?.drawingWorkerTargetCount);
  const activeDrawingWorkerTargetCount = integer(workerLifecycle?.activeDrawingWorkerTargetCount);
  const detachedDrawingWorkerTargetCount = integer(workerLifecycle?.detachedDrawingWorkerTargetCount);
  addFailure(failures, workerLifecycle !== null, "per-drill-worker-lifecycle-missing");
  addFailure(failures, workerLifecycle?.accepted === true, "per-drill-worker-lifecycle-not-accepted");
  addFailure(
    failures,
    workerLifecycle?.assetAuthorityAccepted === true,
    "per-drill-worker-asset-authority-not-accepted",
  );
  addFailure(
    failures,
    integer(workerLifecycle?.constructionFaultCount) !== null
      && workerLifecycle.constructionFaultCount >= 0,
    "per-drill-worker-construction-fault-count-invalid",
  );
  addFailure(
    failures,
    workerTargets !== null
      && drawingWorkerTargetCount !== null
      && drawingWorkerTargetCount >= 0
      && workerTargets.length === drawingWorkerTargetCount,
    "per-drill-worker-target-count-invalid",
  );
  addFailure(
    failures,
    activeDrawingWorkerTargetCount !== null
      && activeDrawingWorkerTargetCount >= 0
      && detachedDrawingWorkerTargetCount !== null
      && detachedDrawingWorkerTargetCount >= 0
      && drawingWorkerTargetCount !== null
      && activeDrawingWorkerTargetCount + detachedDrawingWorkerTargetCount
        === drawingWorkerTargetCount,
    "per-drill-worker-target-lifecycle-counts-invalid",
  );
  addFailure(
    failures,
    workerTargets?.every((target) => (
      objectValue(target) !== null
        && target.manifestBacked === true
        && target.constructorProvenanceAccepted === true
        && target.networkProvenanceAccepted === true
        && target.assetAccepted === true
        && sameSha256Digest(target.assetDigest, target.expectedAssetDigest)
    )) === true,
    "per-drill-worker-target-asset-authority-invalid",
  );
  addFailure(failures, injection !== null, "injection-missing");
  addFailure(failures, injection?.armed === true, "injection-not-armed");
  addFailure(failures, injection?.observed === true, "injection-not-observed");
  addFailure(failures, diagnostics !== null, "diagnostics-missing");
  addFailure(failures, exactZero(diagnostics?.crashCount), "browser-crash-observed-or-missing");
  addFailure(failures, emptyArray(diagnostics?.runtimeExceptions), "runtime-exceptions-observed-or-missing");
  addFailure(failures, emptyArray(diagnostics?.unhandledRejections), "unhandled-rejections-observed-or-missing");
  addFailure(failures, emptyArray(diagnostics?.unexpectedConsoleErrors), "unexpected-console-errors-observed-or-missing");

  return failures;
}

function validateDocumentPreserved(failures, outcome) {
  const value = objectValue(outcome);
  addFailure(failures, value !== null, "outcome-missing");
  addFailure(failures, sameSha256Digest(value?.beforeDigest, value?.afterDigest), "document-digest-mismatch");
  addFailure(
    failures,
    integer(value?.beforeEntityCount) !== null
      && integer(value?.beforeEntityCount) > 0
      && value.beforeEntityCount === value.afterEntityCount,
    "document-entity-count-mismatch",
  );
  addFailure(failures, value?.queueDepthCurrent === 0, "queue-not-converged");
  addFailure(failures, sameStamp(value?.lastRequestedStamp, value?.lastPublishedStamp), "published-stamp-not-current");
  addFailure(failures, own(value, "lastPaintedStamp"), "independent-painted-stamp-missing");
  addFailure(failures, sameStamp(value?.lastPublishedStamp, value?.lastPaintedStamp), "painted-stamp-not-current");
  addFailure(
    failures,
    validPaintReceipt(value?.paintReceipt, value?.lastPaintedStamp),
    "independent-paint-receipt-invalid-or-missing",
  );
}

function validateWorkerInitFailure(artifact) {
  const failures = validateDedicatedCommon("worker-init-failure", artifact);
  const buildAuthority = objectValue(artifact?.buildAuthority);
  const workerLifecycle = objectValue(buildAuthority?.workerLifecycle);
  const injection = objectValue(artifact?.injection);
  const observations = objectValue(artifact?.observations);
  const configuredRequest = objectValue(observations?.configuredRequest);
  const runtime = objectValue(observations?.runtime);
  addFailure(failures, injection?.kind === "worker-constructor-throws", "wrong-worker-init-injection");
  addFailure(
    failures,
    injection?.buildAuthorityCurrent === true,
    "worker-init-current-build-authority-not-proven",
  );
  addFailure(
    failures,
    buildAuthority?.fullBuildAuthoritative === true
      && buildAuthority?.networkAssetsPassed === true,
    "worker-init-live-build-authority-not-proven",
  );
  addFailure(
    failures,
    workerLifecycle?.kind === "construction-failed-before-target"
      && workerLifecycle?.drawingWorkerTargetCount === 0
      && workerLifecycle?.activeDrawingWorkerTargetCount === 0
      && workerLifecycle?.detachedDrawingWorkerTargetCount === 0
      && workerLifecycle?.constructionFaultCount === 1,
    "worker-init-build-authority-lifecycle-invalid",
  );
  addFailure(
    failures,
    configuredRequest?.engineMode === "scene-canary"
      && configuredRequest?.backend === "worker"
      && configuredRequest?.engineModeSource === "environment"
      && configuredRequest?.backendSource === "environment",
    "worker-init-configured-environment-worker-request-invalid-or-missing",
  );
  addFailure(failures, runtime?.engineMode === "scene-canary", "worker-init-runtime-not-scene-canary");
  addFailure(failures, runtime?.backend === "main-thread", "worker-init-runtime-backend-not-main-thread");
  addFailure(failures, runtime?.backendSource === "environment", "worker-init-runtime-backend-source-not-environment");
  addFailure(failures, runtime?.workerAvailability === "unavailable", "worker-init-worker-availability-not-unavailable");
  addFailure(
    failures,
    runtime?.workerUnavailableReason === "construction-failed",
    "worker-init-unavailable-reason-not-construction-failed",
  );
  addFailure(failures, runtime?.attachedPrimitiveCount === 1, "worker-init-attached-primitive-count-not-one");
  addFailure(failures, runtime?.scenePublicationReady === true, "worker-init-scene-publication-not-ready");
  addFailure(failures, exactZero(runtime?.sceneFallbackCount), "worker-init-scene-fallback-observed-or-missing");
  addFailure(failures, exactZero(runtime?.sceneRuntimeFaultCount), "worker-init-runtime-fault-observed-or-missing");
  addFailure(failures, exactZero(runtime?.legacyFallbackSucceededCount), "worker-init-legacy-fallback-observed-or-missing");
  addFailure(failures, exactZero(runtime?.stalePublishCount), "worker-init-stale-publish-observed-or-missing");
  addFailure(
    failures,
    exactZeroCounterPair(observations?.stalePublishCount),
    "worker-init-stale-publish-counter-not-zero-before-and-after",
  );
  addFailure(
    failures,
    counterDelta(observations?.workerConstructorAttempts) === 1,
    "worker-constructor-attempt-count-invalid",
  );
  addFailure(
    failures,
    counterDelta(observations?.workerConstructionFailures) === 1,
    "worker-construction-failure-count-invalid",
  );
  addFailure(failures, observations?.fallbackBackend === "main-thread", "main-thread-fallback-not-active");
  addFailure(failures, finiteNumber(observations?.scenePublicationCountDelta) > 0, "scene-publication-not-observed");
  addFailure(failures, counterDelta(observations?.workerJobs) === 0, "worker-job-ran-after-construction-failure");
  validateDocumentPreserved(failures, artifact?.outcome);
  return failures;
}

function validateOffscreenUnsupported(artifact) {
  const failures = validateDedicatedCommon("offscreen-canvas-unsupported", artifact);
  const buildAuthority = objectValue(artifact?.buildAuthority);
  const workerLifecycle = objectValue(buildAuthority?.workerLifecycle);
  const injection = objectValue(artifact?.injection);
  const capabilityReceipt = objectValue(injection?.capabilityReceipt);
  const observations = objectValue(artifact?.observations);
  const configuredRequest = objectValue(observations?.configuredRequest);
  const runtime = objectValue(observations?.runtime);
  const firstRequest = objectValue(observations?.firstRequest);
  const secondRequest = objectValue(observations?.secondRequest);
  const workerRoundTrips = objectValue(observations?.workerRoundTrips);
  const roundTripsBefore = integer(workerRoundTrips?.before);
  const roundTripsAfterFirst = integer(workerRoundTrips?.afterFirstRequest);
  const roundTripsAfterSecond = integer(workerRoundTrips?.afterSecondRequest);
  addFailure(failures, injection?.kind === "offscreen-canvas-unavailable", "wrong-offscreen-injection");
  addFailure(
    failures,
    injection?.buildAuthorityCurrent === true,
    "offscreen-current-build-authority-not-proven",
  );
  addFailure(
    failures,
    buildAuthority?.fullBuildAuthoritative === false
      && buildAuthority?.networkAssetsPassed === false
      && buildAuthority?.assetBuildAuthoritative === true
      && buildAuthority?.networkAssetAuthorityPassed === true,
    "offscreen-detached-worker-asset-authority-invalid",
  );
  addFailure(
    failures,
    workerLifecycle?.kind === "detached-after-typed-fallback"
      && workerLifecycle?.drawingWorkerTargetCount === 1
      && workerLifecycle?.activeDrawingWorkerTargetCount === 0
      && workerLifecycle?.detachedDrawingWorkerTargetCount === 1
      && workerLifecycle?.constructionFaultCount === 0,
    "offscreen-build-authority-lifecycle-invalid",
  );
  addFailure(
    failures,
    capabilityReceipt?.realm === "drawing-worker-global"
      && capabilityReceipt?.capability === "OffscreenCanvas"
      && capabilityReceipt?.supported === false
      && capabilityReceipt?.beforeType === "function"
      && capabilityReceipt?.afterType === "undefined",
    "offscreen-worker-global-capability-receipt-invalid-or-missing",
  );
  addFailure(
    failures,
    configuredRequest?.engineMode === "scene-canary"
      && configuredRequest?.backend === "worker"
      && configuredRequest?.engineModeSource === "environment"
      && configuredRequest?.backendSource === "environment",
    "offscreen-configured-environment-worker-request-invalid-or-missing",
  );
  addFailure(failures, runtime?.engineMode === "scene-canary", "offscreen-runtime-not-scene-canary");
  addFailure(failures, runtime?.backend === "main-thread", "offscreen-runtime-backend-not-main-thread");
  addFailure(failures, runtime?.backendSource === "environment", "offscreen-runtime-backend-source-not-environment");
  addFailure(failures, runtime?.attachedPrimitiveCount === 1, "offscreen-attached-primitive-count-not-one");
  addFailure(failures, runtime?.scenePublicationReady === true, "offscreen-scene-publication-not-ready");
  addFailure(failures, exactZero(runtime?.sceneFallbackCount), "offscreen-scene-fallback-observed-or-missing");
  addFailure(failures, exactZero(runtime?.sceneRuntimeFaultCount), "offscreen-runtime-fault-observed-or-missing");
  addFailure(failures, exactZero(runtime?.legacyFallbackSucceededCount), "offscreen-legacy-fallback-observed-or-missing");
  addFailure(failures, counterDelta(observations?.workerCreations) === 1, "drawing-worker-creation-count-invalid");
  addFailure(failures, observations?.offscreenSupported === false, "offscreen-capability-not-disabled");
  addFailure(failures, nonEmptyString(firstRequest?.requestId), "offscreen-first-request-id-missing");
  addFailure(failures, nonEmptyString(secondRequest?.requestId), "offscreen-second-request-id-missing");
  addFailure(
    failures,
    nonEmptyString(firstRequest?.requestId)
      && nonEmptyString(secondRequest?.requestId)
      && firstRequest.requestId !== secondRequest.requestId,
    "offscreen-request-ids-not-distinct",
  );
  addFailure(failures, firstRequest?.backendBefore === "worker", "offscreen-first-request-did-not-enter-worker");
  addFailure(failures, firstRequest?.resultKind === "typed-fallback", "offscreen-typed-fallback-not-observed");
  addFailure(failures, firstRequest?.backendAfter === "main-thread", "offscreen-first-request-did-not-fallback");
  addFailure(failures, secondRequest?.backendBefore === "main-thread", "offscreen-second-request-not-sticky-before");
  addFailure(failures, secondRequest?.resultKind === "main-thread", "offscreen-second-request-result-not-main-thread");
  addFailure(failures, secondRequest?.backendAfter === "main-thread", "offscreen-second-request-not-sticky-after");
  addFailure(failures, observations?.finalBackend === "main-thread", "offscreen-final-backend-not-main-thread");
  addFailure(
    failures,
    roundTripsBefore !== null
      && roundTripsBefore >= 0
      && roundTripsAfterFirst !== null
      && roundTripsAfterFirst === roundTripsBefore + 1,
    "offscreen-first-worker-round-trip-not-observed",
  );
  addFailure(
    failures,
    roundTripsAfterFirst !== null
      && roundTripsAfterSecond !== null
      && roundTripsAfterSecond === roundTripsAfterFirst,
    "offscreen-second-request-used-worker-round-trip",
  );
  addFailure(failures, counterDelta(observations?.typedResults) > 0, "typed-worker-result-not-observed");
  addFailure(failures, counterDelta(observations?.bitmapResults) === 0, "bitmap-result-observed-without-offscreen");
  addFailure(failures, counterDelta(observations?.scenePublications) >= 2, "scene-publication-count-insufficient");
  validateDocumentPreserved(failures, artifact?.outcome);
  return failures;
}

function validIndexedDbDocumentIdentity(value) {
  const identity = objectValue(value);
  return identity !== null
    && nonEmptyString(identity.scopeKey)
    && safePositiveInteger(identity.documentRevision) !== null
    && safePositiveInteger(identity.entityCount) !== null
    && sha256Digest(identity.documentDigest);
}

function sameIndexedDbDocumentIdentity(left, right) {
  return validIndexedDbDocumentIdentity(left)
    && validIndexedDbDocumentIdentity(right)
    && left.scopeKey === right.scopeKey
    && left.documentRevision === right.documentRevision
    && left.entityCount === right.entityCount
    && left.documentDigest === right.documentDigest;
}

function validIndexedDbDurableRecordReceipt(value) {
  const receipt = objectValue(value);
  return validIndexedDbDocumentIdentity(receipt)
    && receipt.kind === "canonical-structured-clone-record"
    && receipt.documentSchemaVersion === DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION
    && sha256Digest(receipt.canonicalBytesDigest);
}

function sameIndexedDbDurableRecordReceipt(left, right) {
  return validIndexedDbDurableRecordReceipt(left)
    && validIndexedDbDurableRecordReceipt(right)
    && sameIndexedDbDocumentIdentity(left, right)
    && left.kind === right.kind
    && left.documentSchemaVersion === right.documentSchemaVersion
    && left.canonicalBytesDigest === right.canonicalBytesDigest;
}

function validIndexedDbManifestReceipt(value) {
  const receipt = objectValue(value);
  return receipt !== null
    && receipt.kind === "drawing-document-manifest"
    && receipt.manifestSchemaVersion === DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION
    && nonEmptyString(receipt.scopeKey)
    && safePositiveInteger(receipt.revision) !== null
    && safePositiveInteger(receipt.count) !== null
    && sha256Digest(receipt.rawBytesDigest);
}

function sameIndexedDbManifestReceipt(left, right) {
  return validIndexedDbManifestReceipt(left)
    && validIndexedDbManifestReceipt(right)
    && left.kind === right.kind
    && left.manifestSchemaVersion === right.manifestSchemaVersion
    && left.scopeKey === right.scopeKey
    && left.revision === right.revision
    && left.count === right.count
    && left.rawBytesDigest === right.rawBytesDigest;
}

function indexedDbRecordAndManifestMatch(record, manifest) {
  return validIndexedDbDurableRecordReceipt(record)
    && validIndexedDbManifestReceipt(manifest)
    && record.scopeKey === manifest.scopeKey
    && record.documentRevision === manifest.revision
    && record.entityCount === manifest.count;
}

function indexedDbRecordMatchesPending(record, pending) {
  return validIndexedDbDurableRecordReceipt(record)
    && sameIndexedDbDocumentIdentity(record, pending);
}

function indexedDbManifestMatchesPending(manifest, pending) {
  return validIndexedDbManifestReceipt(manifest)
    && validIndexedDbDocumentIdentity(pending)
    && manifest.scopeKey === pending.scopeKey
    && manifest.revision === pending.documentRevision
    && manifest.count === pending.entityCount;
}

function validIndexedDbFaultBinding(value, kind, runId) {
  const binding = objectValue(value);
  return binding !== null
    && binding.kind === "controlled-indexeddb-fault-binding"
    && sameNonEmptyString(binding.runId, runId)
    && nonEmptyString(binding.faultId)
    && sha256Digest(binding.authorityTokenSha256)
    && binding.variant === kind;
}

function sameIndexedDbFaultReceiptBinding(value, binding, kind, transactionId) {
  const receipt = objectValue(value);
  return receipt !== null
    && validIndexedDbFaultBinding(binding, kind, binding?.runId)
    && receipt.runId === binding.runId
    && receipt.faultId === binding.faultId
    && receipt.authorityTokenSha256 === binding.authorityTokenSha256
    && receipt.variant === kind
    && receipt.transactionId === transactionId;
}

function validQuotaUsageAndQuotaReceipt(value, origin) {
  const receipt = objectValue(value);
  return receipt !== null
    && receipt.method === "Storage.getUsageAndQuota"
    && sameNonEmptyString(receipt.origin, origin)
    && finiteNumber(receipt.usageBytes) !== null
    && receipt.usageBytes >= 0
    && finiteNumber(receipt.quotaBytes) !== null
    && receipt.quotaBytes >= 0
    && typeof receipt.overrideActive === "boolean"
    && validTimestamp(receipt.observedAt);
}

function sameQuotaUsageAndQuotaReceipt(left, right) {
  return objectValue(left) !== null
    && objectValue(right) !== null
    && left.method === right.method
    && left.origin === right.origin
    && left.usageBytes === right.usageBytes
    && left.quotaBytes === right.quotaBytes
    && left.overrideActive === right.overrideActive
    && left.observedAt === right.observedAt;
}

function validateQuotaNativeReceipt(failures, value, context) {
  const receipt = objectValue(value);
  const overrideCommand = objectValue(receipt?.overrideCommand);
  const clearCommand = objectValue(receipt?.clearCommand);
  const quotaPlan = objectValue(receipt?.quotaPlan);
  const usageAndQuota = objectValue(receipt?.usageAndQuota);
  const before = objectValue(usageAndQuota?.before);
  const overridden = objectValue(usageAndQuota?.overridden);
  const afterCacheExpiry = objectValue(usageAndQuota?.afterCacheExpiry);
  const restored = objectValue(usageAndQuota?.restored);
  const preparation = objectValue(receipt?.preparation);
  const cacheExpiryGuard = objectValue(receipt?.cacheExpiryGuard);
  const guardVerification = objectValue(cacheExpiryGuard?.verification);
  const probe = objectValue(receipt?.probe);
  const transactionError = objectValue(probe?.transactionError);
  const abortEvent = objectValue(probe?.abortEvent);
  const cleanup = objectValue(receipt?.cleanup);
  const deletion = objectValue(cleanup?.deletion);
  const origin = context.buildAuthority?.managedOrigin;
  const expectedDbName = `candlescope-rollback-quota-${context.faultBinding?.runId}-${context.faultBinding?.faultId}`;
  addFailure(
    failures,
    receipt?.kind === "cdp-storage-quota-override"
      && nonEmptyString(receipt?.receiptId),
    "indexeddb-quota-native-receipt-kind-invalid",
  );
  addFailure(
    failures,
    sameIndexedDbFaultReceiptBinding(receipt, context.faultBinding, "quota", context.transactionId),
    "indexeddb-quota-native-fault-binding-mismatch",
  );
  addFailure(
    failures,
    nonEmptyString(origin) && receipt?.origin === origin,
    "indexeddb-quota-native-origin-mismatch",
  );
  addFailure(
    failures,
    receipt?.sacrificialDbName === expectedDbName
      && receipt?.sacrificialDbName !== DRAWING_DOCUMENT_DATABASE_NAME,
    "indexeddb-quota-sacrificial-database-invalid",
  );
  addFailure(
    failures,
    preparation?.prepared === true
      && preparation?.databaseName === receipt?.sacrificialDbName
      && preparation?.storeName === "quota-probe"
      && preparation?.baselineKey === "baseline"
      && preparation?.baselineCommitted === true
      && preparation?.connectionKeptOpen === true
      && validTimestamp(preparation?.preparedAt),
    "indexeddb-quota-preparation-invalid",
  );
  addFailure(
    failures,
    quotaPlan?.kind === "nonzero-below-existing-usage"
      && quotaPlan?.quotaSizeBytes === 1
      && quotaPlan?.baselineUsageBytes === before?.usageBytes
      && quotaPlan?.baselineUsageExceedsQuota === true,
    "indexeddb-quota-plan-invalid",
  );
  addFailure(
    failures,
    overrideCommand?.method === "Storage.overrideQuotaForOrigin"
      && overrideCommand?.origin === origin
      && overrideCommand?.quotaSize === 1
      && overrideCommand?.accepted === true
      && validTimestamp(overrideCommand?.observedAt),
    "indexeddb-quota-native-override-command-invalid",
  );
  addFailure(
    failures,
    clearCommand?.method === "Storage.overrideQuotaForOrigin"
      && clearCommand?.origin === origin
      && clearCommand?.quotaSizeOmitted === true
      && !own(clearCommand, "quotaSize")
      && clearCommand?.accepted === true
      && validTimestamp(clearCommand?.observedAt),
    "indexeddb-quota-native-clear-command-invalid",
  );
  addFailure(
    failures,
    validQuotaUsageAndQuotaReceipt(before, origin)
      && validQuotaUsageAndQuotaReceipt(overridden, origin)
      && validQuotaUsageAndQuotaReceipt(afterCacheExpiry, origin)
      && validQuotaUsageAndQuotaReceipt(restored, origin)
      && before.usageBytes > 1
      && before.quotaBytes > 1
      && before.overrideActive === false
      && overridden.quotaBytes === 1
      && overridden.overrideActive === true
      && afterCacheExpiry.quotaBytes === 1
      && afterCacheExpiry.overrideActive === true
      && restored.quotaBytes === before.quotaBytes
      && restored.overrideActive === false
      && sameQuotaUsageAndQuotaReceipt(afterCacheExpiry, guardVerification),
    "indexeddb-quota-native-usage-receipts-invalid",
  );
  addFailure(
    failures,
    receipt?.overrideActive === true
      && receipt?.overrideCleared === true
      && receipt?.releaseAccepted === true
      && receipt?.forcedCleanup === false,
    "indexeddb-quota-native-override-state-invalid",
  );
  addFailure(
    failures,
    cacheExpiryGuard?.kind === "indexeddb-bucket-space-cache-expiry"
      && cacheExpiryGuard?.cacheTimeLimitMs === 30_000
      && cacheExpiryGuard?.guardMs === 5_000
      && cacheExpiryGuard?.requestedWaitMs === 35_000
      && cacheExpiryGuard.cacheTimeLimitMs + cacheExpiryGuard.guardMs
        === cacheExpiryGuard.requestedWaitMs
      && finiteNumber(cacheExpiryGuard?.elapsedMs) !== null
      && cacheExpiryGuard.elapsedMs >= 35_000
      && validTimestamp(cacheExpiryGuard?.startedAt)
      && validTimestamp(cacheExpiryGuard?.completedAt)
      && sameQuotaUsageAndQuotaReceipt(guardVerification, afterCacheExpiry),
    "indexeddb-quota-cache-expiry-guard-invalid",
  );
  addFailure(
    failures,
    probe?.attempted === true
      && probe?.databaseName === receipt?.sacrificialDbName
      && probe?.storeName === preparation?.storeName
      && probe?.transactionMode === "readwrite"
      && probe?.settled === "abort"
      && transactionError?.name === "QuotaExceededError"
      && validTimestamp(transactionError?.observedAt)
      && probe?.nativeQuotaExceeded === true
      && validTimestamp(probe?.attemptedAt)
      && validTimestamp(probe?.observedAt),
    "indexeddb-quota-probe-invalid",
  );
  addFailure(
    failures,
    abortEvent?.type === "abort"
      && abortEvent?.isTrusted === true
      && validTimestamp(abortEvent?.observedAt),
    "indexeddb-quota-native-trusted-abort-invalid",
  );
  addFailure(
    failures,
    cleanup?.databaseName === receipt?.sacrificialDbName
      && (!own(cleanup, "storeName") || cleanup?.storeName === preparation?.storeName)
      && cleanup?.connectionClosed === true
      && deletion?.status === "success"
      && cleanup?.databaseStillPresent === false
      && cleanup?.forcedCleanup === false
      && cleanup?.completed === true
      && validTimestamp(cleanup?.completedAt),
    "indexeddb-quota-native-cleanup-invalid",
  );
  addFailure(
    failures,
    receipt?.productErrorReceiptId === context.errorReceipt?.receiptId
      && context.errorReceipt?.source === "drawing-persistence-flush"
      && context.errorReceipt?.caughtByProduct === true,
    "indexeddb-quota-product-error-binding-mismatch",
  );
  addFailure(
    failures,
    timestampsAreOrdered([
      preparation?.preparedAt,
      before?.observedAt,
      overrideCommand?.observedAt,
      overridden?.observedAt,
      cacheExpiryGuard?.startedAt,
      cacheExpiryGuard?.completedAt,
      afterCacheExpiry?.observedAt,
      probe?.attemptedAt,
      transactionError?.observedAt,
      abortEvent?.observedAt,
      probe?.observedAt,
      context.beforeWrite?.observedAt,
      context.errorReceipt?.observedAt,
      context.afterFailure?.observedAt,
      clearCommand?.observedAt,
      cleanup?.completedAt,
      restored?.observedAt,
      context.retry?.attemptedAt,
    ]),
    "indexeddb-quota-native-receipt-order-invalid",
  );
}

function validateBlockedNativeReceipt(failures, value, context) {
  const receipt = objectValue(value);
  const keeper = objectValue(receipt?.keeperConnection);
  const openRequest = objectValue(receipt?.upgradeOpenRequest);
  const blockedEvent = objectValue(openRequest?.blockedEvent);
  const cleanup = objectValue(receipt?.cleanup);
  const expectedDbName = `candlescope-rollback-blocked-${context.faultBinding?.runId}-${context.faultBinding?.faultId}`;
  addFailure(
    failures,
    receipt?.kind === "native-indexeddb-blocked-event"
      && nonEmptyString(receipt?.receiptId),
    "indexeddb-blocked-native-receipt-kind-invalid",
  );
  addFailure(
    failures,
    sameIndexedDbFaultReceiptBinding(receipt, context.faultBinding, "blocked", context.transactionId),
    "indexeddb-blocked-native-fault-binding-mismatch",
  );
  addFailure(
    failures,
    receipt?.sacrificialDbName === expectedDbName
      && receipt?.sacrificialDbName !== DRAWING_DOCUMENT_DATABASE_NAME,
    "indexeddb-blocked-sacrificial-database-invalid",
  );
  addFailure(
    failures,
    nonEmptyString(keeper?.connectionId)
      && keeper?.databaseName === receipt?.sacrificialDbName
      && keeper?.openedVersion === 1
      && validTimestamp(keeper?.openedAt)
      && validTimestamp(keeper?.closedAt),
    "indexeddb-blocked-keeper-lifecycle-invalid",
  );
  addFailure(
    failures,
    nonEmptyString(openRequest?.requestId)
      && openRequest?.databaseName === receipt?.sacrificialDbName
      && openRequest?.requestedVersion === 2
      && openRequest?.settled === "success-after-keeper-close"
      && validTimestamp(openRequest?.startedAt)
      && validTimestamp(openRequest?.settledAt),
    "indexeddb-blocked-open-lifecycle-invalid",
  );
  addFailure(
    failures,
    blockedEvent?.type === "blocked"
      && blockedEvent?.isTrusted === true
      && blockedEvent?.databaseName === receipt?.sacrificialDbName
      && blockedEvent?.oldVersion === 1
      && blockedEvent?.newVersion === 2
      && validTimestamp(blockedEvent?.observedAt),
    "indexeddb-blocked-native-trusted-event-invalid",
  );
  addFailure(
    failures,
    receipt?.productErrorReceiptId === context.errorReceipt?.receiptId
      && context.errorReceipt?.source === "drawing-persistence-flush"
      && context.errorReceipt?.caughtByProduct === true,
    "indexeddb-blocked-product-error-binding-mismatch",
  );
  addFailure(
    failures,
    cleanup?.keeperClosed === true
      && cleanup?.upgradeRequestSettled === true
      && cleanup?.deleteRequested === true
      && cleanup?.deleteSucceeded === true
      && cleanup?.databaseAbsent === true
      && cleanup?.databaseName === receipt?.sacrificialDbName
      && validTimestamp(cleanup?.completedAt),
    "indexeddb-blocked-native-cleanup-invalid",
  );
  addFailure(
    failures,
    timestampsAreOrdered([
      keeper?.openedAt,
      context.beforeWrite?.observedAt,
      openRequest?.startedAt,
      blockedEvent?.observedAt,
      keeper?.closedAt,
      openRequest?.settledAt,
      cleanup?.completedAt,
    ])
      && timestampsAreOrdered([
        blockedEvent?.observedAt,
        context.errorReceipt?.observedAt,
        context.afterFailure?.observedAt,
        context.retry?.attemptedAt,
      ])
      && validTimestamp(cleanup?.completedAt)
      && validTimestamp(context.retry?.attemptedAt)
      && Date.parse(context.retry.attemptedAt) >= Date.parse(cleanup.completedAt),
    "indexeddb-blocked-native-receipt-order-invalid",
  );
}

function validateIndexedDbVariant(failures, value, kind, artifact) {
  const variant = objectValue(value);
  const provenance = objectValue(artifact?.provenance);
  const buildAuthority = objectValue(artifact?.buildAuthority);
  const faultBinding = objectValue(variant?.faultBinding);
  const errorReceipt = objectValue(variant?.errorReceipt);
  const nativeReceipt = objectValue(variant?.nativeReceipt);
  const durableRecord = objectValue(variant?.durableRecord);
  const durableBefore = objectValue(durableRecord?.beforeFailure);
  const durableAfter = objectValue(durableRecord?.afterFailure);
  const manifest = objectValue(variant?.manifest);
  const manifestBefore = objectValue(manifest?.beforeFailure);
  const manifestAfter = objectValue(manifest?.afterFailure);
  const states = Array.isArray(variant?.stateReceipts) ? variant.stateReceipts : [];
  const beforeWrite = objectValue(states[0]);
  const afterFailure = objectValue(states[1]);
  const afterRetry = objectValue(states[2]);
  const retry = objectValue(variant?.retryReceipt);
  const retryRecord = objectValue(retry?.durableRecord);
  const retryManifest = objectValue(retry?.manifest);
  const coldReload = objectValue(variant?.coldReloadReceipt);
  const restoredDocument = objectValue(coldReload?.restoredDocument);
  const coldRecord = objectValue(coldReload?.durableRecord);
  const coldManifest = objectValue(coldReload?.manifest);
  const expectedErrorName = kind === "quota" ? "QuotaExceededError" : "Error";
  const expectedOperation = kind === "quota" ? "transaction-write" : "database-open";
  addFailure(failures, variant !== null, `indexeddb-${kind}-variant-missing`);
  addFailure(failures, variant?.kind === kind, `indexeddb-${kind}-kind-mismatch`);
  addFailure(failures, nonEmptyString(variant?.transactionId), `indexeddb-${kind}-transaction-id-missing`);
  addFailure(
    failures,
    validIndexedDbFaultBinding(faultBinding, kind, provenance?.runId),
    `indexeddb-${kind}-fault-binding-invalid`,
  );
  addFailure(
    failures,
    sameIndexedDbFaultReceiptBinding(errorReceipt, faultBinding, kind, variant?.transactionId)
      && nonEmptyString(errorReceipt?.receiptId)
      && errorReceipt?.nativeReceiptId === nativeReceipt?.receiptId
      && errorReceipt?.operation === expectedOperation
      && errorReceipt?.name === expectedErrorName
      && (kind === "quota"
        ? typeof errorReceipt?.message === "string"
        : nonEmptyString(errorReceipt?.message))
      && errorReceipt?.source === "drawing-persistence-flush"
      && errorReceipt?.caughtByProduct === true
      && validTimestamp(errorReceipt?.observedAt),
    `indexeddb-${kind}-error-receipt-invalid`,
  );
  if (kind === "blocked") {
    addFailure(
      failures,
      errorReceipt?.message === "drawing IndexedDB upgrade is blocked",
      "indexeddb-blocked-error-message-mismatch",
    );
  }
  addFailure(
    failures,
    validIndexedDbDurableRecordReceipt(durableBefore),
    `indexeddb-${kind}-old-durable-record-invalid`,
  );
  addFailure(
    failures,
    validIndexedDbManifestReceipt(manifestBefore),
    `indexeddb-${kind}-old-manifest-invalid`,
  );
  addFailure(
    failures,
    indexedDbRecordAndManifestMatch(durableBefore, manifestBefore),
    `indexeddb-${kind}-old-record-manifest-mismatch`,
  );
  addFailure(
    failures,
    sameIndexedDbDurableRecordReceipt(durableBefore, durableAfter),
    `indexeddb-${kind}-durable-record-changed-on-failure`,
  );
  addFailure(
    failures,
    sameIndexedDbManifestReceipt(manifestBefore, manifestAfter),
    `indexeddb-${kind}-manifest-changed-on-failure`,
  );
  addFailure(failures, states.length === 3, `indexeddb-${kind}-state-receipt-count-mismatch`);
  addFailure(
    failures,
    beforeWrite?.stage === "before-write"
      && afterFailure?.stage === "after-failure"
      && afterRetry?.stage === "after-retry"
      && states.every((state) => sameIndexedDbFaultReceiptBinding(
        state,
        faultBinding,
        kind,
        variant?.transactionId,
      )),
    `indexeddb-${kind}-state-receipt-sequence-invalid`,
  );
  addFailure(
    failures,
    states.every((state) => validIndexedDbDocumentIdentity(state)),
    `indexeddb-${kind}-pending-document-receipt-invalid`,
  );
  addFailure(
    failures,
    beforeWrite?.dirty === true
      && afterFailure?.dirty === true
      && afterRetry?.dirty === false,
    `indexeddb-${kind}-dirty-state-transition-invalid`,
  );
  addFailure(
    failures,
    sameIndexedDbDocumentIdentity(beforeWrite, afterFailure)
      && sameIndexedDbDocumentIdentity(afterFailure, afterRetry),
    `indexeddb-${kind}-pending-document-state-mismatch`,
  );
  addFailure(
    failures,
    validIndexedDbDocumentIdentity(beforeWrite)
      && validIndexedDbDurableRecordReceipt(durableBefore)
      && beforeWrite.scopeKey === durableBefore.scopeKey
      && beforeWrite.documentRevision > durableBefore.documentRevision
      && beforeWrite.documentDigest !== durableBefore.documentDigest,
    `indexeddb-${kind}-pending-document-not-newer-than-durable`,
  );
  addFailure(
    failures,
    retry?.kind === "retry-commit"
      && sameIndexedDbFaultReceiptBinding(retry, faultBinding, kind, variant?.transactionId)
      && nonEmptyString(retry?.receiptId)
      && validTimestamp(retry?.attemptedAt)
      && validTimestamp(retry?.committedAt)
      && Date.parse(retry?.committedAt) >= Date.parse(retry?.attemptedAt),
    `indexeddb-${kind}-retry-identity-invalid`,
  );
  addFailure(
    failures,
    validIndexedDbDurableRecordReceipt(retryRecord),
    `indexeddb-${kind}-retry-durable-record-invalid`,
  );
  addFailure(
    failures,
    indexedDbRecordMatchesPending(retryRecord, afterRetry),
    `indexeddb-${kind}-retry-durable-record-pending-mismatch`,
  );
  addFailure(
    failures,
    validIndexedDbManifestReceipt(retryManifest),
    `indexeddb-${kind}-retry-manifest-invalid`,
  );
  addFailure(
    failures,
    indexedDbManifestMatchesPending(retryManifest, afterRetry),
    `indexeddb-${kind}-retry-manifest-pending-mismatch`,
  );
  addFailure(
    failures,
    indexedDbRecordAndManifestMatch(retryRecord, retryManifest),
    `indexeddb-${kind}-retry-record-manifest-mismatch`,
  );
  addFailure(
    failures,
    coldReload?.kind === "cold-reload"
      && sameIndexedDbFaultReceiptBinding(coldReload, faultBinding, kind, variant?.transactionId)
      && coldReload?.sourceTransactionId === variant?.transactionId
      && nonEmptyString(coldReload?.receiptId)
      && validTimestamp(coldReload?.observedAt),
    `indexeddb-${kind}-cold-reload-identity-invalid`,
  );
  addFailure(
    failures,
    nonEmptyString(coldReload?.beforeDocumentInstanceId)
      && nonEmptyString(coldReload?.afterDocumentInstanceId)
      && coldReload.beforeDocumentInstanceId !== coldReload.afterDocumentInstanceId,
    `indexeddb-${kind}-cold-reload-document-instance-invalid`,
  );
  addFailure(
    failures,
    coldReload?.restoreSource === "v2",
    `indexeddb-${kind}-cold-reload-source-not-v2`,
  );
  addFailure(
    failures,
    sameIndexedDbDocumentIdentity(restoredDocument, afterRetry),
    `indexeddb-${kind}-cold-reload-document-pending-mismatch`,
  );
  addFailure(
    failures,
    sameIndexedDbDurableRecordReceipt(coldRecord, retryRecord),
    `indexeddb-${kind}-cold-reload-durable-record-mismatch`,
  );
  addFailure(
    failures,
    sameIndexedDbManifestReceipt(coldManifest, retryManifest),
    `indexeddb-${kind}-cold-reload-manifest-mismatch`,
  );
  addFailure(
    failures,
    coldReload?.queueDepthCurrent === 0 && coldReload?.dirty === false,
    `indexeddb-${kind}-cold-reload-state-not-converged`,
  );
  const currentStamp = coldReload?.lastRequestedStamp;
  addFailure(
    failures,
    validStamp(currentStamp)
      && currentStamp?.scopeKey === restoredDocument?.scopeKey
      && currentStamp?.documentRevision === restoredDocument?.documentRevision
      && sameStamp(currentStamp, coldReload?.lastPublishedStamp)
      && sameStamp(coldReload?.lastPublishedStamp, coldReload?.lastPaintedStamp),
    `indexeddb-${kind}-cold-reload-current-stamp-invalid`,
  );
  addFailure(
    failures,
    validPaintReceipt(coldReload?.paintReceipt, coldReload?.lastPaintedStamp),
    `indexeddb-${kind}-cold-reload-paint-receipt-invalid`,
  );
  addFailure(
    failures,
    timestampsAreOrdered([
      beforeWrite?.observedAt,
      errorReceipt?.observedAt,
      afterFailure?.observedAt,
      retry?.attemptedAt,
      retry?.committedAt,
      afterRetry?.observedAt,
      coldReload?.paintReceipt?.observedAt,
      coldReload?.observedAt,
    ]),
    `indexeddb-${kind}-receipt-order-invalid`,
  );
  addFailure(
    failures,
    counterDelta(variant?.failureMetrics) > 0,
    `indexeddb-${kind}-failure-metric-missing`,
  );
  const context = {
    afterFailure,
    beforeWrite,
    buildAuthority,
    errorReceipt,
    faultBinding,
    retry,
    transactionId: variant?.transactionId,
  };
  if (kind === "quota") {
    validateQuotaNativeReceipt(failures, nativeReceipt, context);
  } else {
    validateBlockedNativeReceipt(failures, nativeReceipt, context);
  }
}

function validateIndexedDbQuotaBlocked(artifact) {
  const failures = validateDedicatedCommon("indexeddb-quota-blocked", artifact);
  addFailure(failures, artifact?.injection?.kind === "indexeddb-quota-and-blocked", "wrong-indexeddb-injection");
  addFailure(
    failures,
    artifact?.injection?.buildAuthorityCurrent === true,
    "indexeddb-current-build-authority-not-proven",
  );
  const variants = Array.isArray(artifact?.variants) ? artifact.variants : [];
  addFailure(failures, variants.length === 2, "indexeddb-variant-count-mismatch");
  const quota = variants.find((value) => value?.kind === "quota");
  const blocked = variants.find((value) => value?.kind === "blocked");
  validateIndexedDbVariant(failures, quota, "quota", artifact);
  validateIndexedDbVariant(failures, blocked, "blocked", artifact);
  addFailure(
    failures,
    nonEmptyString(quota?.faultBinding?.faultId)
      && nonEmptyString(blocked?.faultBinding?.faultId)
      && quota.faultBinding.faultId !== blocked.faultBinding.faultId,
    "indexeddb-fault-ids-not-distinct",
  );
  addFailure(
    failures,
    nonEmptyString(quota?.transactionId)
      && nonEmptyString(blocked?.transactionId)
      && quota.transactionId !== blocked.transactionId,
    "indexeddb-transaction-ids-not-distinct",
  );
  addFailure(
    failures,
    nonEmptyString(quota?.nativeReceipt?.receiptId)
      && nonEmptyString(blocked?.nativeReceipt?.receiptId)
      && quota.nativeReceipt.receiptId !== blocked.nativeReceipt.receiptId,
    "indexeddb-native-receipt-ids-not-distinct",
  );
  return failures;
}

function validateGestureVariant(failures, value, kind) {
  const variant = objectValue(value);
  const events = Array.isArray(variant?.events) ? variant.events : [];
  const pointerDown = objectValue(events[0]);
  const boundaryChange = objectValue(events[1]);
  const cancellation = objectValue(events[2]);
  const canonical = objectValue(variant?.canonical);
  const canonicalBefore = objectValue(canonical?.before);
  const canonicalAfter = objectValue(canonical?.after);
  const beforeRevision = integer(canonicalBefore?.documentRevision);
  const afterRevision = integer(canonicalAfter?.documentRevision);
  const expectedReason = kind === "chart-type" ? "surface-dispose" : "coordinate-change";
  addFailure(failures, variant !== null, `${kind}-gesture-variant-missing`);
  addFailure(failures, variant?.kind === kind, `${kind}-gesture-kind-mismatch`);
  addFailure(failures, nonEmptyString(variant?.transactionId), `${kind}-transaction-id-missing`);
  addFailure(failures, nonEmptyString(variant?.gestureId), `${kind}-gesture-id-missing`);
  addFailure(failures, events.length === 3, `${kind}-gesture-event-count-mismatch`);
  addFailure(
    failures,
    events.length === 3
      && events.every((event) => (
        event?.transactionId === variant?.transactionId
          && event?.gestureId === variant?.gestureId
      )),
    `${kind}-gesture-event-identity-mismatch`,
  );
  addFailure(
    failures,
    timestampsAreOrdered(events.map((event) => event?.observedAt)),
    `${kind}-gesture-event-order-invalid`,
  );
  addFailure(
    failures,
    pointerDown?.type === "pointer-down" && pointerDown?.activeAfter === true,
    `${kind}-pointer-down-receipt-invalid`,
  );
  addFailure(
    failures,
    boundaryChange?.type === "boundary-change"
      && boundaryChange?.boundaryKind === kind
      && nonEmptyString(boundaryChange?.beforeValue)
      && nonEmptyString(boundaryChange?.afterValue)
      && boundaryChange.beforeValue !== boundaryChange.afterValue
      && boundaryChange?.activeBefore === true,
    `${kind}-boundary-change-receipt-invalid`,
  );
  addFailure(
    failures,
    cancellation?.type === "gesture-cancel"
      && cancellation?.reason === expectedReason
      && cancellation?.activeAfter === false,
    `${kind}-boundary-cancellation-receipt-invalid`,
  );
  addFailure(
    failures,
    sameNonEmptyString(canonicalBefore?.scopeKey, canonicalAfter?.scopeKey),
    `${kind}-canonical-scope-mismatch`,
  );
  addFailure(
    failures,
    sameSha256Digest(canonicalBefore?.digest, canonicalAfter?.digest),
    `${kind}-canonical-document-digest-mismatch`,
  );
  addFailure(
    failures,
    beforeRevision !== null
      && beforeRevision >= 0
      && afterRevision !== null
      && afterRevision === beforeRevision,
    `${kind}-canonical-document-revision-changed`,
  );
}

function validateActiveGestureBoundary(artifact) {
  const failures = validateDedicatedCommon("active-gesture-chart-boundary", artifact);
  addFailure(failures, artifact?.injection?.kind === "active-gesture-chart-boundary", "wrong-gesture-boundary-injection");
  const variants = Array.isArray(artifact?.variants) ? artifact.variants : [];
  addFailure(failures, variants.length === 2, "gesture-boundary-variant-count-mismatch");
  validateGestureVariant(failures, variants.find((value) => value?.kind === "chart-type"), "chart-type");
  validateGestureVariant(failures, variants.find((value) => value?.kind === "interval"), "interval");
  return failures;
}

function validateSeriesRebuildBeforeExport(artifact) {
  const failures = validateDedicatedCommon("series-rebuild-before-export", artifact);
  const checkpoints = Array.isArray(artifact?.checkpointEvents)
    ? artifact.checkpointEvents
    : [];
  const prepare = objectValue(checkpoints[0]);
  const rebuildStart = objectValue(checkpoints[1]);
  const rebuildComplete = objectValue(checkpoints[2]);
  const staleRevalidate = objectValue(checkpoints[3]);
  const freshRevalidate = objectValue(checkpoints[4]);
  const capture = objectValue(checkpoints[5]);
  const restored = objectValue(checkpoints[6]);
  const png = objectValue(capture?.png);
  const outcome = objectValue(artifact?.outcome);
  addFailure(failures, artifact?.injection?.kind === "series-rebuild-before-export-capture", "wrong-export-rebuild-injection");
  addFailure(failures, checkpoints.length === EXPORT_CHECKPOINT_TYPES.length, "export-checkpoint-count-mismatch");
  addFailure(
    failures,
    checkpoints.length === EXPORT_CHECKPOINT_TYPES.length
      && checkpoints.every((event, index) => event?.type === EXPORT_CHECKPOINT_TYPES[index]),
    "export-checkpoint-sequence-invalid",
  );
  addFailure(
    failures,
    timestampsAreOrdered(checkpoints.map((event) => event?.observedAt)),
    "export-checkpoint-order-invalid",
  );
  addFailure(
    failures,
    nonEmptyString(prepare?.leaseId)
      && safePositiveInteger(prepare?.surfaceGeneration) !== null,
    "old-export-lease-receipt-invalid",
  );
  addFailure(
    failures,
    rebuildStart?.fromSurfaceGeneration === prepare?.surfaceGeneration
      && rebuildComplete?.fromSurfaceGeneration === prepare?.surfaceGeneration
      && safePositiveInteger(rebuildComplete?.surfaceGeneration) !== null
      && rebuildComplete.surfaceGeneration > prepare?.surfaceGeneration,
    "series-rebuild-generation-transition-invalid",
  );
  addFailure(
    failures,
    staleRevalidate?.leaseId === prepare?.leaseId
      && staleRevalidate?.surfaceGeneration === prepare?.surfaceGeneration
      && staleRevalidate?.valid === false,
    "stale-export-lease-revalidation-invalid",
  );
  addFailure(
    failures,
    nonEmptyString(freshRevalidate?.leaseId)
      && freshRevalidate?.leaseId !== prepare?.leaseId
      && freshRevalidate?.surfaceGeneration === rebuildComplete?.surfaceGeneration
      && freshRevalidate?.valid === true,
    "fresh-export-lease-revalidation-invalid",
  );
  addFailure(
    failures,
    capture?.leaseId === freshRevalidate?.leaseId
      && capture?.surfaceGeneration === freshRevalidate?.surfaceGeneration,
    "export-capture-did-not-use-fresh-lease",
  );
  addFailure(
    failures,
    restored?.leaseId === freshRevalidate?.leaseId
      && restored?.surfaceGeneration === freshRevalidate?.surfaceGeneration,
    "export-lease-restore-receipt-invalid",
  );
  addFailure(
    failures,
    sha256Digest(png?.digest)
      && safePositiveInteger(png?.bytes) !== null
      && safePositiveInteger(png?.widthPx) !== null
      && safePositiveInteger(png?.heightPx) !== null,
    "export-png-receipt-invalid",
  );
  addFailure(
    failures,
    safePositiveInteger(capture?.drawingPixelDiffCount) !== null,
    "export-drawing-pixel-diff-not-observed",
  );
  addFailure(
    failures,
    safePositiveInteger(capture?.controlPixelSampleCount) !== null
      && capture?.controlPixelDiffCount === 0,
    "export-control-pixel-diff-observed-or-missing",
  );
  addFailure(failures, sameSha256Digest(outcome?.beforeDigest, outcome?.afterDigest), "export-document-digest-mismatch");
  addFailure(failures, outcome?.queueDepthCurrent === 0, "post-export-queue-not-converged");
  addFailure(failures, sameStamp(outcome?.lastRequestedStamp, outcome?.lastPublishedStamp), "post-export-stamp-not-current");
  addFailure(failures, own(outcome, "lastPaintedStamp"), "post-export-independent-painted-stamp-missing");
  addFailure(failures, sameStamp(outcome?.lastPublishedStamp, outcome?.lastPaintedStamp), "post-export-painted-stamp-not-current");
  addFailure(
    failures,
    validPaintReceipt(outcome?.paintReceipt, outcome?.lastPaintedStamp),
    "post-export-independent-paint-receipt-invalid-or-missing",
  );
  return failures;
}

function validateContinuousDprResize(artifact) {
  const failures = validateDedicatedCommon("continuous-dpr-resize", artifact);
  const transitions = Array.isArray(artifact?.transitions) ? artifact.transitions : [];
  const observedDprs = new Set(transitions.map((transition) => finiteNumber(transition?.dpr)));
  addFailure(failures, artifact?.injection?.kind === "continuous-dpr-resize", "wrong-dpr-resize-injection");
  addFailure(failures, transitions.length >= 6, "continuous-transition-coverage-too-small");
  addFailure(failures, observedDprs.has(1) && observedDprs.has(1.5) && observedDprs.has(2), "dpr-matrix-incomplete");
  addFailure(
    failures,
    new Set(transitions.map((transition) => `${transition?.widthCssPx}x${transition?.heightCssPx}`)).size >= 3,
    "resize-matrix-incomplete",
  );
  for (const [index, transition] of transitions.entries()) {
    const prefix = `transition-${index}`;
    const requestedStamp = objectValue(transition?.lastRequestedStamp);
    const previousRequestedStamp = index > 0
      ? objectValue(transitions[index - 1]?.lastRequestedStamp)
      : null;
    addFailure(failures, finiteNumber(transition?.dpr) > 0, `${prefix}-dpr-invalid`);
    addFailure(failures, finiteNumber(transition?.widthCssPx) > 0, `${prefix}-width-invalid`);
    addFailure(failures, finiteNumber(transition?.heightCssPx) > 0, `${prefix}-height-invalid`);
    addFailure(failures, transition?.overlayDprSynchronized === true, `${prefix}-overlay-dpr-not-synchronized`);
    addFailure(failures, transition?.workerResultCurrent === true, `${prefix}-worker-result-not-current`);
    addFailure(failures, transition?.queueDepthCurrent === 0, `${prefix}-queue-not-converged`);
    addFailure(failures, sameStamp(transition?.lastRequestedStamp, transition?.lastPublishedStamp), `${prefix}-stamp-not-current`);
    addFailure(
      failures,
      requestedStamp?.dpr === transition?.dpr
        && requestedStamp?.widthCssPx === transition?.widthCssPx
        && requestedStamp?.heightCssPx === transition?.heightCssPx,
      `${prefix}-stamp-viewport-mismatch`,
    );
    if (previousRequestedStamp) {
      addFailure(
        failures,
        integer(requestedStamp?.viewportRevision) !== null
          && requestedStamp.viewportRevision > previousRequestedStamp.viewportRevision,
        `${prefix}-viewport-revision-not-advanced`,
      );
    }
  }
  validateDocumentPreserved(failures, artifact?.outcome);
  const finalTransition = transitions.at(-1);
  addFailure(
    failures,
    sameStamp(artifact?.outcome?.lastRequestedStamp, finalTransition?.lastRequestedStamp),
    "final-requested-stamp-does-not-match-last-transition",
  );
  addFailure(
    failures,
    sameStamp(artifact?.outcome?.lastPublishedStamp, finalTransition?.lastPublishedStamp),
    "final-published-stamp-does-not-match-last-transition",
  );
  return failures;
}

function validateCanaryToLegacySnapshot(artifact) {
  const failures = validateDedicatedCommon("canary-to-legacy-snapshot", artifact);
  const builds = objectValue(artifact?.builds);
  const canary = objectValue(builds?.canary);
  const legacy = objectValue(builds?.legacy);
  const snapshot = objectValue(artifact?.snapshot);
  const writeReceipt = objectValue(snapshot?.writeReceipt);
  const readReceipt = objectValue(snapshot?.readReceipt);
  const restartReceipts = objectValue(artifact?.restartReceipts);
  const renderedKinds = Array.isArray(readReceipt?.renderedKinds)
    ? readReceipt.renderedKinds
    : [];
  addFailure(failures, artifact?.injection?.kind === "canary-build-to-legacy-build", "wrong-cross-build-injection");
  addFailure(failures, canary?.mode === "scene-canary", "canary-build-mode-mismatch");
  addFailure(failures, legacy?.mode === "legacy", "legacy-build-mode-mismatch");
  addFailure(failures, canary?.productionBuild === true && legacy?.productionBuild === true, "cross-build-production-proof-missing");
  addFailure(failures, nonEmptyString(canary?.sourceRevision), "canary-source-revision-missing");
  addFailure(failures, nonEmptyString(legacy?.sourceRevision), "legacy-source-revision-missing");
  addFailure(failures, nonEmptyString(canary?.rolloutEnvironment), "canary-rollout-environment-missing");
  addFailure(failures, nonEmptyString(legacy?.rolloutEnvironment), "legacy-rollout-environment-missing");
  addFailure(
    failures,
    nonEmptyString(canary?.rolloutEnvironment)
      && nonEmptyString(legacy?.rolloutEnvironment)
      && canary.rolloutEnvironment !== legacy.rolloutEnvironment,
    "cross-build-rollout-environments-not-distinct",
  );
  addFailure(failures, sha256Digest(canary?.buildFingerprint), "canary-build-fingerprint-invalid-or-missing");
  addFailure(failures, sha256Digest(legacy?.buildFingerprint), "legacy-build-fingerprint-invalid-or-missing");
  addFailure(
    failures,
    sha256Digest(canary?.buildFingerprint)
      && sha256Digest(legacy?.buildFingerprint)
      && canary.buildFingerprint !== legacy.buildFingerprint,
    "cross-build-fingerprints-not-distinct",
  );
  addFailure(failures, sha256Digest(canary?.assetDigest), "canary-asset-digest-invalid-or-missing");
  addFailure(failures, sha256Digest(legacy?.assetDigest), "legacy-asset-digest-invalid-or-missing");
  addFailure(
    failures,
    sha256Digest(canary?.assetDigest)
      && sha256Digest(legacy?.assetDigest)
      && canary.assetDigest !== legacy.assetDigest,
    "cross-build-asset-digests-not-distinct",
  );
  addFailure(failures, sameNonEmptyString(canary?.origin, legacy?.origin), "cross-build-origin-mismatch");
  addFailure(failures, sameNonEmptyString(canary?.profileId, legacy?.profileId), "cross-build-profile-mismatch");
  addFailure(
    failures,
    validRestartReceipt(
      restartReceipts?.browser,
      "browser",
      canary?.browserInstanceId,
      legacy?.browserInstanceId,
      {
        beforeBuildFingerprint: canary?.buildFingerprint,
        afterBuildFingerprint: legacy?.buildFingerprint,
        profileId: canary?.profileId,
        scopeKey: writeReceipt?.scopeKey,
      },
    ),
    "cross-build-browser-restart-receipt-invalid-or-missing",
  );
  addFailure(
    failures,
    validRestartReceipt(
      restartReceipts?.server,
      "server",
      canary?.serverInstanceId,
      legacy?.serverInstanceId,
      {
        beforeBuildFingerprint: canary?.buildFingerprint,
        afterBuildFingerprint: legacy?.buildFingerprint,
        profileId: canary?.profileId,
        scopeKey: writeReceipt?.scopeKey,
      },
    ),
    "cross-build-server-restart-receipt-invalid-or-missing",
  );
  addFailure(failures, writeReceipt?.kind === "compatibility-write", "compatibility-write-receipt-invalid-or-missing");
  addFailure(failures, readReceipt?.kind === "legacy-read", "legacy-read-receipt-invalid-or-missing");
  addFailure(
    failures,
    sameSha256Digest(writeReceipt?.buildFingerprint, canary?.buildFingerprint)
      && sameNonEmptyString(writeReceipt?.profileId, canary?.profileId)
      && nonEmptyString(writeReceipt?.scopeKey),
    "compatibility-write-receipt-build-binding-invalid",
  );
  addFailure(
    failures,
    sameSha256Digest(readReceipt?.buildFingerprint, legacy?.buildFingerprint)
      && sameNonEmptyString(readReceipt?.profileId, legacy?.profileId)
      && sameNonEmptyString(readReceipt?.scopeKey, writeReceipt?.scopeKey),
    "legacy-read-receipt-build-binding-invalid",
  );
  addFailure(failures, validTimestamp(writeReceipt?.observedAt), "compatibility-write-timestamp-invalid");
  addFailure(failures, validTimestamp(readReceipt?.observedAt), "legacy-read-timestamp-invalid");
  for (const [kind, receipt] of [
    ["browser", restartReceipts?.browser],
    ["server", restartReceipts?.server],
  ]) {
    addFailure(
      failures,
      timestampsAreOrdered([
        writeReceipt?.observedAt,
        receipt?.stoppedAt,
        receipt?.startedAt,
        readReceipt?.observedAt,
      ]),
      `cross-build-${kind}-restart-order-invalid`,
    );
  }
  addFailure(failures, sameSha256Digest(writeReceipt?.documentDigest, readReceipt?.documentDigest), "cross-build-snapshot-digest-mismatch");
  addFailure(
    failures,
    sameSha256Digest(writeReceipt?.sourceBytesDigest, readReceipt?.sourceBytesDigestBefore)
      && sameSha256Digest(readReceipt?.sourceBytesDigestBefore, readReceipt?.sourceBytesDigestAfter),
    "cross-build-source-bytes-digest-mismatch",
  );
  addFailure(
    failures,
    integer(writeReceipt?.entityCount) !== null
      && integer(writeReceipt?.entityCount) >= DRAWING_KINDS.length
      && writeReceipt.entityCount === readReceipt?.entityCount,
    "cross-build-entity-count-mismatch",
  );
  addFailure(
    failures,
    renderedKinds.length === DRAWING_KINDS.length
      && new Set(renderedKinds).size === DRAWING_KINDS.length
      && DRAWING_KINDS.every((kind) => renderedKinds.includes(kind)),
    "cross-build-kind-coverage-incomplete",
  );
  addFailure(
    failures,
    integer(readReceipt?.visibleEntityCount) !== null
      && readReceipt.visibleEntityCount === readReceipt.entityCount,
    "legacy-renderer-visibility-not-proven",
  );
  return failures;
}

function validateDedicatedStaleGeneration(artifact) {
  const failures = validateDedicatedCommon("worker-stale-generation", artifact);
  const buildAuthority = objectValue(artifact?.buildAuthority);
  const workerLifecycle = objectValue(buildAuthority?.workerLifecycle);
  const observations = objectValue(artifact?.observations);
  const runtime = objectValue(observations?.runtime);
  const identities = objectValue(artifact?.identities);
  const returned = objectValue(identities?.returned);
  const accepted = objectValue(identities?.accepted);
  const published = objectValue(identities?.published);
  const latestSubmitted = objectValue(identities?.latestSubmitted);
  const submittedHeaders = Array.isArray(artifact?.submittedHeaders)
    ? artifact.submittedHeaders
    : [];
  const returnedSubmissionIndex = submittedHeaders.findIndex((header) => (
    sameWorkerIdentity(header, returned)
  ));
  const lastSubmittedHeader = submittedHeaders.at(-1);
  const workerJobDelta = safePositiveInteger(observations?.workerJobDelta);
  const workerResultDelta = safePositiveInteger(observations?.workerResultDelta);
  const queueDepthMax = safeNonNegativeInteger(observations?.queueDepthMax);
  const inFlightMax = safeNonNegativeInteger(observations?.inFlightMax);
  addFailure(failures, artifact?.injection?.kind === "worker-stale-generation", "wrong-stale-generation-injection");
  addFailure(failures, artifact?.injection?.delayMs === 96, "stale-generation-injection-delay-not-96ms");
  addFailure(
    failures,
    artifact?.injection?.buildAuthorityCurrent === true,
    "stale-generation-current-build-authority-not-proven",
  );
  addFailure(
    failures,
    buildAuthority?.fullBuildAuthoritative === true
      && buildAuthority?.networkAssetsPassed === true,
    "stale-generation-live-build-authority-not-proven",
  );
  addFailure(
    failures,
    workerLifecycle?.kind === "active-worker"
      && workerLifecycle?.drawingWorkerTargetCount === 1
      && workerLifecycle?.activeDrawingWorkerTargetCount === 1
      && workerLifecycle?.detachedDrawingWorkerTargetCount === 0
      && workerLifecycle?.constructionFaultCount === 0,
    "stale-generation-build-authority-lifecycle-invalid",
  );
  addFailure(failures, runtime?.workerResultDelayMs === 96, "stale-generation-runtime-delay-not-96ms");
  addFailure(failures, runtime?.engineMode === "scene-canary", "stale-generation-runtime-not-scene-canary");
  addFailure(failures, runtime?.backend === "worker", "stale-generation-runtime-backend-not-worker");
  addFailure(failures, runtime?.backendSource === "environment", "stale-generation-runtime-backend-source-not-environment");
  addFailure(failures, runtime?.workerAvailability === "available", "stale-generation-worker-not-available");
  addFailure(failures, runtime?.queueDepthMax === 2, "stale-generation-runtime-queue-depth-max-not-two");
  addFailure(failures, runtime?.inFlightMax === 1, "stale-generation-runtime-inflight-max-not-one");
  addFailure(failures, safePositiveInteger(runtime?.pendingDropDelta) !== null, "stale-generation-pending-drop-not-observed");
  addFailure(
    failures,
    exactZeroCounterPair(observations?.stalePublishCount),
    "stale-generation-publish-count-not-zero-before-and-after",
  );
  addFailure(failures, exactZero(runtime?.stalePublishCount), "stale-generation-runtime-stale-publish-observed-or-missing");
  addFailure(failures, exactZero(runtime?.sceneFallbackCount), "stale-generation-scene-fallback-observed-or-missing");
  addFailure(failures, exactZero(runtime?.sceneRuntimeFaultCount), "stale-generation-runtime-fault-observed-or-missing");
  addFailure(failures, exactZero(runtime?.legacyFallbackSucceededCount), "stale-generation-legacy-fallback-observed-or-missing");
  addFailure(
    failures,
    runtime?.queueDepthMax === observations?.queueDepthMax
      && runtime?.queueDepthCurrent === observations?.queueDepthCurrent
      && runtime?.inFlightMax === observations?.inFlightMax
      && runtime?.inFlightCurrent === observations?.inFlightCurrent
      && runtime?.workerJobDelta === observations?.workerJobDelta
      && runtime?.workerResultDelta === observations?.workerResultDelta
      && runtime?.staleResultDropDelta === observations?.staleResultDropDelta,
    "stale-generation-runtime-observations-mismatch",
  );
  addFailure(failures, safePositiveInteger(observations?.staleResultDropDelta) !== null, "stale-result-drop-not-observed");
  addFailure(failures, observations?.stalePublishDelta === 0, "stale-result-was-published");
  addFailure(
    failures,
    workerJobDelta !== null && workerResultDelta !== null && workerJobDelta > workerResultDelta,
    "latest-wins-pressure-not-proven",
  );
  addFailure(failures, queueDepthMax !== null && queueDepthMax <= 2, "worker-queue-depth-unbounded-or-missing");
  addFailure(failures, observations?.queueDepthCurrent === 0, "worker-queue-not-converged");
  addFailure(failures, inFlightMax !== null && inFlightMax <= 1, "worker-inflight-unbounded-or-missing");
  addFailure(failures, observations?.inFlightCurrent === 0, "worker-inflight-not-converged");
  addFailure(failures, validWorkerIdentity(returned), "returned-worker-identity-invalid-or-missing");
  addFailure(failures, validWorkerIdentity(accepted), "accepted-worker-identity-invalid-or-missing");
  addFailure(failures, validWorkerIdentity(published), "published-worker-identity-invalid-or-missing");
  addFailure(failures, validWorkerIdentity(latestSubmitted), "latest-submitted-worker-identity-invalid-or-missing");
  addFailure(
    failures,
    submittedHeaders.length >= 2 && submittedHeaders.every(validWorkerIdentity),
    "submitted-worker-header-sequence-invalid-or-too-small",
  );
  addFailure(
    failures,
    submittedHeaders.every((header, index) => (
      validWorkerIdentity(header)
        && (index === 0
          || (validWorkerIdentity(submittedHeaders[index - 1])
            && header.jobId > submittedHeaders[index - 1].jobId
            && header.generation > submittedHeaders[index - 1].generation))
    )),
    "submitted-worker-header-sequence-not-monotonic",
  );
  addFailure(
    failures,
    returnedSubmissionIndex >= 0 && returnedSubmissionIndex < submittedHeaders.length - 1,
    "returned-worker-identity-was-never-submitted-or-is-latest",
  );
  addFailure(
    failures,
    sameWorkerIdentity(latestSubmitted, lastSubmittedHeader),
    "latest-submitted-worker-identity-not-sequence-tail",
  );
  addFailure(
    failures,
    validWorkerIdentity(returned)
      && validWorkerIdentity(latestSubmitted)
      && returned.jobId < latestSubmitted.jobId
      && returned.generation < latestSubmitted.generation,
    "returned-worker-identity-not-stale",
  );
  addFailure(
    failures,
    sameWorkerIdentity(accepted, latestSubmitted),
    "accepted-worker-identity-not-latest-submitted",
  );
  addFailure(
    failures,
    sameWorkerIdentity(published, accepted),
    "published-worker-identity-not-accepted",
  );
  validateDocumentPreserved(failures, artifact?.outcome);
  addFailure(
    failures,
    validWorkerIdentity(latestSubmitted)
      && sameStamp(latestSubmitted.stamp, artifact?.outcome?.lastRequestedStamp),
    "latest-submitted-stamp-not-requested",
  );
  addFailure(
    failures,
    validWorkerIdentity(published)
      && sameStamp(published.stamp, artifact?.outcome?.lastPublishedStamp),
    "published-identity-stamp-not-published",
  );
  return failures;
}

function validPhase6Diagnostics(value) {
  return emptyArray(value?.consoleErrors)
    && emptyArray(value?.networkFailures)
    && emptyArray(value?.runtimeExceptions);
}

function validPhase6BackpressureRun(run, configuredDpr) {
  const runtime = run?.phase6Probe?.runtime;
  const workerJobDelta = safePositiveInteger(runtime?.workerJobDelta);
  const workerResultDelta = safePositiveInteger(runtime?.workerResultDelta);
  const queueDepthMax = safeNonNegativeInteger(runtime?.queueDepthMax);
  const inFlightMax = safeNonNegativeInteger(runtime?.inFlightMax);
  return run?.warmup === false
    && run?.phase6Probe?.started === true
    && finiteNumber(run?.phase6Probe?.backpressureDelayMs) >= 96
    && run?.phase6Probe?.fallbackRequested === false
    && run?.browserWindow?.headed === true
    && run?.browserWindow?.windowState === "normal"
    && run?.browserWindow?.visibilityState === "visible"
    && run?.browserWindow?.hidden === false
    && run?.browserWindow?.devicePixelRatio === configuredDpr
    && runtime?.engineMode === "scene-canary"
    && runtime?.backend === "worker"
    && runtime?.backendSource === "environment"
    && runtime?.canonicalRawPreserved === true
    && runtime?.scenePublicationReady === true
    && workerJobDelta !== null
    && workerResultDelta !== null
    && workerJobDelta > workerResultDelta
    && workerResultDelta > 0
    && safePositiveInteger(runtime?.staleResultDropDelta) !== null
    && runtime?.stalePublishDelta === 0
    && queueDepthMax !== null
    && queueDepthMax <= 2
    && runtime?.queueDepthCurrent === 0
    && inFlightMax !== null
    && inFlightMax <= 1
    && runtime?.inFlightCurrent === 0
    && sameStamp(runtime?.lastRequestedStamp, runtime?.lastPublishedStamp)
    && own(runtime, "lastPaintedStamp")
    && sameStamp(runtime?.lastPublishedStamp, runtime?.lastPaintedStamp)
    && validPaintReceipt(runtime?.paintReceipt, runtime?.lastPaintedStamp)
    && run?.restore?.passed === true
    && run?.restore?.runtimeSummaryMatchesSaved === true
    && run?.restore?.savedDrawingCountBeforeReload === run?.restore?.savedDrawingCountAfterReload
    && run?.restore?.savedDrawingCountAfterReload === run?.restore?.loadedDrawingCountAfterReload
    && validPhase6Diagnostics(run?.diagnostics);
}

export function assessPhase6StaleGenerationReport(report) {
  const failures = [];
  const value = objectValue(report);
  addFailure(failures, value !== null, "phase6-report-not-object");
  if (!value) return Object.freeze({ passed: false, failures: Object.freeze(failures) });

  const scenario = Array.isArray(value.scenarios)
    ? value.scenarios.find((candidate) => candidate?.id === "phase6-worker-backpressure")
    : null;
  const measuredRuns = Array.isArray(scenario?.rawRuns)
    ? scenario.rawRuns.filter((run) => run?.warmup === false)
    : [];
  const configuredDpr = finiteNumber(value.environment?.dpr);

  addFailure(failures, value.schemaVersion === PHASE6_SCHEMA_VERSION, "phase6-schema-mismatch");
  addFailure(failures, value.acceptance?.kind === "phase6" && value.acceptance?.passed === true, "phase6-acceptance-not-passed");
  addFailure(failures, value.phase6Acceptance?.passed === true, "phase6-specific-acceptance-not-passed");
  addFailure(failures, value.environment?.productionBuild === true, "phase6-production-build-not-proven");
  addFailure(failures, value.configuration?.serverMode === "managed-preview", "phase6-managed-preview-not-proven");
  addFailure(failures, value.configuration?.headless === false, "phase6-headed-browser-not-proven");
  addFailure(failures, value.configuration?.smokeOnly === false, "phase6-report-is-smoke-only");
  addFailure(failures, value.configuration?.drawingEngineMode === "scene-canary", "phase6-scene-canary-not-selected");
  addFailure(failures, value.configuration?.drawingRasterBackend === "worker", "phase6-worker-backend-not-selected");
  addFailure(failures, finiteNumber(configuredDpr) > 0, "phase6-configured-dpr-invalid");
  addFailure(failures, scenario?.passed === true, "phase6-backpressure-scenario-not-passed");
  addFailure(failures, measuredRuns.length >= 5, "phase6-backpressure-measured-run-coverage-too-small");
  for (const [index, run] of measuredRuns.entries()) {
    addFailure(
      failures,
      validPhase6BackpressureRun(run, configuredDpr),
      `phase6-backpressure-run-${index + 1}-invalid`,
    );
  }

  const contractPassed = failures.length === 0;
  if (contractPassed) failures.push("phase6-worker-result-generation-identity-not-recorded");
  return Object.freeze({
    passed: false,
    contractPassed,
    failures: Object.freeze(failures),
  });
}

const DEDICATED_VALIDATORS = Object.freeze({
  "worker-init-failure": validateWorkerInitFailure,
  "offscreen-canvas-unsupported": validateOffscreenUnsupported,
  "indexeddb-quota-blocked": validateIndexedDbQuotaBlocked,
  "worker-stale-generation": validateDedicatedStaleGeneration,
  "active-gesture-chart-boundary": validateActiveGestureBoundary,
  "series-rebuild-before-export": validateSeriesRebuildBeforeExport,
  "continuous-dpr-resize": validateContinuousDprResize,
  "canary-to-legacy-snapshot": validateCanaryToLegacySnapshot,
});

export function assessDrawingRollbackDrillArtifact(drillId, artifact) {
  if (!DRAWING_ROLLBACK_DRILL_IDS.includes(drillId)) {
    return Object.freeze({
      passed: false,
      trustedRunnerAccepted: false,
      completionAuthority: "trusted-controlled-browser-runner",
      evidenceKind: "unknown",
      failures: Object.freeze(["unknown-drill-id"]),
    });
  }
  if (drillId === "worker-stale-generation" && artifact?.schemaVersion === PHASE6_SCHEMA_VERSION) {
    const assessment = assessPhase6StaleGenerationReport(artifact);
    return Object.freeze({
      ...assessment,
      trustedRunnerAccepted: false,
      completionAuthority: "trusted-controlled-browser-runner",
      evidenceKind: "phase6-formal-browser",
    });
  }
  const contractFailures = DEDICATED_VALIDATORS[drillId](artifact);
  const contractPassed = contractFailures.length === 0;
  const failures = contractPassed
    ? ["external-artifact-untrusted-controlled-runner-required"]
    : contractFailures;
  return Object.freeze({
    passed: false,
    contractPassed,
    trustedRunnerAccepted: false,
    completionAuthority: "trusted-controlled-browser-runner",
    evidenceKind: "dedicated-browser-contract",
    failures: Object.freeze(failures),
  });
}

function componentEvidencePassed(drillId, value) {
  const minimumPassCount = DRAWING_ROLLBACK_DRILL_MANIFEST.find(
    (drill) => drill.id === drillId,
  )?.componentTest.minimumPassCount;
  const durationMs = finiteNumber(value?.durationMs);
  return value?.passed === true
    && value?.exitCode === 0
    && durationMs !== null
    && durationMs >= 0
    && nonEmptyString(value?.command)
    && integer(value?.passCount) !== null
    && integer(minimumPassCount) !== null
    && value.passCount >= minimumPassCount;
}

export function assessDrawingRollbackDrills({ artifacts = {}, componentEvidence = {} } = {}) {
  const results = DRAWING_ROLLBACK_DRILL_MANIFEST.map((drill) => {
    const artifactSupplied = Object.hasOwn(artifacts, drill.id);
    const componentSupplied = Object.hasOwn(componentEvidence, drill.id);
    const artifactAssessment = artifactSupplied
      ? assessDrawingRollbackDrillArtifact(drill.id, artifacts[drill.id])
      : null;
    const componentPassed = componentSupplied
      && componentEvidencePassed(drill.id, componentEvidence[drill.id]);
    const complete = artifactAssessment?.passed === true;
    const artifactContractPassed = artifactAssessment?.contractPassed === true;
    const status = complete
      ? "complete"
      : ((componentPassed || artifactContractPassed) ? "partial" : "missing");
    const failureReasons = complete
      ? []
      : (artifactAssessment?.failures ?? ["browser-drill-artifact-missing"]);

    return Object.freeze({
      id: drill.id,
      title: drill.title,
      status,
      complete,
      currentCoverage: drill.currentCoverage,
      requiredEvidence: drill.requiredEvidence,
      missingEvidence: complete ? null : drill.missingEvidence,
      artifactSupplied,
      artifactContractPassed,
      evidenceKind: artifactAssessment?.evidenceKind ?? null,
      componentEvidenceSupplied: componentSupplied,
      componentEvidencePassed: componentPassed,
      failureReasons: Object.freeze([...failureReasons]),
    });
  });

  const completedCount = results.filter((result) => result.complete).length;
  const partialCount = results.filter((result) => result.status === "partial").length;
  const missingCount = results.length - completedCount - partialCount;
  const invalidArtifactCount = results.filter(
    (result) => result.artifactSupplied && !result.complete && !result.artifactContractPassed,
  ).length;

  return Object.freeze({
    schemaVersion: "drawing-rollback-drill-assessment/v1",
    completionAuthority: "trusted-controlled-browser-runner",
    externalArtifactsCanCompleteDrills: false,
    requiredCount: DRAWING_ROLLBACK_DRILL_IDS.length,
    completedCount,
    partialCount,
    missingCount,
    invalidArtifactCount,
    phase9RollbackDrillsPassed: completedCount === DRAWING_ROLLBACK_DRILL_IDS.length,
    results: Object.freeze(results),
  });
}
