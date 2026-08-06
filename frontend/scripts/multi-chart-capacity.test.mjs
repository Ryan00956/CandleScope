import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPACITY_SCHEMA_VERSION,
  buildWorkspaceBootstrap,
  evaluateCapacityResult,
  parseArgs,
  validateCapacityEvidence,
} from "./multi-chart-capacity.mjs";


test("capacity CLI accepts only the frozen 1/2/4/8/16 and S1-S5 matrix", () => {
  assert.equal(parseArgs(["--cells", "16", "--scenario", "s5", "--duration-ms", "1000"]).cells, 16);
  assert.equal(parseArgs(["--cells", "16", "--scenario", "s5", "--duration-ms", "1000"]).scenario, "S5");
  assert.throws(() => parseArgs(["--cells", "3"]), /must be one of/);
  assert.throws(() => parseArgs(["--scenario", "W3"]), /must be one of/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("phase 0 bootstrap produces exact 1, 2, and 4-cell trees without changing schema v5", () => {
  for (const cells of [1, 2, 4]) {
    const bootstrap = buildWorkspaceBootstrap({ cells, scenario: "S1", now: 100 });
    assert.equal(bootstrap.record.document.schemaVersion, 5);
    assert.equal(bootstrap.record.document.layoutLocked, true);
    assert.equal(bootstrap.expectedSeries.length, 1);
    const serialized = JSON.stringify(bootstrap.record.document.layoutTree);
    for (let index = 1; index <= cells; index += 1) assert.match(serialized, new RegExp(`cell-${index}`));
    for (let index = cells + 1; index <= 4; index += 1) assert.doesNotMatch(serialized, new RegExp(`cell-${index}`));
  }
  assert.throws(() => buildWorkspaceBootstrap({ cells: 8, scenario: "S1" }), /cannot represent 8/);
});

test("S2 and S3 scenarios freeze unique series independently from logical cells", () => {
  assert.deepEqual(buildWorkspaceBootstrap({ cells: 4, scenario: "S2" }).expectedSeries, [
    "BTCUSDT@15m", "BTCUSDT@1h", "BTCUSDT@1m", "BTCUSDT@5m",
  ]);
  assert.deepEqual(buildWorkspaceBootstrap({ cells: 4, scenario: "S3" }).expectedSeries, [
    "BNBUSDT@1m", "BTCUSDT@1m", "ETHUSDT@1m", "SOLUSDT@1m",
  ]);
});

test("gate evaluation computes pass, fail, and unsupported instead of trusting a caller result", () => {
  const base = {
    supported: true,
    requestedCells: 2,
    readiness: { ready: true, visibleCells: 2 },
    errors: { console: [], exceptions: [], network: [] },
    backendAfter: { ok: true, schemaVersion: "candlescope.backend.capacity/1" },
    mapping: { observedSeries: 1, expectedSeries: 1, duplicateSeries: [] },
    canvasRemounts: 0,
  };
  assert.equal(evaluateCapacityResult(base).result, "pass");
  assert.equal(evaluateCapacityResult({ ...base, canvasRemounts: 1 }).result, "fail");
  assert.equal(evaluateCapacityResult({ supported: false, requestedCells: 8 }).result, "unsupported");
});

test("capacity evidence validator enforces the stable top-level schema", () => {
  const evidence = {
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    generatedAt: "2026-08-06T00:00:00.000Z",
    git: { commit: "abc", dirty: true },
    hardware: { profileSha256: `sha256:${"a".repeat(64)}` },
    scenario: { id: "S1", windows: 1, cells: 1 },
    data: {},
    frontend: {}, backend: {}, upstream: {}, gates: {}, result: "pass",
  };
  assert.deepEqual(validateCapacityEvidence(evidence), []);
  assert.match(validateCapacityEvidence({ ...evidence, result: "maybe" }).join(" "), /result/);
  assert.match(validateCapacityEvidence({ ...evidence, data: null }).join(" "), /data/);
  assert.match(validateCapacityEvidence({ ...evidence, hardware: { profileSha256: "sha256:abc" } }).join(" "), /hardware/);
});
