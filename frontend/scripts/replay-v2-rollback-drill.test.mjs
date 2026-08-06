import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBackendPythonPath } from "./replay-v2-rollback-drill.mjs";

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
