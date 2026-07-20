import { PHASE6_LINEAGE_REPRESENTATION } from "./drawing-performance-phase6-lineage.mjs";
import { phase6LatestWorkerPaintConverged } from "./drawing-performance-phase6-browser.mjs";
import { devicePixelRatioMatches } from "./drawing-device-metrics.mjs";

export const PHASE6_MIN_MEASURED_RUNS = 5;
export const PHASE6_MIN_WARMUP_RUNS = 1;
export const PHASE6_BAR_COUNT = 10_000;
export const PHASE6_POINTER_SAMPLE_COUNT = 4_096;
export const PHASE6_HIT_QUERY_COUNT = 1_000;

export const PHASE6_BUDGETS = Object.freeze({
  drawingMainThreadP95Ms: 4,
  drawingMainThreadP99Ms: 8,
  inputToNextPaintP95Ms: 20,
  inputToNextPaintP99Ms: 33,
  sceneProjectPaintP95Ms: 10,
  sceneProjectPaintP99Ms: 16,
  frameIntervalP95Ms: 20,
  frameIntervalP99Ms: 33.4,
  hitQueryP95Ms: 1,
  hitQueryP99Ms: 2,
  hitQueryMaxMs: 4,
  mouseupSyncP95Ms: 8,
  mouseupSyncP99Ms: 16,
  workerFinalizeP95Ms: 150,
  exactRenderMaxMs: 120,
  workerQueueDepthMax: 2,
  workerInFlightMax: 1,
});

export const PHASE6_SCENARIO_IDS = Object.freeze({
  freehandZoomPan: "phase6-freehand64-zoom-pan",
  freehandLineageZoomPan: "phase6-freehand-lineage64-zoom-pan",
  hitIndex: "phase6-hit-index-1000",
  activeFinalize: "phase6-active-4096-finalize",
  workerBackpressure: "phase6-worker-backpressure",
  mainThreadFallback: "phase6-main-thread-fallback",
});

export const PHASE6_LINEAGE_VIEWPORT_SCENARIO = Object.freeze({
  id: PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  fixture: "freehandLineage64x512",
  action: "phase6-viewport",
  requiredMetrics: Object.freeze(["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"]),
  targetMetrics: Object.freeze(["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"]),
  targetCounters: Object.freeze([
    "surfacePrimitiveCount",
    "workerQueueDepth",
    "workerInFlight",
    "staleWorkerPublishCount",
  ]),
  representation: PHASE6_LINEAGE_REPRESENTATION,
});

export const PHASE6_REQUIRED_SCENARIO_IDS = Object.freeze(
  Object.values(PHASE6_SCENARIO_IDS),
);

export function normalizePhase6PanePlotRect(mainPanePlotRect) {
  const width = Number(mainPanePlotRect?.width);
  const height = Number(mainPanePlotRect?.height);
  const dpr = Number(mainPanePlotRect?.dpr);
  if (!Number.isFinite(width) || width <= 0
    || !Number.isFinite(height) || height <= 0
    || !Number.isFinite(dpr) || dpr <= 0) return null;
  return Object.freeze({ x: 0, y: 0, width, height, dpr });
}

function radicalInverse(index, base) {
  let value = index;
  let factor = 1 / base;
  let result = 0;
  while (value > 0) {
    result += (value % base) * factor;
    value = Math.floor(value / base);
    factor /= base;
  }
  return result;
}

/**
 * Builds deterministic low-discrepancy probes in pane-local CSS coordinates.
 * `mainPanePlotRect.x/y` are host offsets and must never leak into the hit index.
 */
export function buildPhase6HitQueryPoints(mainPanePlotRect, count = PHASE6_HIT_QUERY_COUNT) {
  const localRect = normalizePhase6PanePlotRect(mainPanePlotRect);
  if (!localRect || !Number.isSafeInteger(count) || count <= 0) return [];
  const horizontalInset = Math.min(4, localRect.width * 0.01);
  const verticalInset = Math.min(4, localRect.height * 0.01);
  const queryWidth = Math.max(0, localRect.width - horizontalInset * 2);
  const queryHeight = Math.max(0, localRect.height - verticalInset * 2);
  return Array.from({ length: count }, (_, index) => Object.freeze({
    x: Number((horizontalInset + queryWidth * radicalInverse(index + 1, 2)).toFixed(3)),
    y: Number((verticalInset + queryHeight * radicalInverse(index + 1, 3)).toFixed(3)),
  }));
}

const PHASE6_WORKER_SCENARIO_IDS = Object.freeze([
  PHASE6_SCENARIO_IDS.freehandZoomPan,
  PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  PHASE6_SCENARIO_IDS.activeFinalize,
  PHASE6_SCENARIO_IDS.workerBackpressure,
]);

