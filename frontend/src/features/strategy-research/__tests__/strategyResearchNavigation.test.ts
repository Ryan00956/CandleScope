import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import StrategyResearchApp from "../StrategyResearchApp.js";
import {
  parseStrategyResearchLaunch,
  strategyResearchDeepLinkSearch,
} from "../strategyResearchLaunch.js";
import { strategyResearchAdvancedCellId } from "../strategyResearchAdvanced.js";
import { researchReturnHref } from "../../backtest/research/backtestResearchModel.js";
import { StrategyResearchScriptPanel } from "../StrategyResearchScriptPanel.js";


const here = path.dirname(fileURLToPath(import.meta.url));

test("TopBar strategy entry is /strategy.html and not a sibling 策略回测 link", () => {
  const topBar = readFileSync(path.resolve(here, "../../../app/TopBar.tsx"), "utf8");
  assert.match(topBar, /href="\/strategy\.html"/);
  assert.match(topBar, /shell\.strategy/);
  assert.doesNotMatch(topBar, /href="\/backtest\.html"/);
  assert.doesNotMatch(topBar, /shell\.backtest/);
});

test("backtest.html remains a compatibility deep-link URL into the unified app", () => {
  assert.equal(parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "" }).kind, "advanced");
  const run = parseStrategyResearchLaunch({
    pathname: "/backtest.html",
    search: "?run=bt_0123456789abcdef",
  });
  assert.equal(run.kind, "deep-link");
  assert.equal(strategyResearchDeepLinkSearch(run), "?run=bt_0123456789abcdef");
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "" }),
      libraryEnabled: true,
    }),
  );
  assert.match(html, /strategy-research-advanced/);
  assert.doesNotMatch(html, /monaco/i);
});

test("invalid deep link shows an actionable error and does not select a dataset", () => {
  const intent = parseStrategyResearchLaunch({
    pathname: "/backtest.html",
    search: "?run=not-a-run",
  });
  assert.equal(intent.kind, "invalid");
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent,
      libraryEnabled: true,
    }),
  );
  assert.match(html, /strategy-research-deep-link-error/);
  assert.doesNotMatch(html, /research-dataset-/);
  assert.doesNotMatch(html.toLowerCase(), /dataset id/);
});

test("imported and current-chart advanced returns stay on strategy.html without reusing live runtime query", () => {
  assert.equal(strategyResearchAdvancedCellId({
    schemaVersion: "candlescope.research-source/1",
    kind: "IMPORTED_DATASET",
    datasetId: "local-0123456789abcdef0123456789abcdef",
    dataEpoch: `sha256:${"a".repeat(64)}`,
    interval: "15m",
  }), "imported");
  assert.equal(strategyResearchAdvancedCellId({
    schemaVersion: "candlescope.research-source/1",
    kind: "CURRENT_CHART",
    workspaceId: "ws",
    cellId: "cell",
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  }), "current");
  assert.equal(
    researchReturnHref({
      schema_version: "candlescope.backtest-research-launch-context/1",
      context_id: "brc_context_12345678",
      context_hash: "sha256:context",
      source_workspace_id: "strategy-research",
      source_cell_id: "imported",
      strategy_draft_id: "draft-12345678",
      strategy_revision_id: null,
      parameters: {},
      quick_preset_id: "CRYPTO_SPOT_STANDARD_V1",
      chart_session: { exchange: "local", market_type: "spot", symbol: "BTC-USDT", interval: "15m" },
      range: { mode: "ALL_AVAILABLE", start_time_ms: null, end_time_ms: null },
      dataset_identity: null,
      latest_run_id: null,
      baseline_run_id: null,
      created_at_ms: 1,
    }),
    "/strategy.html?source=imported",
  );
});

test("ordinary script panel exposes advanced research without internal identity copy", () => {
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchScriptPanel, {
      cellScope: "strategy-research",
      session: { exchange: "local", marketType: "spot", symbol: "BTC-USDT", interval: "15m" },
      sourceKind: "IMPORTED_DATASET",
      barOnly: true,
      runStatus: "READY",
      needsData: false,
      onDraftId() {},
      onRun() {},
      onConfirmNeedsData() {},
      onOpenAdvanced() {},
    }),
  );
  assert.match(html, /strategy-research-open-advanced/);
  assert.doesNotMatch(html.toLowerCase(), /dataset id|data epoch|snapshot hash/);
});

test("unified app lazily hosts advanced research and does not import the advanced runtime", () => {
  const app = readFileSync(path.resolve(here, "../StrategyResearchApp.tsx"), "utf8");
  assert.match(app, /lazy\(\(\) => import\("\.\.\/backtest\/research\/BacktestResearchApp/);
  assert.doesNotMatch(app, /useBacktestResearchRuntime/);
  assert.match(app, /createStrategyResearchAdvancedHref/);
});
