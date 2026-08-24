import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  resolveChartRunCompareEnabled,
  resolveChartStrategyAutoRunEnabled,
  resolveChartStrategyTesterEnabled,
  resolveChartTradeExplanationEnabled,
} from "../chartStrategyTesterFeature.js";

test("chart strategy tester flag is default off and strict", () => {
  assert.equal(resolveChartStrategyTesterEnabled(), false);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: "0" }), false);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: "true" }), false);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: "1" }), true);
  assert.equal(resolveChartStrategyTesterEnabled({ VITE_CHART_STRATEGY_TESTER_ENABLED: true }), true);
});

test("trade explanation and recent Run comparison flags are default off and strict", () => {
  assert.equal(resolveChartTradeExplanationEnabled(), false);
  assert.equal(resolveChartTradeExplanationEnabled({ VITE_CHART_TRADE_EXPLANATION_ENABLED: "true" }), false);
  assert.equal(resolveChartTradeExplanationEnabled({ VITE_CHART_TRADE_EXPLANATION_ENABLED: "1" }), true);
  assert.equal(resolveChartRunCompareEnabled(), false);
  assert.equal(resolveChartRunCompareEnabled({ VITE_CHART_RUN_COMPARE_ENABLED: 1 }), true);
});

test("chart strategy auto-run is default off and strict", () => {
  assert.equal(resolveChartStrategyAutoRunEnabled(), false);
  assert.equal(resolveChartStrategyAutoRunEnabled({ VITE_CHART_STRATEGY_AUTO_RUN_ENABLED: "true" }), false);
  assert.equal(resolveChartStrategyAutoRunEnabled({ VITE_CHART_STRATEGY_AUTO_RUN_ENABLED: "1" }), true);
});

test("phase 4 keeps runtime, draft storage, and Monaco behind lazy boundaries", () => {
  const app = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
  const cell = readFileSync(resolve(process.cwd(), "src/app/LiveChartCell.tsx"), "utf8");
  const panel = readFileSync(
    resolve(process.cwd(), "src/features/backtest/chart-tester/ChartStrategyTesterPanel.tsx"),
    "utf8",
  );
  const bridge = readFileSync(
    resolve(process.cwd(), "src/features/backtest/chart-tester/ChartStrategyTesterCellBridge.tsx"),
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
  assert.match(cell, /const openStrategyPanel = useCallback\(\(\) => \{/);
  assert.match(cell, /onOpenPanel=\{openStrategyPanel\}/);
  assert.doesNotMatch(cell, /onOpenPanel=\{\(\) => onStrategyPanelOpenChange\(true\)\}/);
  assert.match(app, /bottomPanel=\{CHART_STRATEGY_TESTER_ENABLED/);
  assert.doesNotMatch(panel, /from\s+["']@monaco-editor\/react/);
  assert.match(panel, /lazy\(\(\) => import\("\.\/StrategyScriptWorkspace\.js"\)\)/);
  assert.match(panel, /runReady \|\| runState\.status === "COMPLETED"/);
  assert.match(panel, /chartTester\.autoRun\.preciseManual/);
  assert.match(workspace, /KeyMod\.CtrlCmd\s*\|\s*monaco\.KeyCode\.Enter/);
  assert.match(workspace, /chart-strategy-tester\.run/);
  assert.match(workspace, /run:\s*\(\)\s*=>\s*onRunRef\.current\(\)/);
  assert.doesNotMatch(workspace, /onKeyDownCapture/);
  assert.match(exampleEnvironment, /^VITE_CHART_STRATEGY_TESTER_ENABLED=0$/m);
  assert.match(exampleEnvironment, /^VITE_CHART_TRADE_EXPLANATION_ENABLED=0$/m);
  assert.match(exampleEnvironment, /^VITE_CHART_RUN_COMPARE_ENABLED=0$/m);
  assert.match(exampleEnvironment, /^VITE_CHART_STRATEGY_AUTO_RUN_ENABLED=0$/m);
  assert.match(bridge, /CHART_STRATEGY_AUTO_RUN_DEBOUNCE_MS/);
  assert.match(bridge, /chartStrategyAutoRunCoordinator\.enqueue/);
  assert.match(bridge, /currentRuntime\.snapshot\(\)\.generation !== intent\.generation/);
  assert.match(bridge, /attachment\.fidelityPreference !== "FAST"/);
  assert.match(bridge, /cancelPendingAutoRun\(\);[\s\S]*startRun\(request\)/);
  assert.match(bridge, /inFlightOriginRef\.current === "AUTO"/);
  assert.match(bridge, /!inFlightSubmittedRef\.current/);
  assert.match(bridge, /manual Run preempted unsubmitted auto Run/);
});
