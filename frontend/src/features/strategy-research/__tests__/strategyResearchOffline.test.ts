import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ResearchDataDrawer } from "../../research-data/ResearchDataDrawer.js";
import { StrategyResearchRuntime } from "../StrategyResearchRuntime.js";
import { parseStrategyResearchLaunch } from "../strategyResearchLaunch.js";
import { parseStrategyResearchHostHealth } from "../strategyResearchHostHealth.js";
import { ChartStrategyRunError } from "../../backtest/chart-tester/chartStrategyRunRequest.js";
import StrategyResearchApp from "../StrategyResearchApp.js";


const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../");

const settings = {
  upColor: "#0f0",
  downColor: "#f00",
  chartType: "candles",
} as never;

test("offline launcher opens the unified imported workspace and keeps local.html as compatibility", () => {
  const ps1 = readFileSync(path.join(repoRoot, "start-local-offline.ps1"), "utf8");
  const sh = readFileSync(path.join(repoRoot, "start-local-offline.sh"), "utf8");
  assert.match(ps1, /strategy\.html\?source=imported/);
  assert.match(sh, /strategy\.html\?source=imported/);
  assert.match(ps1, /VITE_RESEARCH_DATA_LIBRARY_ENABLED/);
  assert.match(sh, /VITE_RESEARCH_DATA_LIBRARY_ENABLED/);
  assert.doesNotMatch(ps1, /FrontendPort\/local\.html/);
  const localHtml = readFileSync(path.join(repoRoot, "frontend/local.html"), "utf8");
  assert.match(localHtml, /local/);
  assert.equal(parseStrategyResearchLaunch({
    pathname: "/strategy.html",
    search: "?source=imported",
  }).kind, "imported");
});

test("health payload sets LOCAL_OFFLINE without inventing a page toggle", () => {
  const health = parseStrategyResearchHostHealth({
    status: "ok",
    runtime_mode: "LOCAL_OFFLINE",
    local_offline: {
      mode: "LOCAL_OFFLINE",
      network: { installed: true, policy: "loopback_only", blocked_attempts: 2 },
    },
  });
  assert.equal(health.runtimeMode, "LOCAL_OFFLINE");
  assert.equal(health.network?.installed, true);
  assert.equal(health.network?.blockedAttempts, 2);
  const live = parseStrategyResearchHostHealth({ status: "ok", runtime_mode: "LIVE" });
  assert.equal(live.runtimeMode, "LIVE");
  assert.equal(live.network, null);
  const appSource = readFileSync(path.resolve(here, "../StrategyResearchApp.tsx"), "utf8");
  const healthSource = readFileSync(path.resolve(here, "../strategyResearchHostHealth.ts"), "utf8");
  assert.match(appSource, /loadStrategyResearchHostHealth/);
  assert.match(healthSource, /fetch\("\/health"/);
  assert.doesNotMatch(appSource, /runtimeModeToggle|setRuntimeMode\(|page toggle/i);
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "?source=imported" }),
      libraryEnabled: true,
    }),
  );
  assert.match(html, /data-runtime-mode="LIVE"/);
  assert.doesNotMatch(html, /runtime-mode-toggle/);
});

test("LOCAL_OFFLINE current chart is shown with a reason and is not runnable", () => {
  const runtime = new StrategyResearchRuntime({
    restoreWorkspace: false,
    runtimeMode: "LOCAL_OFFLINE",
    libraryEnabled: true,
  });
  assert.equal(runtime.currentChartRunnable(), false);
  const html = renderToStaticMarkup(
    React.createElement(ResearchDataDrawer, {
      open: true,
      runtimeMode: "LOCAL_OFFLINE",
      capabilities: runtime.capabilitiesFor("CURRENT_CHART"),
      libraryEnabled: true,
      settings,
      events: [],
      onSelectKind() {},
      onClose() {},
    }),
  );
  assert.match(html, /research-source-card-CURRENT_CHART/);
  assert.match(html, /disabled/);
  assert.match(html, /research-source-card-IMPORTED_DATASET/);
});

test("offline live materialize is rejected before a network resolve", () => {
  const error = new ChartStrategyRunError(
    "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
    "live market data is unavailable in the offline runtime",
  );
  assert.equal(error.code, "OFFLINE_LIVE_SOURCE_UNAVAILABLE");
  const runSource = readFileSync(path.resolve(here, "../useStrategyResearchRun.ts"), "utf8");
  assert.match(runSource, /LOCAL_OFFLINE/);
  assert.match(runSource, /OFFLINE_LIVE_SOURCE_UNAVAILABLE/);
  assert.match(runSource, /materialize/);
  assert.match(runSource, /CURRENT_CHART_UNBOUND/);
  assert.match(runSource, /trackAbortController/);
  assert.match(runSource, /draftContentRevision/);
});
