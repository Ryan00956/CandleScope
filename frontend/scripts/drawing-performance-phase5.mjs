export const PHASE5_MIN_MEASURED_RUNS = 5;
export const PHASE5_MIN_WARMUP_RUNS = 1;
export const PHASE5_POINTER_SAMPLE_COUNT = 4_096;

export const PHASE5_BUDGETS = Object.freeze({
  activeOverlayCpuP95Ms: 2,
  drawingMainThreadP95Ms: 4,
  drawingMainThreadP99Ms: 8,
  frameIntervalP95Ms: 20,
  frameIntervalP99Ms: 33.4,
  inputToNextPaintP95Ms: 20,
  inputToNextPaintP99Ms: 33,
  mouseupSyncP95Ms: 8,
  mouseupSyncP99Ms: 16,
  attributableLongTasksOver50Ms: 0,
  pointerMoveRequestUpdateDelta: 0,
  pointerMoveReactRenderDelta: 0,
  pointerMoveSceneRebuildDelta: 0,
});

export const PHASE5_SCENARIO_IDS = Object.freeze({
  pen: "phase5-pen-4096",
  highlighter: "phase5-highlighter-4096",
  dragResize: "phase5-drag-resize",
  twoPoint: "phase5-two-point-commit-cancel",
  eraserCancel: "phase5-eraser-hover-cancel",
});

export const PHASE5_REQUIRED_SCENARIO_IDS = Object.freeze(
  Object.values(PHASE5_SCENARIO_IDS),
);

const REQUIRED_POINTER_MOVE_WINDOWS = Object.freeze({
  [PHASE5_SCENARIO_IDS.pen]: 2,
  [PHASE5_SCENARIO_IDS.highlighter]: 2,
  [PHASE5_SCENARIO_IDS.dragResize]: 2,
  [PHASE5_SCENARIO_IDS.twoPoint]: 1,
  [PHASE5_SCENARIO_IDS.eraserCancel]: 1,
});

const REQUIRED_HANDOFF_KINDS = Object.freeze({
  [PHASE5_SCENARIO_IDS.pen]: "live-ink",
  [PHASE5_SCENARIO_IDS.highlighter]: "live-ink",
  [PHASE5_SCENARIO_IDS.dragResize]: "dynamic",
  [PHASE5_SCENARIO_IDS.twoPoint]: "dynamic",
});

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function allRuns(scenario) {
  return Array.isArray(scenario?.rawRuns) ? scenario.rawRuns : [];
}

function measuredRuns(scenario) {
  return allRuns(scenario).filter((run) => run?.warmup !== true);
}

function heavySceneFixtureEvidence(scenario) {
  const entities = safeCount(scenario?.fixture?.entities);
  const points = safeCount(scenario?.fixture?.points);
  const dpr = finiteNonNegative(scenario?.fixture?.dpr);
  return {
    scenarioId: scenario?.id ?? null,
    entities,
    points,
    dpr,
    passed: entities === 64 && points === 32_768 && dpr !== null && dpr >= 1.5,
  };
}

function drawingTypeDelta(run, type) {
  const before = safeCount(run?.initialSavedSummary?.typeCounts?.[type] ?? 0);
  const after = safeCount(run?.restore?.savedSummaryBeforeReload?.typeCounts?.[type] ?? 0);
  return before === null || after === null ? null : after - before;
}

function finalDrawingPointCount(run) {
  return safeCount(run?.restore?.savedSummaryBeforeReload?.pointCount);
}

function surfaceEvidence(run) {
  const probe = run?.phase5Probe;
  const surface = probe?.surface ?? probe?.finalSurface ?? null;
  const initial = probe?.initialSurface ?? null;
  const snapshots = [initial, surface].filter(Boolean);
  const snapshotPassed = (item) => item?.overlayCount === 2
    && item?.dynamic?.present === true
    && item?.liveInk?.present === true
    && item?.dynamic?.pointerEventsNone === true
    && item?.liveInk?.pointerEventsNone === true
    && item?.hostPointerEventsNone === true
    && item?.sameCssRect === true
    && item?.insideChartRect === true
    && item?.plotSized === true
    && item?.exactAdapterPlotRect === true
    && item?.adapterDprMatches === true
    && item?.sceneCanaryPublicationActive === true
    && item?.dynamic?.dprSynchronized === true
    && item?.liveInk?.dprSynchronized === true;
  return {
    runId: run?.id ?? null,
    started: probe?.started === true,
    snapshots,
    passed: probe?.started === true
      && snapshots.length === 2
      && snapshots.every(snapshotPassed),
  };
}

