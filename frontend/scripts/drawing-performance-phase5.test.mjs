import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE5_BUDGETS,
  PHASE5_POINTER_SAMPLE_COUNT,
  PHASE5_SCENARIO_IDS,
  buildPhase5Acceptance,
} from "./drawing-performance-phase5.mjs";

function surface() {
  const canvas = {
    present: true,
    pointerEventsNone: true,
    dprSynchronized: true,
  };
  return {
    overlayCount: 2,
    dynamic: { ...canvas },
    liveInk: { ...canvas },
    hostPointerEventsNone: true,
    sameCssRect: true,
    insideChartRect: true,
    plotSized: true,
    exactAdapterPlotRect: true,
    adapterDprMatches: true,
    sceneCanaryPublicationActive: true,
  };
}

function scenarioKind(id) {
  if (id === PHASE5_SCENARIO_IDS.pen) return "freehand";
  if (id === PHASE5_SCENARIO_IDS.highlighter) return "highlighter";
  return "line";
}

function actionFor(id) {
  if (id === PHASE5_SCENARIO_IDS.pen || id === PHASE5_SCENARIO_IDS.highlighter) {
    return {
      pointerSamplesDispatched: PHASE5_POINTER_SAMPLE_COUNT,
      heavyPointerSamplesDispatched: PHASE5_POINTER_SAMPLE_COUNT,
      committedPointerSamplesDispatched: PHASE5_POINTER_SAMPLE_COUNT,
      coalescedSamplesDispatched: PHASE5_POINTER_SAMPLE_COUNT - 1,
      committedCoalescedSamplesDispatched: PHASE5_POINTER_SAMPLE_COUNT - 1,
      processedInputCount: 2 * (PHASE5_POINTER_SAMPLE_COUNT - 1),
      heavyLiveInkVisibleBeforeCancel: true,
      heavyLiveInkVisibleAfterCancel: false,
      heavyFixtureSummaryAfterCancel: {
        entityCount: 64,
        pointCount: 32_768,
        typeCounts: { freehand: 64 },
      },
      heavyFixturePreservedAfterCancel: true,
      fixtureClearedBeforeCommit: true,
    };
  }
  if (id === PHASE5_SCENARIO_IDS.dragResize) {
    return {
      twoPointCommits: 1,
      dragMovesDispatched: 24,
      resizeMovesDispatched: 24,
      dragPersistenceMatched: true,
      resizePersistenceMatched: true,
      dragGeometryMatched: true,
      resizeGeometryMatched: true,
    };
  }
  if (id === PHASE5_SCENARIO_IDS.twoPoint) {
    return {
      twoPointCommits: 1,
      twoPointCancels: 1,
      previewVisibleBeforeCancel: true,
      previewVisibleAfterCancel: false,
      savedCountAfterCommit: 1,
      savedCountAfterCancel: 1,
    };
  }
  return {
    eraserHoverEventsDispatched: 120,
    pointerCancelEventsDispatched: 1,
    windowBlurEventsDispatched: 1,
    overlayVisibleBeforePointerCancel: true,
    pointerCancelOverlayCleared: true,
    overlayVisibleBeforeWindowBlur: true,
    windowBlurOverlayCleared: true,
    overlayVisibleBeforeEscape: true,
    escapeOverlayCleared: true,
    savedCountBeforeCancel: 1,
    savedCountAfterCancel: 1,
  };
}

function pointerMoveWindows(id) {
  const count = id === PHASE5_SCENARIO_IDS.dragResize
    || id === PHASE5_SCENARIO_IDS.pen
    || id === PHASE5_SCENARIO_IDS.highlighter
    ? 2
    : 1;
  return Array.from({ length: count }, (_, index) => ({
    label: `${id}-${index}`,
    observedFrameIntervals: 3,
    requestUpdateDelta: 0,
    reactRenderDelta: 0,
    sceneRebuildDelta: 0,
  }));
}