const PHASE6_HEAVY_SCENARIO_IDS = Object.freeze([
  PHASE6_SCENARIO_IDS.freehandZoomPan,
  PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  PHASE6_SCENARIO_IDS.activeFinalize,
  PHASE6_SCENARIO_IDS.workerBackpressure,
  PHASE6_SCENARIO_IDS.mainThreadFallback,
]);

const PHASE6_VIEWPORT_ONLY_SCENARIO_IDS = Object.freeze([
  PHASE6_SCENARIO_IDS.freehandZoomPan,
  PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
  PHASE6_SCENARIO_IDS.hitIndex,
  PHASE6_SCENARIO_IDS.workerBackpressure,
  PHASE6_SCENARIO_IDS.mainThreadFallback,
]);

const PHASE6_FREEHAND_FIXTURE = Object.freeze({
  name: "freehand64x512",
  entities: 64,
  points: 32_768,
  spans: 0,
  maxFreehandPointsPerDrawing: 512,
  maxFreehandSpansPerDrawing: 0,
  sourceLineage: false,
});

const PHASE6_FIXTURE_EXPECTATIONS = Object.freeze({
  [PHASE6_SCENARIO_IDS.freehandZoomPan]: PHASE6_FREEHAND_FIXTURE,
  [PHASE6_SCENARIO_IDS.freehandLineageZoomPan]: Object.freeze({
    ...PHASE6_FREEHAND_FIXTURE,
    name: "freehandLineage64x512",
    spans: 64,
    maxFreehandSpansPerDrawing: 1,
    sourceLineage: true,
    sourceProjection: PHASE6_LINEAGE_REPRESENTATION.projectorId,
    sourceProjectionConfig: PHASE6_LINEAGE_REPRESENTATION.projectionConfig,
  }),
  [PHASE6_SCENARIO_IDS.hitIndex]: Object.freeze({
    name: "entities512",
    entities: 512,
    points: 1_024,
    spans: 0,
    maxFreehandPointsPerDrawing: 0,
    maxFreehandSpansPerDrawing: 0,
    sourceLineage: false,
  }),
  [PHASE6_SCENARIO_IDS.activeFinalize]: PHASE6_FREEHAND_FIXTURE,
  [PHASE6_SCENARIO_IDS.workerBackpressure]: PHASE6_FREEHAND_FIXTURE,
  [PHASE6_SCENARIO_IDS.mainThreadFallback]: PHASE6_FREEHAND_FIXTURE,
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNonNegative(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function allRuns(scenario) {
  return Array.isArray(scenario?.rawRuns) ? scenario.rawRuns : [];
}

function measuredRuns(scenario) {
  return allRuns(scenario).filter((run) => run?.warmup !== true);
}

function metricSummary(scenario, metric) {
  const summary = scenario?.metrics?.[metric];
  return summary && typeof summary === "object" ? summary : null;
}

function metricGate(scenario, metric, limits) {
  const summary = metricSummary(scenario, metric);
  const samples = finiteNonNegative(summary?.samples);
  const checks = Object.entries(limits).map(([name, maximum]) => {
    const actual = finiteNumber(summary?.[name]);
    return {
      name,
      actual,
      maximum,
      passed: actual !== null && samples !== null && samples > 0 && actual <= maximum,
    };
  });
  return {
    scenarioId: scenario?.id ?? null,
    metric,
    samples,
    checks,
    passed: checks.length > 0 && checks.every((check) => check.passed),
  };
}

function runHasSamples(run, metric) {
  return Array.isArray(run?.samples?.[metric])
    && run.samples[metric].length > 0
    && run.samples[metric].every((value) => finiteNonNegative(value) !== null);
}

function sameStamp(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = [
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
  ];
  return keys.every((key) => left[key] === right[key]);
}

function fixtureEvidenceForScenario(scenario) {
  const expected = PHASE6_FIXTURE_EXPECTATIONS[scenario?.id];
  const fixture = scenario?.fixture;
  const actual = expected ? Object.fromEntries(
    Object.keys(expected).map((key) => [key, fixture?.[key] ?? null]),
  ) : null;
  const lineageExact = fixture?.lineageExact;
  const lineageOrdinalsPassed = scenario?.id !== PHASE6_SCENARIO_IDS.freehandLineageZoomPan
    || (Number.isFinite(lineageExact?.left?.time)
      && Number.isFinite(lineageExact?.right?.time)
      && lineageExact.left.time < lineageExact.right.time
      && Number.isSafeInteger(lineageExact?.left?.sourceOrdinal)
      && lineageExact.left.sourceOrdinal > 0
      && Number.isSafeInteger(lineageExact?.right?.sourceOrdinal)
      && lineageExact.right.sourceOrdinal > 0
      && Number.isSafeInteger(fixture?.lineageDerivedRowCount)
      && fixture.lineageDerivedRowCount > 0);
  return {
    scenarioId: scenario?.id ?? null,
    expected: expected ?? null,
    actual,
    lineageExact: lineageExact ?? null,
    lineageOrdinalsPassed,
    passed: !!expected && !!fixture
      && Object.entries(expected).every(([key, value]) => fixture[key] === value)
      && lineageOrdinalsPassed,
  };
}

function runtimeEvidenceForRun(scenarioId, run) {
  const probe = run?.phase6Probe;
  const runtime = probe?.runtime;
  const engineMode = runtime?.engineMode ?? null;
  const attachedPrimitiveCount = finiteNonNegative(runtime?.attachedPrimitiveCount);
  const queueDepthMax = finiteNonNegative(runtime?.queueDepthMax);
  const inFlightMax = finiteNonNegative(runtime?.inFlightMax);
  const queueDepthCurrent = finiteNonNegative(runtime?.queueDepthCurrent);
  const inFlightCurrent = finiteNonNegative(runtime?.inFlightCurrent);
  const workerJobDelta = finiteNonNegative(runtime?.workerJobDelta);
  const workerResultDelta = finiteNonNegative(runtime?.workerResultDelta);
  const pendingDropDelta = finiteNonNegative(runtime?.pendingDropDelta);
  const staleResultDropDelta = finiteNonNegative(runtime?.staleResultDropDelta);
  const stalePublishDelta = finiteNonNegative(runtime?.stalePublishDelta);
  const rawPointsMax = finiteNonNegative(runtime?.rawPointsMax);
  const renderedPointsMax = finiteNonNegative(runtime?.renderedPointsMax);
  const lodRatio = finiteNumber(runtime?.lodRatio);
  const initialRawPoints = finiteNonNegative(runtime?.initialRawPoints);
  const initialRenderedPoints = finiteNonNegative(runtime?.initialRenderedPoints);
  const initialLodRatio = finiteNumber(runtime?.initialLodRatio);
  const finalRawPoints = finiteNonNegative(runtime?.finalRawPoints);
  const finalRenderedPoints = finiteNonNegative(runtime?.finalRenderedPoints);
  const finalLodRatio = finiteNumber(runtime?.finalLodRatio);
  const lodObservationPhase = runtime?.lodObservationPhase === "initial"
    || runtime?.lodObservationPhase === "final"
    ? runtime.lodObservationPhase
    : null;
  const anchorResolveDelta = finiteNonNegative(runtime?.anchorResolveDelta);
  const workerResultDelayMs = finiteNonNegative(runtime?.workerResultDelayMs);
  const latestWorkerPainted = phase6LatestWorkerPaintConverged(runtime);
  const sourceLineageExactResolveCount = finiteNonNegative(
    runtime?.sourceLineageExactResolveCount,
  );
  const sourceLineageFallbackResolveCount = finiteNonNegative(
    runtime?.sourceLineageFallbackResolveCount,
  );
  const sourceLineageUnresolvedResolveCount = finiteNonNegative(
    runtime?.sourceLineageUnresolvedResolveCount,
  );
  const workerScenario = PHASE6_WORKER_SCENARIO_IDS.includes(scenarioId);
  const fallbackScenario = scenarioId === PHASE6_SCENARIO_IDS.mainThreadFallback;
  const heavyScenario = PHASE6_HEAVY_SCENARIO_IDS.includes(scenarioId);
  const viewportOnlyScenario = PHASE6_VIEWPORT_ONLY_SCENARIO_IDS.includes(scenarioId);
  const backendPassed = workerScenario
    ? runtime?.backend === "worker"
    : fallbackScenario
      ? runtime?.backend === "main-thread"
      : true;
  const workerUsePassed = workerScenario
    ? workerJobDelta !== null && workerJobDelta > 0
      && workerResultDelta !== null && workerResultDelta > 0
    : true;
  const visibleRasterScenario = workerScenario || fallbackScenario;
  const stampPassed = visibleRasterScenario
    ? sameStamp(runtime?.lastRequestedStamp, runtime?.lastPaintedStamp)
    : true;
  const lodPassed = heavyScenario
    ? initialRawPoints !== null && initialRawPoints >= 32_768
      && initialRenderedPoints !== null && initialRenderedPoints > 0
      && initialRenderedPoints < initialRawPoints
      && initialLodRatio !== null && initialLodRatio > 0 && initialLodRatio < 1
      && Math.abs(initialLodRatio - (initialRenderedPoints / initialRawPoints)) <= 1e-6
      && rawPointsMax !== null && rawPointsMax >= 32_768
      && renderedPointsMax !== null && renderedPointsMax > 0
      && renderedPointsMax < rawPointsMax
      && lodRatio !== null && lodRatio > 0 && lodRatio < 1
      && Math.abs(lodRatio - (renderedPointsMax / rawPointsMax)) <= 1e-6
      && lodObservationPhase !== null
      && finalRawPoints !== null && finalRawPoints > 0
      && finalRenderedPoints !== null && finalRenderedPoints > 0
      && finalRenderedPoints <= finalRawPoints
      && finalLodRatio !== null && finalLodRatio > 0 && finalLodRatio <= 1
      && Math.abs(finalLodRatio - (finalRenderedPoints / finalRawPoints)) <= 1e-6
      && runtime?.canonicalRawPreserved === true
      && runtime?.vertexBudgetPassed === true
    : true;
  const backpressurePassed = scenarioId === PHASE6_SCENARIO_IDS.workerBackpressure
    ? queueDepthMax === PHASE6_BUDGETS.workerQueueDepthMax
      && inFlightMax === PHASE6_BUDGETS.workerInFlightMax
      && queueDepthCurrent === 0
      && inFlightCurrent === 0
      && pendingDropDelta !== null && pendingDropDelta > 0
      && workerJobDelta !== null
      && workerJobDelta >= pendingDropDelta + 2
      && workerResultDelta !== null
      && staleResultDropDelta !== null
      && latestWorkerPainted
      && workerResultDelayMs !== null
      && workerResultDelayMs === finiteNonNegative(probe?.backpressureDelayMs)
      && workerResultDelayMs > 0
    : true;
  const fallbackPassed = fallbackScenario
    ? probe?.fallbackRequested === true
      && runtime?.backend === "main-thread"
      && runtime?.backendSource === "benchmark-fallback"
      && workerJobDelta === 0
      && workerResultDelta === 0
      && sameStamp(runtime?.lastRequestedStamp, runtime?.lastPublishedStamp)
    : true;
  const sourceLineagePassed = scenarioId === PHASE6_SCENARIO_IDS.freehandLineageZoomPan
    ? sourceLineageExactResolveCount !== null && sourceLineageExactResolveCount > 0
      && sourceLineageFallbackResolveCount === 0
      && sourceLineageUnresolvedResolveCount === 0
    : true;
  const evidencePresent = probe?.started === true
    && runtime && typeof runtime === "object"
    && typeof runtime.offscreenSupported === "boolean"
    && engineMode === "scene-canary"
    && runtime.scenePublicationReady === true;
  const passed = evidencePresent
    && attachedPrimitiveCount === 1
    && queueDepthMax !== null && queueDepthMax <= PHASE6_BUDGETS.workerQueueDepthMax
    && inFlightMax !== null && inFlightMax <= PHASE6_BUDGETS.workerInFlightMax
    && stalePublishDelta === 0
    && pendingDropDelta !== null
    && staleResultDropDelta !== null
    && backendPassed
    && workerUsePassed
    && stampPassed
    && lodPassed
    && backpressurePassed
    && fallbackPassed
    && sourceLineagePassed
    && (!viewportOnlyScenario || anchorResolveDelta === 0);
  return {
    scenarioId,
    runId: run?.id ?? null,
    passed,
    evidencePresent,
    engineMode,
    attachedPrimitiveCount,
    queueDepthMax,
    inFlightMax,
    queueDepthCurrent,
    inFlightCurrent,
    workerJobDelta,
    workerResultDelta,
    pendingDropDelta,
    staleResultDropDelta,
    stalePublishDelta,
    rawPointsMax,
    renderedPointsMax,
    lodRatio,
    initialRawPoints,
    initialRenderedPoints,
    initialLodRatio,
    finalRawPoints,
    finalRenderedPoints,
    finalLodRatio,
    lodObservationPhase,
    anchorResolveDelta,
    backend: runtime?.backend ?? null,
    backendSource: runtime?.backendSource ?? null,
    workerResultDelayMs,
    latestWorkerPainted,
    sourceLineageExactResolveCount,
    sourceLineageFallbackResolveCount,
    sourceLineageUnresolvedResolveCount,
    offscreenSupported: runtime?.offscreenSupported ?? null,
    backendPassed,
    workerUsePassed,
    stampPassed,
    lodPassed,
    backpressurePassed,
    fallbackPassed,
    sourceLineagePassed,
  };
}

function actionEvidenceForRun(scenarioId, run) {
  const action = run?.action ?? {};
  const currentPaintPassed = action.currentPaintWaitPassed === true
    && !!action.currentPaintPreviousStamp
    && !sameStamp(action.currentPaintPreviousStamp, action.currentPaintRequestedStamp)
    && sameStamp(action.currentPaintRequestedStamp, action.currentPaintedStamp);
  if (scenarioId === PHASE6_SCENARIO_IDS.freehandZoomPan
    || scenarioId === PHASE6_SCENARIO_IDS.freehandLineageZoomPan) {
    return {
      passed: finiteNonNegative(action.wheelEventsDispatched) > 0
        && finiteNonNegative(action.panEventsDispatched) > 0
        && currentPaintPassed,
    };
  }
  if (scenarioId === PHASE6_SCENARIO_IDS.hitIndex) {
    const oracle = run?.phase6Probe?.hitOracle;
    const queryCount = finiteNonNegative(oracle?.queryCount);
    const mismatchCount = finiteNonNegative(oracle?.mismatchCount);
    const positiveHitCount = finiteNonNegative(oracle?.positiveHitCount);
    const candidateCoverageCount = finiteNonNegative(oracle?.candidateCoverageCount);
    const maxCandidates = finiteNonNegative(oracle?.maxCandidates);
    const totalSegments = finiteNonNegative(oracle?.totalSegments);
    const queryStampPassed = action.hitQueryPaintWaitPassed === true
      && action.hitQueryCurrentPainted === true
      && action.hitOracleOutsideMeasurementWindow === true
      && !!action.hitQueryPreviousStamp
      && !sameStamp(action.hitQueryPreviousStamp, action.hitQueryRequestedStamp)
      && sameStamp(action.hitQueryRequestedStamp, action.hitQueryPaintedStamp)
      && sameStamp(action.hitQueryQueriedStamp, action.hitQueryOraclePaintedStamp)
      && sameStamp(action.hitQueryQueriedStamp, oracle?.queriedStamp)
      && sameStamp(oracle?.queriedStamp, oracle?.paintedStamp)
      && oracle?.currentPainted === true;
    const queryPlotRect = action.hitQueryPlotRect;
    const paneLocalCoordinatesPassed = action.hitQueryCoordinateSpace === "pane-local"
      && finiteNumber(queryPlotRect?.x) === 0
      && finiteNumber(queryPlotRect?.y) === 0
      && finiteNumber(queryPlotRect?.width) > 0
      && finiteNumber(queryPlotRect?.height) > 0
      && finiteNumber(queryPlotRect?.dpr) > 0;
    return {
      queryCount,
      mismatchCount,
      positiveHitCount,
      candidateCoverageCount,
      maxCandidates,
      totalSegments,
      queryStampPassed,
      paneLocalCoordinatesPassed,
      passed: action.hitQueriesRequested === PHASE6_HIT_QUERY_COUNT
        && action.hitOracleQueryCount === queryCount
        && action.hitOracleMismatchCount === mismatchCount
        && action.hitOraclePositiveHitCount === positiveHitCount
        && action.hitOracleCandidateCoverageCount === candidateCoverageCount
        && action.hitOracleMaxCandidates === maxCandidates
        && oracle?.supported === true
        && queryCount === PHASE6_HIT_QUERY_COUNT
        && mismatchCount === 0
        && positiveHitCount !== null
        && positiveHitCount > 0
        && candidateCoverageCount !== null
        && candidateCoverageCount > 0
        && maxCandidates !== null
        && maxCandidates > 0
        && totalSegments !== null
        && totalSegments > 0
        && maxCandidates < totalSegments
        && queryStampPassed
        && paneLocalCoordinatesPassed,
    };
  }
  if (scenarioId === PHASE6_SCENARIO_IDS.activeFinalize) {
    const handoffs = Array.isArray(run?.phase5Probe?.handoffs)
      ? run.phase5Probe.handoffs.filter((handoff) => handoff?.kind === "live-ink")
      : [];
    const exactHandoff = handoffs.some((handoff) => handoff?.exactTicketObserved === true
      && handoff?.exactAckBeforeClear === true
      && handoff?.blankFrameCount === 0);
    return {
      exactHandoff,
      passed: action.heavyPointerSamplesDispatched === PHASE6_POINTER_SAMPLE_COUNT
        && action.committedPointerSamplesDispatched === PHASE6_POINTER_SAMPLE_COUNT
        && action.heavyFixturePreservedAfterCancel === true
        && action.fixtureClearedBeforeCommit === true
        && exactHandoff,
    };
  }
  if (scenarioId === PHASE6_SCENARIO_IDS.workerBackpressure) {
    const workerDrainPassed = action.workerDrainWaitPassed === true
      && phase6LatestWorkerPaintConverged({
        backend: action.workerDrainBackend,
        queueDepthCurrent: action.workerDrainQueueDepthCurrent,
        inFlightCurrent: action.workerDrainInFlightCurrent,
        workerResultDelta: action.workerDrainResultDelta,
        lastRequestedStamp: action.workerDrainRequestedStamp,
        lastPublishedStamp: action.workerDrainPublishedStamp,
        lastPaintedStamp: action.workerDrainPaintedStamp,
        latestSubmittedWorkerIdentity: action.workerDrainLatestSubmittedIdentity,
        publishedWorkerIdentity: action.workerDrainPublishedIdentity,
        paintedWorkerIdentity: action.workerDrainPaintedIdentity,
        paintReceipt: action.workerDrainPaintReceipt,
      });
    return {
      currentPaintPassed,
      workerDrainPassed,
      passed: finiteNonNegative(action.workerBackpressureWheelEventsDispatched) >= 64
        && currentPaintPassed
        && workerDrainPassed,
    };
  }
  return {
    passed: finiteNonNegative(action.wheelEventsDispatched) > 0
      && finiteNonNegative(action.panEventsDispatched) > 0
      && run?.phase6Probe?.fallbackRequested === true
      && currentPaintPassed,
  };
}

function longTaskEvidence(scenario) {
  return {
    scenarioId: scenario?.id ?? null,
    attributableCount: finiteNonNegative(scenario?.longTasks?.attributableCount),
    observerSupported: measuredRuns(scenario).length >= PHASE6_MIN_MEASURED_RUNS
      && measuredRuns(scenario).every((run) => run?.bench?.longTaskSupported === true),
  };
}

export function buildPhase6Acceptance(report, args = {}) {
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];
  const byId = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  const requiredScenarios = PHASE6_REQUIRED_SCENARIO_IDS
    .map((id) => byId.get(id))
    .filter(Boolean);
  const missingRequiredScenarioIds = PHASE6_REQUIRED_SCENARIO_IDS
    .filter((id) => !byId.has(id));
  const productionBuildPassed = report?.environment?.productionBuild === true
    && report?.environment?.productionBuildVerification === "managed-vite-preview";
  const modePassed = report?.context?.mode === "scene-canary"
    && report?.configuration?.drawingEngineMode === "scene-canary"
    && report?.configuration?.drawingInteractionSurfaceMode === "overlay"
    && report?.configuration?.drawingRasterBackend === "worker"
    && report?.configuration?.buildEnvironment?.VITE_DRAWING_RASTER_BACKEND === "worker";
  const headedModePassed = report?.configuration?.headless === false;
  const barCoveragePassed = requiredScenarios.length === PHASE6_REQUIRED_SCENARIO_IDS.length
    && requiredScenarios.every((scenario) => scenario?.fixture?.bars === PHASE6_BAR_COUNT);
  const fixtureEvidence = requiredScenarios.map(fixtureEvidenceForScenario);
  const fixtureCoveragePassed = fixtureEvidence.length === PHASE6_REQUIRED_SCENARIO_IDS.length
    && fixtureEvidence.every((evidence) => evidence.passed);
  const measuredRunCoveragePassed = Number(args.runs) >= PHASE6_MIN_MEASURED_RUNS
    && requiredScenarios.length === PHASE6_REQUIRED_SCENARIO_IDS.length
    && requiredScenarios.every((scenario) => (
      Number(scenario?.repetitions?.measuredRuns) >= PHASE6_MIN_MEASURED_RUNS
      && measuredRuns(scenario).length >= PHASE6_MIN_MEASURED_RUNS
    ));
  const warmupCoveragePassed = Number(args.warmupRuns) >= PHASE6_MIN_WARMUP_RUNS
    && requiredScenarios.length === PHASE6_REQUIRED_SCENARIO_IDS.length
    && requiredScenarios.every((scenario) => (
      Number(scenario?.repetitions?.warmupRuns) >= PHASE6_MIN_WARMUP_RUNS
      && allRuns(scenario).filter((run) => run?.warmup === true).length
        >= PHASE6_MIN_WARMUP_RUNS
    ));
  const executionPassed = report?.executionAcceptance?.passed === true;
  const restorePassed = requiredScenarios.length === PHASE6_REQUIRED_SCENARIO_IDS.length
    && requiredScenarios.every((scenario) => allRuns(scenario).every(
      (run) => run?.restore?.passed === true,
    ));

  const runtimeEvidence = requiredScenarios.flatMap((scenario) => measuredRuns(scenario)
    .map((run) => runtimeEvidenceForRun(scenario.id, run)));
  const measuredRunCount = requiredScenarios.reduce(
    (count, scenario) => count + measuredRuns(scenario).length,
    0,
  );
  const configuredDpr = Number(report?.environment?.dpr);
  const browserEnvironmentEvidence = requiredScenarios.flatMap((scenario) => measuredRuns(scenario)
    .map((run) => {
      const windowDpr = finiteNumber(run?.browserWindow?.devicePixelRatio);
      const benchDpr = finiteNumber(run?.bench?.devicePixelRatio);
      return {
        scenarioId: scenario.id,
        runId: run?.id ?? null,
        windowState: run?.browserWindow?.windowState ?? null,
        visibilityState: run?.browserWindow?.visibilityState ?? null,
        hidden: run?.browserWindow?.hidden ?? null,
        windowDpr,
        benchDpr,
        windowDprPassed: devicePixelRatioMatches(windowDpr, configuredDpr),
        benchDprPassed: devicePixelRatioMatches(benchDpr, configuredDpr),
      };
    }));
  const browserEnvironmentPassed = headedModePassed
    && Number.isFinite(configuredDpr)
    && configuredDpr > 0
    && browserEnvironmentEvidence.length === measuredRunCount
    && browserEnvironmentEvidence.every((evidence) => (
      evidence.windowState === "normal"
      && evidence.visibilityState === "visible"
      && evidence.hidden === false
      && evidence.windowDprPassed
      && evidence.benchDprPassed
    ));
  const runtimeEvidencePassed = runtimeEvidence.length
    === measuredRunCount
    && measuredRunCount >= PHASE6_REQUIRED_SCENARIO_IDS.length * PHASE6_MIN_MEASURED_RUNS
    && runtimeEvidence.every((evidence) => evidence.passed);
  const actionEvidence = requiredScenarios.flatMap((scenario) => measuredRuns(scenario)
    .map((run) => ({ scenarioId: scenario.id, runId: run?.id ?? null,
      ...actionEvidenceForRun(scenario.id, run) })));
  const actionCoveragePassed = actionEvidence.length
    === measuredRunCount
    && measuredRunCount >= PHASE6_REQUIRED_SCENARIO_IDS.length * PHASE6_MIN_MEASURED_RUNS
    && actionEvidence.every((evidence) => evidence.passed);

  const metricEvidence = [];
  const addMetric = (id, metric, limits) => {
    const scenario = byId.get(id);
    metricEvidence.push(metricGate(scenario, metric, limits));
  };
  for (const id of [
    PHASE6_SCENARIO_IDS.freehandZoomPan,
    PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
    PHASE6_SCENARIO_IDS.workerBackpressure,
    PHASE6_SCENARIO_IDS.mainThreadFallback,
  ]) {
    addMetric(id, "sceneProjectPaintMs", {
      p95: PHASE6_BUDGETS.sceneProjectPaintP95Ms,
      p99: PHASE6_BUDGETS.sceneProjectPaintP99Ms,
    });
    addMetric(id, "frameIntervalMs", {
      p95: PHASE6_BUDGETS.frameIntervalP95Ms,
      p99: PHASE6_BUDGETS.frameIntervalP99Ms,
    });
    // The backpressure scenario deliberately injects worker result latency to
    // hold one job in flight while newer viewports replace the pending slot.
    // It must still publish and paint a final exact stamp (per-run coverage
    // below), but the injected delay is not a production exact-settle budget.
    if (id !== PHASE6_SCENARIO_IDS.workerBackpressure) {
      addMetric(id, "exactRenderMs", { max: PHASE6_BUDGETS.exactRenderMaxMs });
    }
  }
  addMetric(PHASE6_SCENARIO_IDS.hitIndex, "hitQueryMs", {
    p95: PHASE6_BUDGETS.hitQueryP95Ms,
    p99: PHASE6_BUDGETS.hitQueryP99Ms,
    max: PHASE6_BUDGETS.hitQueryMaxMs,
  });
  addMetric(PHASE6_SCENARIO_IDS.activeFinalize, "drawingMainThreadMs", {
    p95: PHASE6_BUDGETS.drawingMainThreadP95Ms,
    p99: PHASE6_BUDGETS.drawingMainThreadP99Ms,
  });
  addMetric(PHASE6_SCENARIO_IDS.activeFinalize, "inputToNextPaintMs", {
    p95: PHASE6_BUDGETS.inputToNextPaintP95Ms,
    p99: PHASE6_BUDGETS.inputToNextPaintP99Ms,
  });
  addMetric(PHASE6_SCENARIO_IDS.activeFinalize, "frameIntervalMs", {
    p95: PHASE6_BUDGETS.frameIntervalP95Ms,
    p99: PHASE6_BUDGETS.frameIntervalP99Ms,
  });
  addMetric(PHASE6_SCENARIO_IDS.activeFinalize, "mouseupSyncMs", {
    p95: PHASE6_BUDGETS.mouseupSyncP95Ms,
    p99: PHASE6_BUDGETS.mouseupSyncP99Ms,
  });
  addMetric(PHASE6_SCENARIO_IDS.activeFinalize, "workerFinalizeMs", {
    p95: PHASE6_BUDGETS.workerFinalizeP95Ms,
  });
  addMetric(PHASE6_SCENARIO_IDS.activeFinalize, "exactRenderMs", {
    max: PHASE6_BUDGETS.exactRenderMaxMs,
  });
  const metricBudgetsPassed = metricEvidence.length > 0
    && metricEvidence.every((evidence) => evidence.passed);

  const requiredRunMetrics = new Map([
    [PHASE6_SCENARIO_IDS.freehandZoomPan,
      ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"]],
    [PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
      ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"]],
    [PHASE6_SCENARIO_IDS.hitIndex, ["hitQueryMs"]],
    [PHASE6_SCENARIO_IDS.activeFinalize,
      ["drawingMainThreadMs", "inputToNextPaintMs", "frameIntervalMs", "mouseupSyncMs",
        "workerFinalizeMs", "exactRenderMs"]],
    [PHASE6_SCENARIO_IDS.workerBackpressure,
      ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"]],
    [PHASE6_SCENARIO_IDS.mainThreadFallback,
      ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"]],
  ]);
  const perRunMetricEvidence = requiredScenarios.flatMap((scenario) => measuredRuns(scenario)
    .map((run) => ({
      scenarioId: scenario.id,
      runId: run?.id ?? null,
      metrics: requiredRunMetrics.get(scenario.id) ?? [],
      passed: (requiredRunMetrics.get(scenario.id) ?? []).every(
        (metric) => runHasSamples(run, metric),
      ),
    })));
  const perRunMetricCoveragePassed = perRunMetricEvidence.length
    === measuredRunCount
    && measuredRunCount >= PHASE6_REQUIRED_SCENARIO_IDS.length * PHASE6_MIN_MEASURED_RUNS
    && perRunMetricEvidence.every((evidence) => evidence.passed);

  const longTasks = requiredScenarios.map(longTaskEvidence);
  const attributableLongTaskPassed = longTasks.length === PHASE6_REQUIRED_SCENARIO_IDS.length
    && longTasks.every((item) => item.observerSupported && item.attributableCount === 0);
  const phase6Eligible = args.smoke !== true && productionBuildPassed;
  const passed = phase6Eligible
    && modePassed
    && headedModePassed
    && missingRequiredScenarioIds.length === 0
    && barCoveragePassed
    && fixtureCoveragePassed
    && measuredRunCoveragePassed
    && warmupCoveragePassed
    && executionPassed
    && restorePassed
    && runtimeEvidencePassed
    && actionCoveragePassed
    && browserEnvironmentPassed
    && metricBudgetsPassed
    && perRunMetricCoveragePassed
    && attributableLongTaskPassed;
  const failureReasons = [];
  if (args.smoke === true) failureReasons.push("smoke-only-run");
  if (!productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!modePassed) failureReasons.push("phase6-managed-mode-invalid");
  if (!headedModePassed) failureReasons.push("phase6-headed-mode-required");
  if (missingRequiredScenarioIds.length > 0) failureReasons.push("missing-required-scenarios");
  if (!barCoveragePassed) failureReasons.push("phase6-10000-bars-fixture-invalid");
  if (!fixtureCoveragePassed) failureReasons.push("phase6-fixture-provenance-invalid");
  if (!measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!restorePassed) failureReasons.push("reload-restore-check-failed");
  if (!runtimeEvidencePassed) failureReasons.push("phase6-runtime-evidence-missing-or-invalid");
  if (!actionCoveragePassed) failureReasons.push("phase6-action-or-oracle-coverage-failed");
  if (!browserEnvironmentPassed) failureReasons.push("phase6-browser-environment-invalid");
  if (!metricBudgetsPassed) failureReasons.push("phase6-hard-latency-gate-failed");
  if (!perRunMetricCoveragePassed) failureReasons.push("phase6-required-metric-samples-missing");
  if (!attributableLongTaskPassed) failureReasons.push("phase6-attributable-long-task-detected");
  return {
    passed,
    phase6Eligible,
    smokeOnly: args.smoke === true,
    productionBuildPassed,
    modePassed,
    headedModePassed,
    requiredScenarioIds: [...PHASE6_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds,
    barCoveragePassed,
    fixtureCoveragePassed,
    fixtureEvidence,
    minimumMeasuredRuns: PHASE6_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE6_MIN_WARMUP_RUNS,
    warmupCoveragePassed,
    executionPassed,
    restorePassed,
    runtimeEvidencePassed,
    runtimeEvidence,
    actionCoveragePassed,
    actionEvidence,
    browserEnvironmentPassed,
    browserEnvironmentEvidence,
    metricBudgetsPassed,
    metricEvidence,
    perRunMetricCoveragePassed,
    perRunMetricEvidence,
    attributableLongTaskPassed,
    longTaskEvidence: longTasks,
    failureReasons,
  };
}
