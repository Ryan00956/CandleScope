import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateHotReadySamples,
  isBackendDrained,
  REQUIRED_HOT_BASELINE_GATES,
} from "./multi-chart-hot-ready-baseline.mjs";

function evidence(readyMs, failedGate = null) {
  return {
    schemaVersion: "candlescope.multi-chart.capacity/1",
    generatedAt: "2026-08-06T00:00:00.000Z",
    git: { commit: "abc", dirty: true },
    hardware: { profileSha256: `sha256:${"a".repeat(64)}` },
    scenario: { id: "S4", windows: 1, cells: 16 },
    data: {},
    frontend: { readiness: { navigationToReadyMs: readyMs } },
    backend: {},
    upstream: {},
    gates: {
      ...Object.fromEntries(REQUIRED_HOT_BASELINE_GATES.map((name) => [name, {
        passed: failedGate !== name,
      }])),
      hotReadyP95: { passed: readyMs <= 3_000 },
    },
    result: readyMs <= 3_000 && failedGate === null ? "pass" : "fail",
  };
}

test("independent hot readiness aggregate uses p95 and permits only one high outlier in twenty", () => {
  const oneOutlier = Array.from({ length: 20 }, (_, index) => evidence(index === 19 ? 3_052 : 1_500));
  assert.equal(evaluateHotReadySamples(oneOutlier, 20).result, "pass");
  assert.equal(evaluateHotReadySamples(oneOutlier, 20).p95Ms, 1_500);

  const twoOutliers = Array.from({ length: 20 }, (_, index) => evidence(index >= 18 ? 3_052 : 1_500));
  assert.equal(evaluateHotReadySamples(twoOutliers, 20).result, "fail");
  assert.equal(evaluateHotReadySamples(twoOutliers, 20).p95Ms, 3_052);
});

test("aggregate rejects a non-readiness failure even when p95 is fast", () => {
  const evidences = Array.from({ length: 20 }, () => evidence(1_500));
  evidences[4] = evidence(1_500, "visibleCells");
  const result = evaluateHotReadySamples(evidences, 20);
  assert.equal(result.result, "fail");
  assert.deepEqual(result.invalidRuns[0].nonReadinessFailures, ["visibleCells"]);
});

test("independent process isolation waits for backend leases and logical subscriptions to drain", () => {
  assert.equal(isBackendDrained({
    dataManager: { streamLeases: 0 },
    klineBatch: { logical_clients: 0, logical_subscriptions: 0 },
  }), true);
  assert.equal(isBackendDrained({
    dataManager: { streamLeases: 1 },
    klineBatch: { logical_clients: 0, logical_subscriptions: 0 },
  }), false);
});
