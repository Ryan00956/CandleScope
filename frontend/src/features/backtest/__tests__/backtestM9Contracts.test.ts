import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../BacktestApp.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../backtestApi.ts", import.meta.url), "utf8");
const chart = readFileSync(new URL("../BacktestResultChart.tsx", import.meta.url), "utf8");
const projection = readFileSync(new URL("../chart-tester/chartStrategyResultProjection.ts", import.meta.url), "utf8");

test("M9 workspace exposes immutable revision compile, smoke, trace, compare and clone paths", () => {
  for (const token of ["backtest.revisionWorkspace", "backtest.compileSave", "backtest.smokeOk",
    "rsi-trace-pane", "backtest.decisionFillHashes", "backtest.newImmutable"]) {
    assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const path of ["/strategy-revisions", "/signal-trace", "/compare/pair", "/clone", "/review-bridge", "/review-bridges/"]) {
    assert.ok(api.includes(path));
  }
  for (const token of ["backtest.tradeDiff", "backtest.costDiff", "drawdownDaily", "backtest.revealCompare"]) {
    assert.ok(app.includes(token));
  }
});

test("M9 long curves and tables have explicit render bounds", () => {
  assert.match(app, /boundedRows\(report\.fills\)/);
  assert.match(app, /limit = 1_000/);
  assert.match(chart, /boundBacktestProjectionRows\(data\)/);
  assert.match(projection, /limit = 2_000/);
  assert.match(projection, /slice\(-limit\)/);
});
