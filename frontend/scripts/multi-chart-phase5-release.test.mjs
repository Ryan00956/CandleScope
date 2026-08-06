import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE5_SCENARIOS,
  evaluatePhase5Release,
} from "./multi-chart-phase5-release.mjs";

function capacity(scenarioId, databaseState = "warm") {
  return {
    schemaVersion: "candlescope.multi-chart.capacity/1",
    generatedAt: "2026-08-06T00:00:00.000Z",
    git: { commit: "test", dirty: true },
    hardware: { profileSha256: `sha256:${"0".repeat(64)}` },
    scenario: { id: scenarioId, cells: 16, windows: 1 },
    data: { databaseState },
    backend: {
      before: { database: { state: databaseState } },
    },
    frontend: {},
    upstream: {},
    result: "pass",
    gates: {},
  };
}

function releaseInput() {
  return {
    matrix: Object.fromEntries(PHASE5_SCENARIOS.map((scenarioId) => [
      scenarioId,
      capacity(scenarioId, scenarioId === "C1" ? "empty" : "warm"),
    ])),
    hotReady: {
      result: "pass",
      scenario: { runs: 20 },
      checks: { hotReadyP95: { passed: true } },
    },
    soak: {
      scenario: { durationMs: 3_600_000 },
      gates: {
        hotReadyP95: { passed: false },
        inputResponseP95: { passed: true },
        longSoakHeapGrowth: { passed: true },
      },
    },
    rollback: {
      result: "pass",
      checks: {
        visibleCells: { passed: true },
        v6DocumentPreserved: { passed: true },
        defaultFlagsDisabled: { passed: true },
      },
    },
  };
}

test("phase 5 release replaces only the soak hot-ready sample with an independent p95", () => {
  const result = evaluatePhase5Release(releaseInput());
  assert.equal(result.result, "pass");
  assert.deepEqual(result.nonReadinessSoakFailures, []);
});

test("phase 5 release fails closed for a non-readiness soak failure", () => {
  const input = releaseInput();
  input.soak.gates.backendEventLoopLagP99 = { passed: false };
  const result = evaluatePhase5Release(input);
  assert.equal(result.result, "fail");
  assert.deepEqual(result.nonReadinessSoakFailures, ["backendEventLoopLagP99"]);
});

test("phase 5 release requires true-empty C1 and a preserving default-off rollback", () => {
  const input = releaseInput();
  input.matrix.C1.data.databaseState = "warm";
  input.matrix.C1.backend.before.database.state = "warm";
  input.rollback.checks.v6DocumentPreserved.passed = false;
  const result = evaluatePhase5Release(input);
  assert.equal(result.result, "fail");
  assert.equal(result.checks.scenarioMatrix.passed, false);
  assert.equal(result.checks.flagRollback.passed, false);
});