function pointerMoveEvidence(run, minimumWindows) {
  const windows = Array.isArray(run?.phase5Probe?.pointerMoveWindows)
    ? run.phase5Probe.pointerMoveWindows
    : [];
  const validWindows = windows.filter((window) => (
    typeof window?.label === "string"
    && window.label.length > 0
    && safeCount(window?.observedFrameIntervals) !== null
    && window.observedFrameIntervals > 0
    && safeCount(window?.requestUpdateDelta) !== null
    && safeCount(window?.reactRenderDelta) !== null
    && safeCount(window?.sceneRebuildDelta) !== null
  ));
  return {
    runId: run?.id ?? null,
    minimumWindows,
    windows,
    passed: windows.length >= minimumWindows
      && validWindows.length === windows.length
      && validWindows.every((window) => (
        window.requestUpdateDelta === PHASE5_BUDGETS.pointerMoveRequestUpdateDelta
        && window.reactRenderDelta === PHASE5_BUDGETS.pointerMoveReactRenderDelta
        && window.sceneRebuildDelta === PHASE5_BUDGETS.pointerMoveSceneRebuildDelta
      )),
  };
}

function handoffEvidence(run, requiredKind) {
  const handoffs = Array.isArray(run?.phase5Probe?.handoffs)
    ? run.phase5Probe.handoffs.filter((handoff) => handoff?.kind === requiredKind)
    : [];
  return {
    runId: run?.id ?? null,
    requiredKind,
    handoffs,
    passed: handoffs.length > 0 && handoffs.every((handoff) => (
      handoff?.visibleBeforeCommit === true
      && handoff?.visibleImmediatelyAfterCommit === true
      && handoff?.exactTicketObserved === true
      && handoff?.exactAckBeforeClear === true
      && handoff?.paintAdvancedBeforeClear === true
      && handoff?.clearObserved === true
      && safeCount(handoff?.blankFrameCount) === 0
      && safeCount(handoff?.retainedFrameCount) !== null
      && handoff.retainedFrameCount >= 1
    )),
  };
}

function metricPercentileEvidence(scenario, metric, percentile, maximum) {
  const summary = scenario?.metrics?.[metric];
  const value = finiteNonNegative(summary?.[percentile]);
  const samples = safeCount(summary?.samples);
  return {
    scenarioId: scenario?.id ?? null,
    metric,
    percentile,
    maximum,
    value,
    samples,
    passed: value !== null && samples !== null && samples > 0 && value <= maximum,
  };
}

function metricEvidence(scenario, metric, maximum) {
  const evidence = metricPercentileEvidence(scenario, metric, "p95", maximum);
  return { ...evidence, p95: evidence.value };
}

