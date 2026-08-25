import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveResearchDataLibraryEnabled } from "../../research-data/researchDataFlags.js";
import { resolveStrategyResearchBootstrap } from "../strategyResearchLaunch.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");

test("dual-flag rollback restores chart-first and independent local shell", () => {
  assert.equal(resolveResearchDataLibraryEnabled({}), false);
  assert.equal(resolveResearchDataLibraryEnabled({ VITE_RESEARCH_DATA_LIBRARY_ENABLED: "0" }), false);
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "local" }), "local-legacy");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "backtest" }), "backtest-legacy");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "strategy" }), "unified");
  const topBar = readFileSync(path.join(repoRoot, "frontend/src/app/TopBar.tsx"), "utf8");
  assert.match(topBar, /href="\/strategy\.html"/);
  assert.doesNotMatch(topBar, /href="\/backtest\.html"/);
});

test("release smoke entrypoints remain in the production Vite inputs", () => {
  const vite = readFileSync(path.join(repoRoot, "frontend/vite.config.js"), "utf8");
  assert.match(vite, /local\.html/);
  assert.match(vite, /backtest\.html/);
  assert.match(vite, /strategy\.html/);
});
