export const PHASE4_MIN_MEASURED_RUNS = 5;
export const PHASE4_MIN_WARMUP_RUNS = 1;
export const PHASE4_CROSSHAIR_MOVE_COUNT = 1_000;

export const PHASE4_SCENARIO_IDS = Object.freeze({
  migrated: "phase4-migrated-64-viewport",
  mixed: "phase4-mixed-64-viewport",
  crosshair: "phase4-crosshair-1000",
  freehand: "phase4-freehand-64-viewport",
});

export const PHASE4_REQUIRED_SCENARIO_IDS = Object.freeze(
  Object.values(PHASE4_SCENARIO_IDS),
);

const PHASE4_SCENE_TYPES = new Set(["line", "axis-line", "shape"]);

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function measuredRuns(scenario) {
  return (Array.isArray(scenario?.rawRuns) ? scenario.rawRuns : [])
    .filter((run) => run?.warmup !== true);
}

function allRuns(scenario) {
  return Array.isArray(scenario?.rawRuns) ? scenario.rawRuns : [];
}

function typeCountsForRun(run) {
  const typeCounts = run?.fixture?.drawingTypes;
  return typeCounts && typeof typeCounts === "object" && !Array.isArray(typeCounts)
    ? typeCounts
    : null;
}

export function phase4OwnershipFromTypeCounts(typeCounts) {
  if (!typeCounts || typeof typeCounts !== "object" || Array.isArray(typeCounts)) return null;
  let sceneDrawingCount = 0;
  let legacyDrawingCount = 0;
  for (const [type, rawCount] of Object.entries(typeCounts)) {
    const count = safeCount(rawCount);
    if (count === null) return null;
    if (PHASE4_SCENE_TYPES.has(type)) sceneDrawingCount += count;
    else legacyDrawingCount += count;
  }
  return {
    sceneDrawingCount,
    legacyDrawingCount,
    drawingCount: sceneDrawingCount + legacyDrawingCount,
    expectedAttachedPrimitiveCount: 1 + legacyDrawingCount,
  };
}

function attachmentEvidenceForRun(run) {
  const ownership = phase4OwnershipFromTypeCounts(typeCountsForRun(run));
  const summaries = [
    ["initial", run?.initialRuntimeSummary],
    ["after-action", run?.runtimeSummary],
    ["after-reload", run?.restore?.runtimeSummaryAfterReload],
  ];
  const observations = summaries.map(([stage, summary]) => ({
    stage,
    attachedPrimitiveCount: safeCount(summary?.attachedPrimitiveCount),
    entityCount: safeCount(summary?.entityCount),
  }));
  const passed = ownership !== null
    && ownership.drawingCount > 0
    && observations.every((observation) => (
      observation.attachedPrimitiveCount === ownership.expectedAttachedPrimitiveCount
      && observation.entityCount === ownership.drawingCount
    ));
  return { ownership, observations, passed };
}

function scenarioAttachmentEvidence(scenario) {
  const evidence = allRuns(scenario).map((run) => ({
    runId: run?.id ?? null,
    ...attachmentEvidenceForRun(run),
  }));
  return {
    runs: evidence,
    passed: evidence.length > 0 && evidence.every((item) => item.passed),
  };
}

function viewportProbePassed(run) {
  const probe = run?.phase4Probe;
  return probe?.started === true
    && safeCount(probe.observedFrameIntervals) !== null
    && probe.observedFrameIntervals > 0
    && safeCount(probe.maxRequestUpdatesPerFrame) !== null
    && probe.maxRequestUpdatesPerFrame <= 1
    && safeCount(run?.counters?.requestUpdatePerFrame) !== null
    && run.counters.requestUpdatePerFrame <= 1;
}