function handoffs(id) {
  let kind = null;
  if (id === PHASE5_SCENARIO_IDS.pen || id === PHASE5_SCENARIO_IDS.highlighter) {
    kind = "live-ink";
  } else if (id === PHASE5_SCENARIO_IDS.dragResize || id === PHASE5_SCENARIO_IDS.twoPoint) {
    kind = "dynamic";
  }
  return kind ? [{
    kind,
    visibleBeforeCommit: true,
    visibleImmediatelyAfterCommit: true,
    exactTicketObserved: true,
    exactAckBeforeClear: true,
    paintAdvancedBeforeClear: true,
    clearObserved: true,
    blankFrameCount: 0,
    retainedFrameCount: 2,
  }] : [];
}

function run(id, iteration, warmup = false) {
  const kind = scenarioKind(id);
  const heavyScene = id === PHASE5_SCENARIO_IDS.pen
    || id === PHASE5_SCENARIO_IDS.highlighter;
  const initialPointCount = heavyScene ? 32_768 : 0;
  const initialTypeCounts = heavyScene ? { freehand: 64 } : {};
  const finalTypeCounts = { [kind]: 1 };
  const pointDelta = kind === "freehand" || kind === "highlighter"
    ? PHASE5_POINTER_SAMPLE_COUNT
    : 2;
  return {
    id: `${id}-${iteration}`,
    warmup,
    initialSavedSummary: { pointCount: initialPointCount, typeCounts: initialTypeCounts },
    restore: {
      passed: true,
      runtimeSummaryMatchesSaved: true,
      savedSummaryBeforeReload: {
        pointCount: pointDelta,
        typeCounts: finalTypeCounts,
      },
    },
    action: actionFor(id),
    bench: { longTaskSupported: true },
    phase5Probe: {
      started: true,
      initialSurface: surface(),
      surface: surface(),
      pointerMoveWindows: pointerMoveWindows(id),
      handoffs: handoffs(id),
      liveInkEverVisible: id === PHASE5_SCENARIO_IDS.pen
        || id === PHASE5_SCENARIO_IDS.highlighter,
      dynamicOverlayEverVisible: id !== PHASE5_SCENARIO_IDS.pen
        && id !== PHASE5_SCENARIO_IDS.highlighter,
      highlighterOpacityObserved: id === PHASE5_SCENARIO_IDS.highlighter ? 0.35 : null,
      liveInkOpacityObserved: id === PHASE5_SCENARIO_IDS.highlighter ? 0.35 : 1,
      liveInkBlendModeObserved: id === PHASE5_SCENARIO_IDS.highlighter
        ? "multiply"
        : "normal",
    },
  };
}

function scenario(id) {
  const heavyScene = id === PHASE5_SCENARIO_IDS.pen
    || id === PHASE5_SCENARIO_IDS.highlighter;
  return {
    id,
    fixture: {
      entities: heavyScene ? 64 : 0,
      points: heavyScene ? 32_768 : 0,
      dpr: 1.5,
    },
    repetitions: { measuredRuns: 5, warmupRuns: 1 },
    rawRuns: Array.from({ length: 6 }, (_, index) => run(id, index + 1, index === 0)),
    metrics: {
      activeOverlayCpuMs: { p95: PHASE5_BUDGETS.activeOverlayCpuP95Ms, samples: 25 },
      drawingMainThreadMs: {
        p95: PHASE5_BUDGETS.drawingMainThreadP95Ms,
        p99: PHASE5_BUDGETS.drawingMainThreadP99Ms,
        samples: 25,
      },
      frameIntervalMs: {
        p95: PHASE5_BUDGETS.frameIntervalP95Ms,
        p99: PHASE5_BUDGETS.frameIntervalP99Ms,
        samples: 25,
      },
      inputToNextPaintMs: {
        p95: PHASE5_BUDGETS.inputToNextPaintP95Ms,
        p99: PHASE5_BUDGETS.inputToNextPaintP99Ms,
        samples: 25,
      },
      mouseupSyncMs: {
        p95: PHASE5_BUDGETS.mouseupSyncP95Ms,
        p99: PHASE5_BUDGETS.mouseupSyncP99Ms,
        samples: 25,
      },
    },
    longTasks: { attributableCount: 0 },
  };
}

function passingReport() {
  return {
    context: { mode: "scene-canary" },
    configuration: {
      drawingEngineMode: "scene-canary",
      drawingInteractionSurfaceMode: "overlay",
    },
    environment: {
      productionBuild: true,
      productionBuildVerification: "managed-vite-preview",
    },
    executionAcceptance: { passed: true },
    scenarios: Object.values(PHASE5_SCENARIO_IDS).map(scenario),
  };
}

