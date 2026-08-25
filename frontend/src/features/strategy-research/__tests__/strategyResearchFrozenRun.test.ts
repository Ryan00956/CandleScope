import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { qualitySummaryFromImportedManifest } from "../../backtest/chart-tester/chartStrategyRunRequest.js";
import StrategyResearchApp from "../StrategyResearchApp.js";
import { StrategyResearchScriptPanel } from "../StrategyResearchScriptPanel.js";
import { StrategyResearchResultPanel } from "../StrategyResearchResultPanel.js";
import { parseStrategyResearchLaunch } from "../strategyResearchLaunch.js";
import { sessionFromResearchSource } from "../useStrategyResearchRun.js";


const here = path.dirname(fileURLToPath(import.meta.url));

test("unified first paint still does not load Monaco and does not ask for a dataset ID", () => {
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" }),
      libraryEnabled: true,
    }),
  );
  assert.match(html, /strategy-research-shell/);
  assert.doesNotMatch(html, /monaco/i);
  assert.doesNotMatch(html.toLowerCase(), /dataset id|data epoch|snapshot hash/);
  const appSource = readFileSync(path.resolve(here, "../StrategyResearchApp.tsx"), "utf8");
  assert.match(appSource, /StrategyResearchScriptPanel/);
  assert.match(appSource, /StrategyResearchResultPanel/);
  assert.match(appSource, /useStrategyResearchRun/);
});

test("imported session is local/spot and never requires the user to type dataset identity", () => {
  const session = sessionFromResearchSource({
    schemaVersion: "candlescope.research-source/1",
    kind: "IMPORTED_DATASET",
    datasetId: "local-0123456789abcdef0123456789abcdef",
    dataEpoch: `sha256:${"a".repeat(64)}`,
    interval: "15m",
  }, {
    schema_version: 1,
    dataset_id: "local-0123456789abcdef0123456789abcdef",
    data_epoch: `sha256:${"a".repeat(64)}`,
    name: "BTC sample",
    source: "local_dataset",
    symbol: "BTC-USDT",
    interval: "15m",
    volume_available: true,
    timezone: "UTC",
    timestamp_semantics: "bar_open",
    rows: 96,
    first_open_ms: 1,
    last_open_ms: 2,
    all_rows_final: true,
    excluded_range_count: 0,
    sqlite_sha256: "b".repeat(64),
    imported_at: "2026-08-25T00:00:00+00:00",
  }, "30m");
  assert.equal(session?.exchange, "local");
  assert.equal(session?.marketType, "spot");
  assert.equal(session?.interval, "30m");
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchScriptPanel, {
      cellScope: "strategy-research",
      session,
      sourceKind: "IMPORTED_DATASET",
      barOnly: true,
      runStatus: "READY",
      needsData: false,
      onDraftId() {},
      onRun() {},
      onConfirmNeedsData() {},
    }),
  );
  assert.match(html, /strategy-research-bar-only/);
  assert.match(html, /strategy-research-templates/);
  assert.doesNotMatch(html.toLowerCase(), /dataset id|data epoch|snapshot hash/);
  assert.equal(qualitySummaryFromImportedManifest({
    rows: 96,
    excludedRangeCount: 2,
    volumeAvailable: false,
  }).status, "gap");
});

test("BAR_ONLY result panel does not advertise trade-sequence precision", () => {
  const html = renderToStaticMarkup(
    React.createElement(StrategyResearchResultPanel, {
      result: null,
      stale: false,
      staleReasons: [],
      barOnly: true,
      error: null,
      runStatus: "READY",
      network: null,
    }),
  );
  assert.match(html, /strategy-research-bar-only-result/);
  assert.doesNotMatch(html, /成交序列精算|Trade-sequence calculation/);
});