function actionEvidenceForRun(scenarioId, run) {
  const action = run?.action ?? {};
  const restored = run?.restore?.passed === true
    && run?.restore?.runtimeSummaryMatchesSaved === true;
  if (scenarioId === PHASE5_SCENARIO_IDS.pen) {
    const opacity = finiteNonNegative(run?.phase5Probe?.liveInkOpacityObserved);
    const heavySummary = action.heavyFixtureSummaryAfterCancel;
    return {
      runId: run?.id ?? null,
      passed: restored
        && action.pointerSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT
        && action.heavyPointerSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT
        && action.committedPointerSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT
        && action.coalescedSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT - 1
        && action.committedCoalescedSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT - 1
        && Number(action.processedInputCount) >= 2 * (PHASE5_POINTER_SAMPLE_COUNT - 1)
        && action.heavyLiveInkVisibleBeforeCancel === true
        && action.heavyLiveInkVisibleAfterCancel === false
        && action.heavyFixturePreservedAfterCancel === true
        && heavySummary?.entityCount === 64
        && heavySummary?.pointCount === 32_768
        && heavySummary?.typeCounts?.freehand === 64
        && Object.keys(heavySummary?.typeCounts ?? {}).length === 1
        && action.fixtureClearedBeforeCommit === true
        && drawingTypeDelta(run, "freehand") === -63
        && Number(finalDrawingPointCount(run)) > 0
        && run?.phase5Probe?.liveInkEverVisible === true
        && opacity !== null
        && Math.abs(opacity - 1) <= 0.001
        && run?.phase5Probe?.liveInkBlendModeObserved === "normal",
    };
  }
  if (scenarioId === PHASE5_SCENARIO_IDS.highlighter) {
    const opacity = finiteNonNegative(run?.phase5Probe?.highlighterOpacityObserved);
    const heavySummary = action.heavyFixtureSummaryAfterCancel;
    return {
      runId: run?.id ?? null,
      passed: restored
        && action.pointerSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT
        && action.heavyPointerSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT
        && action.committedPointerSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT
        && action.coalescedSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT - 1
        && action.committedCoalescedSamplesDispatched === PHASE5_POINTER_SAMPLE_COUNT - 1
        && Number(action.processedInputCount) >= 2 * (PHASE5_POINTER_SAMPLE_COUNT - 1)
        && action.heavyLiveInkVisibleBeforeCancel === true
        && action.heavyLiveInkVisibleAfterCancel === false
        && action.heavyFixturePreservedAfterCancel === true
        && heavySummary?.entityCount === 64
        && heavySummary?.pointCount === 32_768
        && heavySummary?.typeCounts?.freehand === 64
        && Object.keys(heavySummary?.typeCounts ?? {}).length === 1
        && action.fixtureClearedBeforeCommit === true
        && drawingTypeDelta(run, "highlighter") === 1
        && drawingTypeDelta(run, "freehand") === -64
        && Number(finalDrawingPointCount(run)) > 0
        && run?.phase5Probe?.liveInkEverVisible === true
        && opacity !== null
        && Math.abs(opacity - 0.35) <= 0.01
        && run?.phase5Probe?.liveInkBlendModeObserved === "multiply",
    };
  }
  if (scenarioId === PHASE5_SCENARIO_IDS.dragResize) {
    return {
      runId: run?.id ?? null,
      passed: restored
        && action.twoPointCommits === 1
        && Number(action.dragMovesDispatched) > 0
        && Number(action.resizeMovesDispatched) > 0
        && action.dragPersistenceMatched === true
        && action.resizePersistenceMatched === true
        && action.dragGeometryMatched === true
        && action.resizeGeometryMatched === true
        && drawingTypeDelta(run, "line") === 1
        && run?.phase5Probe?.dynamicOverlayEverVisible === true,
    };
  }
  if (scenarioId === PHASE5_SCENARIO_IDS.twoPoint) {
    return {
      runId: run?.id ?? null,
      passed: restored
        && action.twoPointCommits === 1
        && action.twoPointCancels === 1
        && action.previewVisibleBeforeCancel === true
        && action.previewVisibleAfterCancel === false
        && action.savedCountAfterCancel === action.savedCountAfterCommit
        && drawingTypeDelta(run, "line") === 1
        && run?.phase5Probe?.dynamicOverlayEverVisible === true,
    };
  }
  if (scenarioId === PHASE5_SCENARIO_IDS.eraserCancel) {
    return {
      runId: run?.id ?? null,
      passed: restored
        && Number(action.eraserHoverEventsDispatched) > 0
        && Number(action.pointerCancelEventsDispatched) > 0
        && Number(action.windowBlurEventsDispatched) > 0
        && action.overlayVisibleBeforePointerCancel === true
        && action.pointerCancelOverlayCleared === true
        && action.overlayVisibleBeforeWindowBlur === true
        && action.windowBlurOverlayCleared === true
        && action.overlayVisibleBeforeEscape === true
        && action.escapeOverlayCleared === true
        && action.savedCountAfterCancel === action.savedCountBeforeCancel
        && drawingTypeDelta(run, "line") === 1
        && run?.phase5Probe?.dynamicOverlayEverVisible === true,
    };
  }
  return { runId: run?.id ?? null, passed: false };
}