function acceptance(report = passingReport()) {
  return buildPhase5Acceptance(report, { runs: 5, warmupRuns: 1, smoke: false });
}

test("formal phase5 acceptance covers every interaction scenario and hard budget", () => {
  const result = acceptance();
  assert.equal(result.passed, true);
  assert.equal(result.overlaySurfacePassed, true);
  assert.equal(result.actionCoveragePassed, true);
  assert.equal(result.pointerMoveIsolationPassed, true);
  assert.equal(result.activeOverlayCpuPassed, true);
  assert.equal(result.drawingMainThreadPassed, true);
  assert.equal(result.mouseupSyncPassed, true);
  assert.equal(result.hardLatencyPassed, true);
  assert.equal(result.attributableLongTaskPassed, true);
  assert.equal(result.blankHandoffPassed, true);
});

test("phase5 hard latency gates reject p99, frame, and input-to-paint regressions", () => {
  const report = passingReport();
  report.scenarios[0].metrics.drawingMainThreadMs.p99 = 8.001;
  report.scenarios[1].metrics.frameIntervalMs.p95 = 20.001;
  report.scenarios[2].metrics.inputToNextPaintMs.p99 = 33.001;
  report.scenarios[3].metrics.mouseupSyncMs.p99 = 16.001;
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.hardLatencyPassed, false);
  assert.ok(result.failureReasons.includes("phase5-hard-latency-gate-failed"));
});

test("phase5 metric gates fail closed for missing samples and over-budget p95", () => {
  const report = passingReport();
  report.scenarios[0].metrics.activeOverlayCpuMs.samples = 0;
  report.scenarios[1].metrics.drawingMainThreadMs.p95 = 4.001;
  report.scenarios[2].metrics.mouseupSyncMs.p95 = 8.001;
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.activeOverlayCpuPassed, false);
  assert.equal(result.drawingMainThreadPassed, false);
  assert.equal(result.mouseupSyncPassed, false);
});

test("pointermove requestUpdate and scene rebuild deltas are independent zero gates", () => {
  const report = passingReport();
  report.scenarios[0].rawRuns[1].phase5Probe.pointerMoveWindows[0].requestUpdateDelta = 1;
  report.scenarios[2].rawRuns[1].phase5Probe.pointerMoveWindows[1].sceneRebuildDelta = 1;
  const result = acceptance(report);
  assert.equal(result.pointerMoveIsolationPassed, false);
  assert.ok(result.failureReasons.includes("pointermove-chart-update-detected"));
});

test("handoff gate rejects early clear, stale paint, and an unobserved final overlay", () => {
  const report = passingReport();
  const pen = report.scenarios.find((item) => item.id === PHASE5_SCENARIO_IDS.pen);
  pen.rawRuns[1].phase5Probe.handoffs[0].paintAdvancedBeforeClear = false;
  pen.rawRuns[2].phase5Probe.handoffs[0].blankFrameCount = 1;
  pen.rawRuns[3].phase5Probe.handoffs[0].visibleImmediatelyAfterCommit = false;
  const result = acceptance(report);
  assert.equal(result.blankHandoffPassed, false);
  assert.ok(result.failureReasons.includes("blank-or-unverified-handoff"));
});

test("4096 sample and highlighter whole-canvas opacity evidence cannot be inferred", () => {
  const report = passingReport();
  const pen = report.scenarios.find((item) => item.id === PHASE5_SCENARIO_IDS.pen);
  const highlighter = report.scenarios.find(
    (item) => item.id === PHASE5_SCENARIO_IDS.highlighter,
  );
  pen.rawRuns[1].action.pointerSamplesDispatched = 4_095;
  highlighter.rawRuns[1].phase5Probe.highlighterOpacityObserved = 1;
  const result = acceptance(report);
  assert.equal(result.actionCoveragePassed, false);
  assert.ok(result.failureReasons.includes("phase5-action-coverage-failed"));
});

