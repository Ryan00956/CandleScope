import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const strategy = readFileSync(new URL("../research/ResearchStrategyPanel.tsx", import.meta.url), "utf8");
const runPanel = readFileSync(new URL("../research/ResearchRunPanel.tsx", import.meta.url), "utf8");
const replay = readFileSync(new URL("../research/ResearchReplayPanel.tsx", import.meta.url), "utf8");
const results = readFileSync(new URL("../chart-tester/ChartStrategyResultViews.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../backtestApi.ts", import.meta.url), "utf8");
const chart = readFileSync(new URL("../BacktestResultChart.tsx", import.meta.url), "utf8");
const equity = readFileSync(new URL("../BacktestEquityCurve.tsx", import.meta.url), "utf8");
const projection = readFileSync(new URL("../chart-tester/chartStrategyResultProjection.ts", import.meta.url), "utf8");
const legacyMap = readFileSync(new URL("../../strategy-research/strategyResearchLegacyMap.ts", import.meta.url), "utf8");
const backtestApp = readFileSync(new URL("../BacktestApp.tsx", import.meta.url), "utf8");

test("M9 workspace exposes immutable revision compile, smoke, compare and clone paths", () => {
  for (const token of ["research.strategy.compile", "research.strategy.smoke", "PythonStudioPanel"]) {
    assert.match(strategy, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(runPanel, /cloneRun/);
  assert.match(replay, /revealReviewBridge/);
  assert.match(results, /tradeDiff/);
  for (const path of ["/strategy-revisions", "/signal-trace", "/compare/pair", "/clone", "/review-bridge", "/review-bridges/"]) {
    assert.ok(api.includes(path));
  }
  assert.match(legacyMap, /rsi-trace-pane/);
  assert.match(legacyMap, /status: "deferred"/);
  assert.doesNotMatch(backtestApp, /rsi-trace-pane|boundedRows\(report\.fills\)/);
});

test("M9 long curves and tables have explicit render bounds", () => {
  assert.match(chart, /BacktestEquityCurve/);
  assert.match(equity, /boundBacktestProjectionRows\(data\)/);
  assert.match(projection, /limit = 2_000/);
  assert.match(projection, /slice\(-limit\)/);
});
