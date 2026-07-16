const DEDICATED_SCHEMA_VERSION = "drawing-rollback-drill/v1";
const PHASE6_SCHEMA_VERSION = "drawing-engine-v2-perf/v1";

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
    missingEvidence: "worker-global capability injection and typed-result publication proof",
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
    missingEvidence: "pointerdown to boundary change to cancellation in one browser transaction",
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
    missingEvidence: "cross-build same-profile execution and exact snapshot digest/count proof",
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

function exactTrue(value) {
  return value === true;
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
  const diagnostics = objectValue(report.diagnostics);
  const injection = objectValue(report.injection);

  addFailure(failures, report.schemaVersion === DEDICATED_SCHEMA_VERSION, "dedicated-schema-mismatch");
  addFailure(failures, report.drillId === drillId, "drill-id-mismatch");
  addFailure(failures, exactTrue(report.completed), "drill-not-completed");
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
  addFailure(failures, value?.canonicalDocumentPreserved === true, "canonical-document-not-preserved");
  addFailure(failures, sameNonEmptyString(value?.beforeDigest, value?.afterDigest), "document-digest-mismatch");
  addFailure(
    failures,
    integer(value?.beforeEntityCount) !== null
      && integer(value?.beforeEntityCount) > 0
      && value.beforeEntityCount === value.afterEntityCount,
    "document-entity-count-mismatch",
  );
  addFailure(failures, value?.currentPaintConverged === true, "current-paint-not-converged");
  addFailure(failures, value?.queueDepthCurrent === 0, "queue-not-converged");
  addFailure(failures, sameStamp(value?.lastRequestedStamp, value?.lastPublishedStamp), "published-stamp-not-current");
  addFailure(failures, sameStamp(value?.lastPublishedStamp, value?.lastPaintedStamp), "painted-stamp-not-current");
}

function validateWorkerInitFailure(artifact) {
  const failures = validateDedicatedCommon("worker-init-failure", artifact);
  const injection = objectValue(artifact?.injection);
  const observations = objectValue(artifact?.observations);
  addFailure(failures, injection?.kind === "worker-constructor-throws", "wrong-worker-init-injection");
  addFailure(failures, observations?.workerConstructorAttempted === true, "worker-constructor-not-attempted");
  addFailure(failures, observations?.workerConstructionFailed === true, "worker-construction-failure-not-observed");
  addFailure(failures, observations?.fallbackBackend === "main-thread", "main-thread-fallback-not-active");
  addFailure(failures, observations?.scenePublicationReady === true, "scene-publication-not-ready");
  addFailure(failures, observations?.workerJobDelta === 0, "worker-job-ran-after-construction-failure");
  validateDocumentPreserved(failures, artifact?.outcome);
  return failures;
}

function validateOffscreenUnsupported(artifact) {
  const failures = validateDedicatedCommon("offscreen-canvas-unsupported", artifact);
  const injection = objectValue(artifact?.injection);
  const observations = objectValue(artifact?.observations);
  addFailure(failures, injection?.kind === "offscreen-canvas-unavailable", "wrong-offscreen-injection");
  addFailure(failures, observations?.workerCreated === true, "drawing-worker-not-created");
  addFailure(failures, observations?.offscreenSupported === false, "offscreen-capability-not-disabled");
  addFailure(failures, observations?.backend === "worker", "worker-backend-not-retained");
  addFailure(failures, finiteNumber(observations?.typedResultCount) > 0, "typed-worker-result-not-observed");
  addFailure(failures, observations?.bitmapResultCount === 0, "bitmap-result-observed-without-offscreen");
  addFailure(failures, observations?.scenePublicationReady === true, "scene-publication-not-ready");
  validateDocumentPreserved(failures, artifact?.outcome);
  return failures;
}

function validateIndexedDbVariant(failures, value, kind) {
  const variant = objectValue(value);
  addFailure(failures, variant !== null, `indexeddb-${kind}-variant-missing`);
  addFailure(failures, variant?.kind === kind, `indexeddb-${kind}-kind-mismatch`);
  addFailure(failures, variant?.injectionArmed === true, `indexeddb-${kind}-injection-not-armed`);
  addFailure(failures, variant?.injectionObserved === true, `indexeddb-${kind}-injection-not-observed`);
  addFailure(failures, variant?.writeRejected === true, `indexeddb-${kind}-write-not-rejected`);
  addFailure(failures, variant?.durableSnapshotPreserved === true, `indexeddb-${kind}-durable-snapshot-not-preserved`);
  addFailure(failures, variant?.manifestPreserved === true, `indexeddb-${kind}-manifest-not-preserved`);
  addFailure(failures, variant?.pendingDocumentRetained === true, `indexeddb-${kind}-pending-document-not-retained`);
  addFailure(failures, variant?.retrySucceeded === true, `indexeddb-${kind}-retry-not-successful`);
  addFailure(failures, variant?.restoredAfterRetryMatchesPending === true, `indexeddb-${kind}-retry-restore-mismatch`);
  addFailure(failures, sameNonEmptyString(variant?.pendingDigest, variant?.restoredDigest), `indexeddb-${kind}-pending-digest-mismatch`);
  addFailure(failures, finiteNumber(variant?.failureMetricDelta) > 0, `indexeddb-${kind}-failure-metric-missing`);
}