test("overlay surface and Long Task observer evidence fail closed", () => {
  const report = passingReport();
  report.scenarios[0].rawRuns[0].phase5Probe.initialSurface.liveInk.dprSynchronized = false;
  report.scenarios[1].rawRuns[1].bench.longTaskSupported = false;
  report.scenarios[2].longTasks.attributableCount = 1;
  const result = acceptance(report);
  assert.equal(result.overlaySurfacePassed, false);
  assert.equal(result.attributableLongTaskPassed, false);
  assert.ok(result.failureReasons.includes("overlay-surface-contract-failed"));
  assert.ok(result.failureReasons.includes("drawing-attributed-long-task-over-50ms"));
});

test("phase5 formal eligibility requires managed scene-canary overlay build and 5+1 runs", () => {
  const report = passingReport();
  report.configuration.drawingInteractionSurfaceMode = "legacy";
  const result = buildPhase5Acceptance(report, { runs: 4, warmupRuns: 0, smoke: false });
  assert.equal(result.passed, false);
  assert.equal(result.interactionSurfaceModePassed, false);
  assert.equal(result.measuredRunCoveragePassed, false);
  assert.equal(result.warmupCoveragePassed, false);
});

test("phase5 pen and highlighter require the fixed 64 by 512 heavy scene", () => {
  const report = passingReport();
  report.scenarios[0].fixture.points = 0;
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.heavySceneFixturePassed, false);
  assert.ok(result.failureReasons.includes("phase5-heavy-scene-fixture-invalid"));
});

test("phase5 warmup coverage requires an actual raw warmup run", () => {
  const report = passingReport();
  report.scenarios[0].rawRuns = report.scenarios[0].rawRuns.filter((run) => !run.warmup);
  const result = acceptance(report);
  assert.equal(result.passed, false);
  assert.equal(result.warmupCoveragePassed, false);
  assert.ok(result.failureReasons.includes("warmup-runs-below-one"));
});

test("phase5 accepts more than the minimum measured repetitions", () => {
  const report = passingReport();
  for (const item of report.scenarios) {
    item.rawRuns.push(run(item.id, 7));
    item.repetitions.measuredRuns = 6;
  }
  const result = buildPhase5Acceptance(
    report,
    { runs: 6, warmupRuns: 1, smoke: false },
  );
  assert.equal(result.measuredRunCoveragePassed, true);
  assert.equal(result.actionCoveragePassed, true);
  assert.equal(result.blankHandoffPassed, true);
  assert.equal(result.passed, true);
});

test("phase5 requires distinct initial/final surfaces and rejects malformed pointer windows", () => {
  const report = passingReport();
  delete report.scenarios[0].rawRuns[0].phase5Probe.initialSurface;
  report.scenarios[1].rawRuns[1].phase5Probe.pointerMoveWindows.push({
    label: "missing-counter-evidence",
    observedFrameIntervals: 2,
    requestUpdateDelta: null,
    sceneRebuildDelta: null,
  });
  const result = acceptance(report);
  assert.equal(result.overlaySurfacePassed, false);
  assert.equal(result.pointerMoveIsolationPassed, false);
});

test("phase5 pointermove and handoff gates require React isolation and exact tickets", () => {
  const report = passingReport();
  report.scenarios[0].rawRuns[1].phase5Probe.pointerMoveWindows[0].reactRenderDelta = 1;
  report.scenarios[1].rawRuns[1].phase5Probe.handoffs[0].exactTicketObserved = false;
  report.scenarios[2].rawRuns[1].phase5Probe.handoffs[0].exactAckBeforeClear = false;
  const result = acceptance(report);
  assert.equal(result.pointerMoveIsolationPassed, false);
  assert.equal(result.blankHandoffPassed, false);
  assert.equal(result.passed, false);
});

test("phase5 freehand gates require an unchanged heavy fixture and both pointer windows", () => {
  const report = passingReport();
  report.scenarios[0].rawRuns[1].action.heavyFixtureSummaryAfterCancel.pointCount = 32_767;
  report.scenarios[1].rawRuns[1].phase5Probe.pointerMoveWindows.pop();
  const result = acceptance(report);
  assert.equal(result.actionCoveragePassed, false);
  assert.equal(result.pointerMoveIsolationPassed, false);
  assert.equal(result.passed, false);
});