export function buildPhase4Acceptance(report, args = {}) {
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];
  const byId = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  const missingRequiredScenarioIds = PHASE4_REQUIRED_SCENARIO_IDS
    .filter((id) => !byId.has(id));
  const requiredScenarios = PHASE4_REQUIRED_SCENARIO_IDS
    .map((id) => byId.get(id))
    .filter(Boolean);
  const measuredRunCoveragePassed = requiredScenarios.length === PHASE4_REQUIRED_SCENARIO_IDS.length
    && Number(args.runs) >= PHASE4_MIN_MEASURED_RUNS
    && requiredScenarios.every((scenario) => (
      Number(scenario?.repetitions?.measuredRuns) >= PHASE4_MIN_MEASURED_RUNS
      && measuredRuns(scenario).length >= PHASE4_MIN_MEASURED_RUNS
    ));
  const warmupCoveragePassed = requiredScenarios.length === PHASE4_REQUIRED_SCENARIO_IDS.length
    && Number(args.warmupRuns) >= PHASE4_MIN_WARMUP_RUNS
    && requiredScenarios.every((scenario) => (
      Number(scenario?.repetitions?.warmupRuns) >= PHASE4_MIN_WARMUP_RUNS
    ));

  const migratedScenario = byId.get(PHASE4_SCENARIO_IDS.migrated);
  const mixedScenario = byId.get(PHASE4_SCENARIO_IDS.mixed);
  const crosshairScenario = byId.get(PHASE4_SCENARIO_IDS.crosshair);
  const freehandScenario = byId.get(PHASE4_SCENARIO_IDS.freehand);
  const migratedAttachmentEvidence = scenarioAttachmentEvidence(migratedScenario);
  const mixedAttachmentEvidence = scenarioAttachmentEvidence(mixedScenario);
  const crosshairAttachmentEvidence = scenarioAttachmentEvidence(crosshairScenario);
  const freehandAttachmentEvidence = scenarioAttachmentEvidence(freehandScenario);

  const migratedFixturePassed = migratedAttachmentEvidence.passed
    && crosshairAttachmentEvidence.passed
    && migratedAttachmentEvidence.runs.every((item) => (
      item.ownership?.sceneDrawingCount > 0
      && item.ownership?.legacyDrawingCount === 0
      && item.ownership?.expectedAttachedPrimitiveCount === 1
    ))
    && crosshairAttachmentEvidence.runs.every((item) => (
      item.ownership?.sceneDrawingCount > 0
      && item.ownership?.legacyDrawingCount === 0
      && item.ownership?.expectedAttachedPrimitiveCount === 1
    ));
  const mixedFixturePassed = mixedAttachmentEvidence.passed
    && mixedAttachmentEvidence.runs.every((item) => (
      item.ownership?.sceneDrawingCount > 0
      && item.ownership?.legacyDrawingCount > 0
      && item.ownership?.expectedAttachedPrimitiveCount === 1
        + item.ownership.legacyDrawingCount
    ));

  const crosshairRuns = measuredRuns(crosshairScenario);
  const crosshairRebuildPassed = crosshairRuns.length > 0 && crosshairRuns.every((run) => (
    run?.action?.crosshairMovesDispatched === PHASE4_CROSSHAIR_MOVE_COUNT
    && run?.phase4Probe?.started === true
    && safeCount(run.phase4Probe.totalSceneRebuilds) === 0
    && safeCount(run.phase4Probe.totalFinalProjections) === 0
    && safeCount(run?.counters?.sceneRebuildCount) === 0
    && safeCount(run?.counters?.staticProjectionCount) === 0
  ));

  const viewportScenarios = [migratedScenario, mixedScenario, freehandScenario].filter(Boolean);
  const viewportRequestUpdatePassed = viewportScenarios.length === 3
    && viewportScenarios.every((scenario) => {
      const runs = measuredRuns(scenario);
      return runs.length > 0 && runs.every(viewportProbePassed);
    });

  const freehandRuns = measuredRuns(freehandScenario);
  const freehandViewUpdateFanoutPassed = freehandAttachmentEvidence.passed
    && freehandRuns.length > 0
    && freehandRuns.every((run) => {
      const ownership = phase4OwnershipFromTypeCounts(typeCountsForRun(run));
      const totalRequests = safeCount(run?.phase4Probe?.totalRequestUpdates);
      const observedIntervals = safeCount(run?.phase4Probe?.observedFrameIntervals);
      const totalSceneRebuilds = safeCount(run?.phase4Probe?.totalSceneRebuilds);
      const maxSceneRebuildsPerFrame = safeCount(
        run?.phase4Probe?.maxSceneRebuildsPerFrame,
      );
      return ownership?.sceneDrawingCount === 0
        && ownership?.legacyDrawingCount === 64
        && ownership?.expectedAttachedPrimitiveCount === 65
        && viewportProbePassed(run)
        && totalRequests !== null
        && observedIntervals !== null
        && totalRequests <= observedIntervals
        // Legacy FreehandPaneView.update records one scene rebuild per
        // updateAllViews call. This catches the otherwise invisible 64-way LWC
        // view-update fanout even though that path never calls requestUpdate.
        && totalSceneRebuilds !== null
        && maxSceneRebuildsPerFrame !== null
        && maxSceneRebuildsPerFrame <= 1
        && totalSceneRebuilds <= observedIntervals;
    });

  const engineModePassed = report?.configuration?.drawingEngineMode === "scene-canary"
    && report?.context?.mode === "scene-canary";
  const productionBuildPassed = report?.environment?.productionBuild === true
    && report?.environment?.productionBuildVerification === "managed-vite-preview";
  const executionPassed = report?.executionAcceptance?.passed === true;
  const phase4Eligible = args.smoke !== true && productionBuildPassed;
  const passed = phase4Eligible
    && engineModePassed
    && missingRequiredScenarioIds.length === 0
    && measuredRunCoveragePassed
    && warmupCoveragePassed
    && executionPassed
    && migratedFixturePassed
    && mixedFixturePassed
    && crosshairRebuildPassed
    && viewportRequestUpdatePassed
    && freehandViewUpdateFanoutPassed;
  const failureReasons = [];
  if (args.smoke === true) failureReasons.push("smoke-only-run");
  if (!productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!engineModePassed) failureReasons.push("scene-canary-mode-not-selected");
  if (missingRequiredScenarioIds.length > 0) failureReasons.push("missing-required-scenarios");
  if (!measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!migratedFixturePassed) failureReasons.push("migrated-fixture-attachment-count-failed");
  if (!mixedFixturePassed) failureReasons.push("mixed-fixture-attachment-count-failed");
  if (!crosshairRebuildPassed) failureReasons.push("crosshair-static-scene-rebuilt");
  if (!viewportRequestUpdatePassed) failureReasons.push("viewport-request-update-over-one-per-frame");
  if (!freehandViewUpdateFanoutPassed) failureReasons.push("freehand-view-update-fanout-detected");

  return {
    passed,
    phase4Eligible,
    productionBuildPassed,
    engineModePassed,
    requiredScenarioIds: [...PHASE4_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds,
    minimumMeasuredRuns: PHASE4_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE4_MIN_WARMUP_RUNS,
    warmupCoveragePassed,
    executionPassed,
    migratedFixturePassed,
    migratedAttachmentEvidence,
    crosshairAttachmentEvidence,
    mixedFixturePassed,
    mixedAttachmentEvidence,
    crosshairMoveCount: PHASE4_CROSSHAIR_MOVE_COUNT,
    crosshairRebuildPassed,
    viewportRequestUpdatePassed,
    freehandViewUpdateFanoutPassed,
    freehandAttachmentEvidence,
    failureReasons,
  };
}
