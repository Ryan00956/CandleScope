import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import StrategyResearchApp from "../StrategyResearchApp.js";
import { StrategyResearchRuntime } from "../StrategyResearchRuntime.js";
import {
  parseStrategyResearchLaunch,
  resolveStrategyResearchBootstrap,
  strategyResearchLaunchActions,
  strategyResearchVisualState,
} from "../strategyResearchLaunch.js";
import { EMPTY_STRATEGY_RESEARCH_STATE } from "../strategyResearchState.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("three HTML entries parse into the documented default intents", () => {
  assert.equal(parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" }).kind, "restore");
  assert.equal(parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "?source=current" }).kind, "chart");
  assert.equal(parseStrategyResearchLaunch({ pathname: "/local.html", search: "" }).kind, "imported");
  assert.equal(parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "" }).kind, "advanced");
  assert.equal(parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "?action=import" }).kind, "import");
});

test("legacy deep links run/compare/context still parse", () => {
  const run = parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "?run=bt_0123456789abcdef" });
  assert.equal(run.kind, "deep-link");
  if (run.kind === "deep-link") {
    assert.equal(run.entry.kind, "run");
    assert.equal(run.compareRunId, null);
  }
  const compare = parseStrategyResearchLaunch({
    pathname: "/backtest.html",
    search: "?run=bt_0123456789abcdef&compare=bt_fedcba9876543210",
  });
  assert.equal(compare.kind, "deep-link");
  if (compare.kind === "deep-link") {
    assert.equal(compare.entry.kind, "run");
    assert.equal(compare.compareRunId, "bt_fedcba9876543210");
  }
  const context = parseStrategyResearchLaunch({
    pathname: "/backtest.html",
    search: "?context=brc_abcdefgh",
  });
  assert.equal(context.kind, "deep-link");
  if (context.kind === "deep-link") assert.equal(context.entry.kind, "context");
});

test("flag-on uses one unified app; flag-off keeps local and backtest legacy", () => {
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: true, page: "strategy" }), "unified");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: true, page: "local" }), "unified");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: true, page: "backtest" }), "unified");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "local" }), "local-legacy");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "backtest" }), "backtest-legacy");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "strategy" }), "unified");
});

test("local import and backtest advanced launch actions do not create a Run", () => {
  const imported = parseStrategyResearchLaunch({ pathname: "/local.html", search: "" });
  assert.deepEqual(strategyResearchLaunchActions(imported), [{ type: "source/libraryOpen", open: true }]);
  const chart = parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "?source=current" });
  const chartActions = strategyResearchLaunchActions(chart);
  assert.equal(chartActions[0]?.type, "source/select");
  const advanced = parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "" });
  assert.deepEqual(strategyResearchLaunchActions(advanced), []);
  const runtime = new StrategyResearchRuntime({ restoreWorkspace: false, libraryEnabled: true });
  for (const action of strategyResearchLaunchActions(imported)) runtime.dispatch(action);
  assert.equal(runtime.state.result.runId, null);
  assert.equal(runtime.state.source.libraryOpen, true);
});

test("visual states cover first, import, chart, edit, and completed", () => {
  const restore = parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" });
  assert.equal(strategyResearchVisualState(restore, EMPTY_STRATEGY_RESEARCH_STATE), "first");
  const imported = parseStrategyResearchLaunch({ pathname: "/local.html", search: "" });
  assert.equal(strategyResearchVisualState(imported, EMPTY_STRATEGY_RESEARCH_STATE), "import");
  const withSource = {
    ...EMPTY_STRATEGY_RESEARCH_STATE,
    source: {
      source: {
        schemaVersion: "candlescope.research-source/1" as const,
        kind: "CURRENT_CHART" as const,
        workspaceId: "ws",
        cellId: "cell",
        exchange: "binance",
        marketType: "spot",
        symbol: "BTCUSDT",
        interval: "1h",
      },
      previewFrozen: false,
      libraryOpen: false,
    },
  };
  assert.equal(strategyResearchVisualState(restore, withSource), "chart");
  const advanced = parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "" });
  assert.equal(strategyResearchVisualState(advanced, EMPTY_STRATEGY_RESEARCH_STATE), "edit");
  const completed = {
    ...EMPTY_STRATEGY_RESEARCH_STATE,
    result: { runId: "bt_0123456789", stale: false, staleReason: null },
  };
  assert.equal(strategyResearchVisualState(restore, completed), "completed");
});

test("unified shell renders without creating a second library store or loading Monaco", () => {
  const intent = parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" });
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, { intent, libraryEnabled: true }),
  );
  assert.match(html, /strategy-research-shell/);
  assert.match(html, /data-visual-state="first"/);
  assert.match(html, /strategy-research-chart-slot/);
  assert.doesNotMatch(html, /monaco/i);
  assert.doesNotMatch(html, /strategy-research-advanced/);
  const appSource = readFileSync(path.resolve(here, "../StrategyResearchApp.tsx"), "utf8");
  const drawerSource = readFileSync(path.resolve(here, "../../research-data/ResearchDataDrawer.tsx"), "utf8");
  assert.doesNotMatch(appSource, /monaco-editor|PythonStudio|BacktestApp|LocalApp/);
  assert.match(appSource, /useResearchDataLibrary\(\)/);
  assert.doesNotMatch(drawerSource, /useResearchDataLibrary\(\)/);
});

test("compatibility mains call the same bootstrap and keep legacy fallbacks", () => {
  const strategyMain = readFileSync(path.resolve(here, "../../../strategy-main.tsx"), "utf8");
  const localMain = readFileSync(path.resolve(here, "../../../local-main.tsx"), "utf8");
  const backtestMain = readFileSync(path.resolve(here, "../../../backtest-main.tsx"), "utf8");
  assert.match(strategyMain, /mountStrategyResearchPage/);
  assert.match(localMain, /mountStrategyResearchPage/);
  assert.match(backtestMain, /mountStrategyResearchPage/);
  assert.match(localMain, /page: "local"/);
  assert.match(backtestMain, /page: "backtest"/);
  const bootstrap = readFileSync(path.resolve(here, "../strategyResearchBootstrap.tsx"), "utf8");
  assert.match(bootstrap, /StrategyResearchApp/);
  assert.match(bootstrap, /LocalApp/);
  assert.match(bootstrap, /BacktestResearchApp/);
  assert.match(bootstrap, /local-legacy/);
});

test("drawer failure fallback copy does not clear a script draft", () => {
  const runtime = new StrategyResearchRuntime({ restoreWorkspace: false, libraryEnabled: true });
  runtime.dispatch({ type: "script/setDraft", draftId: "draft-keep" });
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" }),
      libraryEnabled: true,
    }),
  );
  assert.match(html, /data-strategy-draft=""/);
  assert.equal(runtime.state.script.draftId, "draft-keep");
});

test("flag-off bootstrap chooses legacy local and backtest trees", () => {
  const bootstrap = readFileSync(path.resolve(here, "../strategyResearchBootstrap.tsx"), "utf8");
  assert.match(bootstrap, /if \(mode === "local-legacy"\)/);
  assert.match(bootstrap, /if \(mode === "unified"\)/);
  assert.match(bootstrap, /<LocalApp/);
  assert.match(bootstrap, /<BacktestResearchApp/);
});
