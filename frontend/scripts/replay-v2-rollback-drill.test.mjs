import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBackendLaunch,
  buildBackendPythonPath,
} from "./replay-v2-rollback-drill.mjs";

test("rollback current backend loads the bundled plugin SDK source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-rollback-path-"));
  try {
    const backend = path.join(root, "backend");
    const sdk = path.join(
      root,
      "packages",
      "candlescope-plugin-sdk",
      "src",
    );
    fs.mkdirSync(backend, { recursive: true });
    fs.mkdirSync(sdk, { recursive: true });
    assert.equal(
      buildBackendPythonPath({
        root: backend,
        baseline: false,
        inherited: "inherited-python-path",
      }),
      [sdk, "inherited-python-path"].join(path.delimiter),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rollback baseline backend remains isolated from current SDK sources", () => {
  const baselineRoot = path.join("isolated", "baseline", "backend");
  assert.equal(
    buildBackendPythonPath({
      root: baselineRoot,
      baseline: true,
      inherited: "current-sdk-source",
    }),
    baselineRoot,
  );
});

test("rollback enables exact HEDGE inputs only for the current enabled build", () => {
  const current = buildBackendLaunch({
    port: 18080,
    baseline: false,
    enabled: true,
  });
  assert.equal(current.historicalBookEnabled, true);
  assert.deepEqual(current.args.slice(-2), ["--historical-book", "--hedge"]);

  const disabled = buildBackendLaunch({
    port: 18080,
    baseline: false,
    enabled: false,
  });
  assert.equal(disabled.historicalBookEnabled, false);
  assert.equal(disabled.args.includes("--hedge"), false);

  const baseline = buildBackendLaunch({
    port: 18080,
    baseline: true,
    enabled: true,
  });
  assert.equal(baseline.historicalBookEnabled, false);
  assert.equal(baseline.args.includes("--hedge"), false);
});

test("rollback follows the current two-stage Run and market contract", () => {
  const source = fs.readFileSync(
    new URL("./replay-v2-rollback-drill.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /确认时间并创建 Run/);
  assert.match(source, /configureFormalV2TrainingPlan/);
  assert.match(source, /chooseReplayMarket/);
  assert.match(source, /runDetail\?\.adapter_session_id/);
  assert.match(source, /trainingArchive\?\.protocol === REPLAY_TRAINING_PROTOCOL/);
  assert.match(source, /REPLAY_TRAINING_PROTOCOL = "replay\.v3"/);
  assert.match(source, /data-replay-entry="disabled"/);
  assert.match(source, /disabled_entry_failed_closed/);
  assert.doesNotMatch(source, /hidden replay entry after rollback/);
  assert.doesNotMatch(source, /创建并进入训练/);
  assert.doesNotMatch(source, /searchParams\.get\("session"\)/);
});
