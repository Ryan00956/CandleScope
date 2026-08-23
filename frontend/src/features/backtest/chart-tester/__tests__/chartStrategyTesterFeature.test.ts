import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { resolveChartStrategyTesterEnabled } from "../chartStrategyTesterFeature.js";

test("chart strategy tester flag is default off and strict", () => {
  assert.equal(resolveChartStrategyTesterEnabled(), false);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: "0" }), false);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: "true" }), false);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: "1" }), true);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: true }), true);
});

test("phase 3 keeps the tester runtime and editor out of the App import graph", () => {
  const app = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
  const cell = readFileSync(resolve(process.cwd(), "src/app/LiveChartCell.tsx"), "utf8");
  const exampleEnvironment = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
  assert.doesNotMatch(app, /chart-tester|ChartStrategyTesterRuntime|StrategyDraftStore/);
  assert.doesNotMatch(cell, /chart-tester|ChartStrategyTesterRuntime|StrategyDraftStore/);
  assert.match(exampleEnvironment, /^VITE_CHART_STRATEGY_TESTER_ENABLED=0$/m);
});
