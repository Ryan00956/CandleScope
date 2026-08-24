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

test("phase 4 keeps runtime, draft storage, and Monaco behind lazy boundaries", () => {
  const app = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
  const cell = readFileSync(resolve(process.cwd(), "src/app/LiveChartCell.tsx"), "utf8");
  const panel = readFileSync(
    resolve(process.cwd(), "src/features/backtest/chart-tester/ChartStrategyTesterPanel.tsx"),
    "utf8",
  );
  const workspace = readFileSync(
    resolve(process.cwd(), "src/features/backtest/chart-tester/StrategyScriptWorkspace.tsx"),
    "utf8",
  );
  const exampleEnvironment = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
  assert.doesNotMatch(app, /ChartStrategyTesterRuntime|StrategyDraftStore|@monaco-editor/);
  assert.doesNotMatch(cell, /ChartStrategyTesterRuntime|StrategyDraftStore|@monaco-editor/);
  assert.match(cell, /lazy\(loadChartStrategyTesterCellBridge\)/);
  assert.match(cell, /identityAccessory=\{strategyEntryControl\}/);
  assert.match(cell, /data-chart-strategy-entry=\{cell\.id\}/);
  assert.match(cell, /globalThis\.setTimeout\(\(\) => \{[\s\S]*data-chart-strategy-entry/);
  assert.match(cell, /\(currentEntry \?\? strategyEntryRef\.current\)\?\.focus\(\)/);
  assert.match(app, /bottomPanel=\{CHART_STRATEGY_TESTER_ENABLED/);
  assert.doesNotMatch(panel, /from\s+["']@monaco-editor\/react/);
  assert.match(panel, /lazy\(\(\) => import\("\.\/StrategyScriptWorkspace\.js"\)\)/);
  assert.match(workspace, /KeyMod\.CtrlCmd\s*\|\s*monaco\.KeyCode\.Enter/);
  assert.match(workspace, /chart-strategy-tester\.run/);
  assert.match(workspace, /run:\s*\(\)\s*=>\s*onRunRef\.current\(\)/);
  assert.doesNotMatch(workspace, /onKeyDownCapture/);
  assert.match(exampleEnvironment, /^VITE_CHART_STRATEGY_TESTER_ENABLED=0$/m);
});