function validateIndexedDbQuotaBlocked(artifact) {
  const failures = validateDedicatedCommon("indexeddb-quota-blocked", artifact);
  addFailure(failures, artifact?.injection?.kind === "indexeddb-quota-and-blocked", "wrong-indexeddb-injection");
  const variants = Array.isArray(artifact?.variants) ? artifact.variants : [];
  addFailure(failures, variants.length === 2, "indexeddb-variant-count-mismatch");
  validateIndexedDbVariant(failures, variants.find((value) => value?.kind === "quota"), "quota");
  validateIndexedDbVariant(failures, variants.find((value) => value?.kind === "blocked"), "blocked");
  return failures;
}

function validateGestureVariant(failures, value, kind) {
  const variant = objectValue(value);
  addFailure(failures, variant !== null, `${kind}-gesture-variant-missing`);
  addFailure(failures, variant?.kind === kind, `${kind}-gesture-kind-mismatch`);
  addFailure(failures, variant?.pointerDownObserved === true, `${kind}-pointerdown-not-observed`);
  addFailure(failures, variant?.gestureActiveBeforeBoundary === true, `${kind}-gesture-not-active-before-boundary`);
  addFailure(failures, variant?.boundaryChanged === true, `${kind}-boundary-not-changed`);
  addFailure(failures, variant?.pointerCancelObserved === true, `${kind}-pointer-cancel-not-observed`);
  addFailure(failures, variant?.oldScopeMutationCount === 0, `${kind}-old-scope-mutated`);
  addFailure(failures, variant?.uncommittedMutationCount === 0, `${kind}-uncommitted-mutation-persisted`);
  addFailure(failures, variant?.newSurfaceReady === true, `${kind}-new-surface-not-ready`);
  addFailure(failures, variant?.currentPaintConverged === true, `${kind}-current-paint-not-converged`);
  addFailure(failures, sameNonEmptyString(variant?.beforeDigest, variant?.afterDigest), `${kind}-document-digest-mismatch`);
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
  const observations = objectValue(artifact?.observations);
  const outcome = objectValue(artifact?.outcome);
  addFailure(failures, artifact?.injection?.kind === "series-rebuild-before-export-capture", "wrong-export-rebuild-injection");
  addFailure(failures, observations?.prepareCompleted === true, "export-prepare-not-completed");
  addFailure(failures, observations?.rebuildStartedAfterPrepare === true, "series-rebuild-not-after-prepare");
  addFailure(failures, observations?.rebuildCompletedBeforeCapture === true, "series-rebuild-not-before-capture");
  addFailure(failures, observations?.surfaceGenerationAdvanced === true, "surface-generation-did-not-advance");
  addFailure(failures, observations?.staleLeaseRejected === true, "stale-export-lease-not-rejected");
  addFailure(failures, observations?.freshLeaseAcquired === true, "fresh-export-lease-not-acquired");
  addFailure(failures, observations?.captureCompleted === true, "export-capture-not-completed");
  addFailure(failures, observations?.drawingsIncluded === true, "export-drawings-not-proven");
  addFailure(failures, observations?.leaseRestored === true, "export-lease-not-restored");
  addFailure(failures, outcome?.currentPaintConverged === true, "post-export-paint-not-converged");
  addFailure(failures, sameNonEmptyString(outcome?.beforeDigest, outcome?.afterDigest), "export-document-digest-mismatch");
  addFailure(failures, sameStamp(outcome?.lastRequestedStamp, outcome?.lastPublishedStamp), "post-export-stamp-not-current");
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
  addFailure(failures, artifact?.injection?.kind === "canary-build-to-legacy-build", "wrong-cross-build-injection");
  addFailure(failures, canary?.mode === "scene-canary", "canary-build-mode-mismatch");
  addFailure(failures, legacy?.mode === "legacy", "legacy-build-mode-mismatch");
  addFailure(failures, canary?.productionBuild === true && legacy?.productionBuild === true, "cross-build-production-proof-missing");
  addFailure(failures, nonEmptyString(canary?.buildRevision), "canary-build-revision-missing");
  addFailure(failures, nonEmptyString(legacy?.buildRevision), "legacy-build-revision-missing");
  addFailure(failures, canary?.buildRevision !== legacy?.buildRevision, "cross-build-revisions-not-distinct");
  addFailure(failures, sameNonEmptyString(canary?.origin, legacy?.origin), "cross-build-origin-mismatch");
  addFailure(failures, sameNonEmptyString(canary?.profileId, legacy?.profileId), "cross-build-profile-mismatch");
  addFailure(failures, snapshot?.compatibilityWriteObserved === true, "compatibility-write-not-observed");
  addFailure(failures, snapshot?.legacyReadObserved === true, "legacy-read-not-observed");
  addFailure(failures, sameNonEmptyString(snapshot?.canaryDigest, snapshot?.legacyDigest), "cross-build-snapshot-digest-mismatch");
  addFailure(
    failures,
    integer(snapshot?.canaryEntityCount) !== null
      && integer(snapshot?.canaryEntityCount) > 0
      && snapshot.canaryEntityCount === snapshot.legacyEntityCount,
    "cross-build-entity-count-mismatch",
  );
  addFailure(failures, snapshot?.allNineKindsCovered === true, "cross-build-kind-coverage-incomplete");
  addFailure(failures, snapshot?.legacyRendererVisible === true, "legacy-renderer-visibility-not-proven");
  addFailure(failures, snapshot?.sourceBytesUnchangedByRead === true, "legacy-read-rewrote-source-bytes");
  return failures;
}