export function buildPhase5Acceptance(report, args = {}) {
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];
  const byId = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  const missingRequiredScenarioIds = PHASE5_REQUIRED_SCENARIO_IDS
    .filter((id) => !byId.has(id));
  const requiredScenarios = PHASE5_REQUIRED_SCENARIO_IDS
    .map((id) => byId.get(id))
    .filter(Boolean);
  const measuredRunCoveragePassed = requiredScenarios.length === PHASE5_REQUIRED_SCENARIO_IDS.length
    && Number(args.runs) >= PHASE5_MIN_MEASURED_RUNS
    && requiredScenarios.every((scenario) => (
      Number(scenario?.repetitions?.measuredRuns) >= PHASE5_MIN_MEASURED_RUNS
      && measuredRuns(scenario).length >= PHASE5_MIN_MEASURED_RUNS
    ));
  const warmupCoveragePassed = requiredScenarios.length === PHASE5_REQUIRED_SCENARIO_IDS.length
    && Number(args.warmupRuns) >= PHASE5_MIN_WARMUP_RUNS
    && requiredScenarios.every((scenario) => (
      Number(scenario?.repetitions?.warmupRuns) >= PHASE5_MIN_WARMUP_RUNS
      && allRuns(scenario).filter((run) => run?.warmup === true).length
        >= PHASE5_MIN_WARMUP_RUNS
    ));
  const heavySceneFixtureEvidenceRuns = [
    byId.get(PHASE5_SCENARIO_IDS.pen),
    byId.get(PHASE5_SCENARIO_IDS.highlighter),
  ].filter(Boolean).map(heavySceneFixtureEvidence);
  const heavySceneFixturePassed = heavySceneFixtureEvidenceRuns.length === 2
    && heavySceneFixtureEvidenceRuns.every((item) => item.passed);

  const surfaceEvidenceRuns = requiredScenarios
    .flatMap((scenario) => allRuns(scenario).map(surfaceEvidence));
  const overlaySurfacePassed = surfaceEvidenceRuns.length > 0
    && surfaceEvidenceRuns.every((item) => item.passed);

  const pointerMoveEvidenceRuns = requiredScenarios.flatMap((scenario) => (
    measuredRuns(scenario).map((run) => pointerMoveEvidence(
      run,
      REQUIRED_POINTER_MOVE_WINDOWS[scenario.id] ?? 1,
    ))
  ));
  const pointerMoveIsolationPassed = pointerMoveEvidenceRuns.length > 0
    && pointerMoveEvidenceRuns.every((item) => item.passed);

  const handoffEvidenceRuns = requiredScenarios.flatMap((scenario) => {
    const requiredKind = REQUIRED_HANDOFF_KINDS[scenario.id];
    return requiredKind
      ? measuredRuns(scenario).map((run) => handoffEvidence(run, requiredKind))
      : [];
  });
  const blankHandoffPassed = handoffEvidenceRuns.length
    >= Object.keys(REQUIRED_HANDOFF_KINDS).length * PHASE5_MIN_MEASURED_RUNS
    && handoffEvidenceRuns.every((item) => item.passed);

  const actionEvidence = requiredScenarios.flatMap((scenario) => (
    measuredRuns(scenario).map((run) => ({
      scenarioId: scenario.id,
      ...actionEvidenceForRun(scenario.id, run),
    }))
  ));
  const actionCoveragePassed = actionEvidence.length
    >= PHASE5_REQUIRED_SCENARIO_IDS.length * PHASE5_MIN_MEASURED_RUNS
    && actionEvidence.every((item) => item.passed);

  const activeOverlayCpuEvidence = requiredScenarios.map((scenario) => metricEvidence(
    scenario,
    "activeOverlayCpuMs",
    PHASE5_BUDGETS.activeOverlayCpuP95Ms,
  ));
  const drawingMainThreadEvidence = requiredScenarios.map((scenario) => metricEvidence(
    scenario,
    "drawingMainThreadMs",
    PHASE5_BUDGETS.drawingMainThreadP95Ms,
  ));
  const mouseupSyncEvidence = requiredScenarios.map((scenario) => metricEvidence(
    scenario,
    "mouseupSyncMs",
    PHASE5_BUDGETS.mouseupSyncP95Ms,
  ));
  const activeOverlayCpuPassed = activeOverlayCpuEvidence.length
    === PHASE5_REQUIRED_SCENARIO_IDS.length
    && activeOverlayCpuEvidence.every((item) => item.passed);
  const drawingMainThreadPassed = drawingMainThreadEvidence.length
    === PHASE5_REQUIRED_SCENARIO_IDS.length
    && drawingMainThreadEvidence.every((item) => item.passed);
  const mouseupSyncPassed = mouseupSyncEvidence.length
    === PHASE5_REQUIRED_SCENARIO_IDS.length
    && mouseupSyncEvidence.every((item) => item.passed);
  const hardLatencySpecifications = [
    ["drawingMainThreadMs", "p95", PHASE5_BUDGETS.drawingMainThreadP95Ms],
    ["drawingMainThreadMs", "p99", PHASE5_BUDGETS.drawingMainThreadP99Ms],
    ["frameIntervalMs", "p95", PHASE5_BUDGETS.frameIntervalP95Ms],
    ["frameIntervalMs", "p99", PHASE5_BUDGETS.frameIntervalP99Ms],
    ["inputToNextPaintMs", "p95", PHASE5_BUDGETS.inputToNextPaintP95Ms],
    ["inputToNextPaintMs", "p99", PHASE5_BUDGETS.inputToNextPaintP99Ms],
    ["mouseupSyncMs", "p95", PHASE5_BUDGETS.mouseupSyncP95Ms],
    ["mouseupSyncMs", "p99", PHASE5_BUDGETS.mouseupSyncP99Ms],
  ];
  const hardLatencyEvidence = requiredScenarios.flatMap((scenario) => (
    hardLatencySpecifications.map(([metric, percentile, maximum]) => (
      metricPercentileEvidence(scenario, metric, percentile, maximum)
    ))
  ));
  const hardLatencyPassed = hardLatencyEvidence.length
    === PHASE5_REQUIRED_SCENARIO_IDS.length * hardLatencySpecifications.length
    && hardLatencyEvidence.every((item) => item.passed);

  const longTaskEvidence = requiredScenarios.map((scenario) => ({
    scenarioId: scenario.id,
    attributableCount: safeCount(scenario?.longTasks?.attributableCount),
    observerSupported: measuredRuns(scenario).length >= PHASE5_MIN_MEASURED_RUNS
      && measuredRuns(scenario).every((run) => run?.bench?.longTaskSupported === true),
  }));
  const attributableLongTaskPassed = longTaskEvidence.length
    === PHASE5_REQUIRED_SCENARIO_IDS.length
    && longTaskEvidence.every((item) => (
      item.observerSupported
      && item.attributableCount === PHASE5_BUDGETS.attributableLongTasksOver50Ms
    ));

  const engineModePassed = report?.configuration?.drawingEngineMode === "scene-canary"
    && report?.context?.mode === "scene-canary";
  const interactionSurfaceModePassed = report?.configuration?.drawingInteractionSurfaceMode
    === "overlay";
  const productionBuildPassed = report?.environment?.productionBuild === true
    && report?.environment?.productionBuildVerification === "managed-vite-preview";
  const executionPassed = report?.executionAcceptance?.passed === true;
  const phase5Eligible = args.smoke !== true && productionBuildPassed;
  const passed = phase5Eligible
    && engineModePassed
    && interactionSurfaceModePassed
    && missingRequiredScenarioIds.length === 0
    && measuredRunCoveragePassed
    && warmupCoveragePassed
    && heavySceneFixturePassed
    && executionPassed
    && overlaySurfacePassed
    && actionCoveragePassed
    && pointerMoveIsolationPassed
    && activeOverlayCpuPassed
    && drawingMainThreadPassed
    && mouseupSyncPassed
    && hardLatencyPassed
    && attributableLongTaskPassed
    && blankHandoffPassed;
  const failureReasons = [];
  if (args.smoke === true) failureReasons.push("smoke-only-run");
  if (!productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!engineModePassed) failureReasons.push("scene-canary-mode-not-selected");
  if (!interactionSurfaceModePassed) failureReasons.push("interaction-overlay-mode-not-selected");
  if (missingRequiredScenarioIds.length > 0) failureReasons.push("missing-required-scenarios");
  if (!measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!heavySceneFixturePassed) failureReasons.push("phase5-heavy-scene-fixture-invalid");
  if (!executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!overlaySurfacePassed) failureReasons.push("overlay-surface-contract-failed");
  if (!actionCoveragePassed) failureReasons.push("phase5-action-coverage-failed");
  if (!pointerMoveIsolationPassed) failureReasons.push("pointermove-chart-update-detected");
  if (!activeOverlayCpuPassed) failureReasons.push("active-overlay-cpu-p95-over-2ms");
  if (!drawingMainThreadPassed) failureReasons.push("drawing-main-p95-over-4ms");
  if (!mouseupSyncPassed) failureReasons.push("mouseup-p95-over-8ms");
  if (!hardLatencyPassed) failureReasons.push("phase5-hard-latency-gate-failed");
  if (!attributableLongTaskPassed) failureReasons.push("drawing-attributed-long-task-over-50ms");
  if (!blankHandoffPassed) failureReasons.push("blank-or-unverified-handoff");

  return {
    passed,
    phase5Eligible,
    productionBuildPassed,
    engineModePassed,
    interactionSurfaceModePassed,
    requiredScenarioIds: [...PHASE5_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds,
    minimumMeasuredRuns: PHASE5_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE5_MIN_WARMUP_RUNS,
    warmupCoveragePassed,
    heavySceneFixturePassed,
    heavySceneFixtureEvidenceRuns,
    executionPassed,
    budgets: { ...PHASE5_BUDGETS },
    overlaySurfacePassed,
    surfaceEvidenceRuns,
    actionCoveragePassed,
    actionEvidence,
    pointerMoveIsolationPassed,
    pointerMoveEvidenceRuns,
    activeOverlayCpuPassed,
    activeOverlayCpuEvidence,
    drawingMainThreadPassed,
    drawingMainThreadEvidence,
    mouseupSyncPassed,
    mouseupSyncEvidence,
    hardLatencyPassed,
    hardLatencyEvidence,
    attributableLongTaskPassed,
    longTaskEvidence,
    blankHandoffPassed,
    handoffEvidenceRuns,
    failureReasons,
  };
}
