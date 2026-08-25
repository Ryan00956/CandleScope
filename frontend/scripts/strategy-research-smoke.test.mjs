import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runStrategyResearchSmoke } from "./strategy-research-smoke.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("strategy research smoke accepts the unified workspace contract", () => {
  const result = runStrategyResearchSmoke(repoRoot);
  assert.equal(result.ok, true);
  assert.equal(result.canonical, "/strategy.html");
  assert.deepEqual(result.compatibility, ["/local.html", "/backtest.html"]);
  assert.equal(result.libraryFlagDefault, 1);
});
