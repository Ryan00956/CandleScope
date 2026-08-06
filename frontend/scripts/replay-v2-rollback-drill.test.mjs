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