function validateDedicatedStaleGeneration(artifact) {
  const failures = validateDedicatedCommon("worker-stale-generation", artifact);
  const observations = objectValue(artifact?.observations);
  const workerJobDelta = finiteNumber(observations?.workerJobDelta);
  const workerResultDelta = finiteNumber(observations?.workerResultDelta);
  const queueDepthMax = finiteNumber(observations?.queueDepthMax);
  const inFlightMax = finiteNumber(observations?.inFlightMax);
  addFailure(failures, artifact?.injection?.kind === "worker-stale-generation", "wrong-stale-generation-injection");
  addFailure(failures, finiteNumber(observations?.staleResultDropDelta) > 0, "stale-result-drop-not-observed");
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
  validateDocumentPreserved(failures, artifact?.outcome);
  return failures;
}

function validPhase6Diagnostics(value) {
  return emptyArray(value?.consoleErrors)
    && emptyArray(value?.networkFailures)
    && emptyArray(value?.runtimeExceptions);
}

function validPhase6BackpressureRun(run, configuredDpr) {
  const runtime = run?.phase6Probe?.runtime;
  const workerJobDelta = finiteNumber(runtime?.workerJobDelta);
  const workerResultDelta = finiteNumber(runtime?.workerResultDelta);
  const queueDepthMax = finiteNumber(runtime?.queueDepthMax);
  const inFlightMax = finiteNumber(runtime?.inFlightMax);
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
    && finiteNumber(runtime?.staleResultDropDelta) > 0
    && runtime?.stalePublishDelta === 0
    && queueDepthMax !== null
    && queueDepthMax <= 2
    && runtime?.queueDepthCurrent === 0
    && inFlightMax !== null
    && inFlightMax <= 1
    && runtime?.inFlightCurrent === 0
    && sameStamp(runtime?.lastRequestedStamp, runtime?.lastPublishedStamp)
    && sameStamp(runtime?.lastPublishedStamp, runtime?.lastPaintedStamp)
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
    return Object.freeze({ passed: false, evidenceKind: "unknown", failures: Object.freeze(["unknown-drill-id"]) });
  }
  if (drillId === "worker-stale-generation" && artifact?.schemaVersion === PHASE6_SCHEMA_VERSION) {
    const assessment = assessPhase6StaleGenerationReport(artifact);
    return Object.freeze({ ...assessment, evidenceKind: "phase6-formal-browser" });
  }
  const contractFailures = DEDICATED_VALIDATORS[drillId](artifact);
  const contractPassed = contractFailures.length === 0;
  const failures = contractPassed
    ? ["controlled-browser-drill-runner-not-implemented"]
    : contractFailures;
  return Object.freeze({
    passed: false,
    contractPassed,
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
    requiredCount: DRAWING_ROLLBACK_DRILL_IDS.length,
    completedCount,
    partialCount,
    missingCount,
    invalidArtifactCount,
    phase9RollbackDrillsPassed: completedCount === DRAWING_ROLLBACK_DRILL_IDS.length,
    results: Object.freeze(results),
  });
}
