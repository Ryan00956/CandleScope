import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_CROSSHAIR_MOVE_COUNT,
  PHASE4_SCENARIO_IDS,
  buildPhase4Acceptance,
  phase4OwnershipFromTypeCounts,
} from "./drawing-performance-phase4.mjs";

function runtimeSummary(typeCounts, attachedPrimitiveCount) {
  return {
    entityCount: Object.values(typeCounts).reduce((total, count) => total + count, 0),
    pointCount: 0,
    typeCounts,
    ...(attachedPrimitiveCount === undefined ? {} : { attachedPrimitiveCount }),
  };
}

function run(id, typeCounts, attachedPrimitiveCount, { warmup = false, crosshair = false } = {}) {
  const summary = runtimeSummary(typeCounts, attachedPrimitiveCount);
  return {
    id,
    warmup,
    fixture: { drawingCount: summary.entityCount, drawingTypes: typeCounts },
    initialRuntimeSummary: structuredClone(summary),
    runtimeSummary: structuredClone(summary),
    restore: { runtimeSummaryAfterReload: structuredClone(summary) },
    action: {
      crosshairMovesDispatched: crosshair ? PHASE4_CROSSHAIR_MOVE_COUNT : 0,
    },
    phase4Probe: {
      started: true,
      observedFrameIntervals: 8,
      maxRequestUpdatesPerFrame: 1,
      maxSceneRebuildsPerFrame: crosshair ? 0 : 1,
      totalRequestUpdates: 3,
      totalSceneRebuilds: crosshair ? 0 : 2,
      totalFinalProjections: crosshair ? 0 : 2,
    },
    counters: {
      requestUpdatePerFrame: 1,
      sceneRebuildCount: crosshair ? 0 : 2,
      staticProjectionCount: crosshair ? 0 : 2,
      surfacePrimitiveCount: attachedPrimitiveCount,
    },
  };
}

function scenario(id, typeCounts, attachedPrimitiveCount, options = {}) {
  return {
    id,
    repetitions: { measuredRuns: 5, warmupRuns: 1 },
    rawRuns: Array.from({ length: 6 }, (_, index) => run(
      `${id}-${index + 1}`,
      typeCounts,
      attachedPrimitiveCount,
      { ...options, warmup: index === 0 },
    )),
  };
}

function passingReport() {
  const migratedTypes = { line: 22, "axis-line": 21, shape: 21 };
  return {
    context: { mode: "scene-canary" },
    configuration: { drawingEngineMode: "scene-canary" },
    environment: {
      productionBuild: true,
      productionBuildVerification: "managed-vite-preview",
    },
    executionAcceptance: { passed: true },
    scenarios: [
      scenario(PHASE4_SCENARIO_IDS.migrated, migratedTypes, 1),
      scenario(
        PHASE4_SCENARIO_IDS.mixed,
        { line: 11, "axis-line": 11, shape: 10, freehand: 32 },
        33,
      ),
      scenario(PHASE4_SCENARIO_IDS.crosshair, migratedTypes, 1, { crosshair: true }),
      scenario(PHASE4_SCENARIO_IDS.freehand, { freehand: 64 }, 65),
    ],
  };
}

test("ownership derives scene-canary attachment count from types, not entity count", () => {
  assert.deepEqual(phase4OwnershipFromTypeCounts({
    line: 4,
    "axis-line": 3,
    shape: 2,
    freehand: 5,
    text: 1,
  }), {
    sceneDrawingCount: 9,
    legacyDrawingCount: 6,
    drawingCount: 15,
    expectedAttachedPrimitiveCount: 7,
  });
  assert.equal(phase4OwnershipFromTypeCounts({ line: -1 }), null);
});

test("formal phase4 acceptance covers attachments, crosshair, viewport, and freehand fanout", () => {
  const acceptance = buildPhase4Acceptance(passingReport(), {
    runs: 5,
    warmupRuns: 1,
    smoke: false,
  });

  assert.equal(acceptance.passed, true);
  assert.equal(acceptance.migratedFixturePassed, true);
  assert.equal(acceptance.mixedFixturePassed, true);
  assert.equal(acceptance.crosshairRebuildPassed, true);
  assert.equal(acceptance.viewportRequestUpdatePassed, true);
  assert.equal(acceptance.freehandViewUpdateFanoutPassed, true);
});

test("attachment evidence fails closed instead of substituting matching entityCount", () => {
  const report = passingReport();
  const mixed = report.scenarios.find((item) => item.id === PHASE4_SCENARIO_IDS.mixed);
  delete mixed.rawRuns[1].runtimeSummary.attachedPrimitiveCount;

  const acceptance = buildPhase4Acceptance(report, { runs: 5, warmupRuns: 1 });
  assert.equal(acceptance.passed, false);
  assert.equal(acceptance.mixedFixturePassed, false);
  assert.ok(acceptance.failureReasons.includes("mixed-fixture-attachment-count-failed"));
});

test("crosshair rebuilds and per-frame update bursts fail their independent gates", () => {
  const report = passingReport();
  const crosshair = report.scenarios.find((item) => item.id === PHASE4_SCENARIO_IDS.crosshair);
  crosshair.rawRuns[1].phase4Probe.totalSceneRebuilds = 1;
  crosshair.rawRuns[1].counters.sceneRebuildCount = 1;
  const viewport = report.scenarios.find((item) => item.id === PHASE4_SCENARIO_IDS.migrated);
  viewport.rawRuns[1].phase4Probe.maxRequestUpdatesPerFrame = 2;
  viewport.rawRuns[1].counters.requestUpdatePerFrame = 2;

  const acceptance = buildPhase4Acceptance(report, { runs: 5, warmupRuns: 1 });
  assert.equal(acceptance.crosshairRebuildPassed, false);
  assert.equal(acceptance.viewportRequestUpdatePassed, false);
  assert.equal(acceptance.passed, false);
});

test("64-freehand gate rejects a 64-request burst in one frame", () => {
  const report = passingReport();
  const freehand = report.scenarios.find((item) => item.id === PHASE4_SCENARIO_IDS.freehand);
  freehand.rawRuns[1].phase4Probe.totalRequestUpdates = 64;
  freehand.rawRuns[1].phase4Probe.maxRequestUpdatesPerFrame = 64;
  freehand.rawRuns[1].counters.requestUpdatePerFrame = 64;

  const acceptance = buildPhase4Acceptance(report, { runs: 5, warmupRuns: 1 });
  assert.equal(acceptance.freehandViewUpdateFanoutPassed, false);
  assert.ok(acceptance.failureReasons.includes("freehand-view-update-fanout-detected"));
});

test("64-freehand gate observes legacy updateAllViews through scene rebuild fanout", () => {
  const report = passingReport();
  const freehand = report.scenarios.find((item) => item.id === PHASE4_SCENARIO_IDS.freehand);
  freehand.rawRuns[1].phase4Probe.totalRequestUpdates = 0;
  freehand.rawRuns[1].phase4Probe.maxRequestUpdatesPerFrame = 0;
  freehand.rawRuns[1].counters.requestUpdatePerFrame = 0;
  freehand.rawRuns[1].phase4Probe.totalSceneRebuilds = 64;
  freehand.rawRuns[1].phase4Probe.maxSceneRebuildsPerFrame = 64;

  const acceptance = buildPhase4Acceptance(report, { runs: 5, warmupRuns: 1 });
  assert.equal(acceptance.freehandViewUpdateFanoutPassed, false);
  assert.ok(acceptance.failureReasons.includes("freehand-view-update-fanout-detected"));
});
