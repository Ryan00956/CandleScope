import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createBacktestApi } from "../../backtestApi.js";
import type {
  BacktestResearchLaunchContext,
  BacktestRunRecord,
} from "../../backtestTypes.js";
import type { ChartStrategyResultBundle } from "../../chart-tester/chartStrategyResultCache.js";
import {
  backtestResearchHasPanel,
  backtestResearchPanels,
  researchReturnHref,
  researchRunIdentityReady,
  researchSessionFromAuthority,
  shouldEnableBacktestResearchLiveSource,
} from "../backtestResearchModel.js";
import {
  backtestResearchContextHref,
  buildBacktestResearchLaunchContext,
} from "../backtestResearchLaunch.js";
import ResearchTaskPicker from "../ResearchTaskPicker.js";

const context: BacktestResearchLaunchContext = {
  schema_version: "candlescope.backtest-research-launch-context/1",
  context_id: "brc_context_12345678",
  context_hash: "sha256:context",
  source_workspace_id: "workspace-main",
  source_cell_id: "cell-main",
  strategy_draft_id: "draft-12345678",
  strategy_revision_id: "rev-12345678",
  parameters: { fast: 3 },
  quick_preset_id: "crypto-perp-conservative-v1",
  chart_session: {
    exchange: "okx",
    market_type: "swap",
    symbol: "ETHUSDT",
    interval: "1h",
  },
  range: { mode: "CUSTOM", start_time_ms: 1000, end_time_ms: 2000 },
  dataset_identity: {
    dataset_id: "dataset-12345678",
    data_epoch: "sha256:epoch",
    snapshot_hash: "sha256:snapshot",
  },
  latest_run_id: "bt_result_12345678",
  baseline_run_id: "bt_baseline_12345678",
  created_at_ms: 1,
};

test("five research tasks expose only their declared shared panel composition", () => {
  assert.deepEqual(backtestResearchPanels("PRECISE_EXECUTION"), [
    "STRATEGY", "DATA", "EXECUTION", "RUN", "RESULTS",
  ]);
  assert.equal(backtestResearchHasPanel("PARAMETER_ROBUSTNESS", "STUDY"), true);
  assert.equal(backtestResearchHasPanel("PARAMETER_ROBUSTNESS", "EXECUTION"), false);
  assert.equal(backtestResearchHasPanel("PYTHON_MODEL", "DATA"), false);
  assert.deepEqual(backtestResearchPanels("REPLAY_REVIEW"), ["RUN", "RESULTS"]);
});

test("task home renders five functional task entries without mounting a chart", () => {
  const html = renderToStaticMarkup(
    <ResearchTaskPicker returnHref="/" onSelect={() => undefined} />,
  );
  assert.equal((html.match(/data-research-task=/g) ?? []).length, 5);
  assert.match(html, /research-task-home/);
  assert.doesNotMatch(html, /chart-area/);
});

test("authority restores context session and safely returns to a scoped chart", () => {
  assert.deepEqual(researchSessionFromAuthority({ context, run: null, chart: null }), {
    exchange: "okx",
    marketType: "swap",
    symbol: "ETHUSDT",
    interval: "1h",
  });
  assert.equal(
    researchReturnHref(context),
    "/?workspace=workspace-main&cell=cell-main&source=backtest-research",
  );
  assert.equal(researchReturnHref({ ...context, source_cell_id: null }), "/");
});

test("Run deep link derives session from immutable Run config and chart", () => {
  const run: BacktestRunRecord = {
    run_id: "bt_result_12345678",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:config",
    config_json: JSON.stringify({ exchange: "binance", market_type: "usdm", symbol: "BTCUSDT", interval: "15m" }),
  };
  assert.deepEqual(researchSessionFromAuthority({
    context: null,
    run,
    chart: { run_id: run.run_id, chart_hash: "sha256:chart", symbol: "SOLUSDT", interval: "5m", bars: [], fills: [], equity_curve: [], truncated: false },
  }), { exchange: "binance", marketType: "usdm", symbol: "SOLUSDT", interval: "5m" });
  assert.equal(researchRunIdentityReady({
    run,
    report: null,
    chart: null,
  }), false);
});

test("live market transport is disabled for offline and immutable sources", () => {
  assert.equal(shouldEnableBacktestResearchLiveSource("LIVE", "LIVE_REFERENCE"), true);
  assert.equal(shouldEnableBacktestResearchLiveSource("LOCAL_OFFLINE", "LIVE_REFERENCE"), false);
  assert.equal(shouldEnableBacktestResearchLiveSource("LIVE", "RUN_RESULT"), false);
  assert.equal(shouldEnableBacktestResearchLiveSource(null, "FROZEN_SNAPSHOT"), false);
});

test("quick tester launch context carries IDs and frozen selection without source copies", () => {
  const result = {
    run: {
      run_id: "bt_result_12345678",
      state: "COMPLETED",
      fidelity_mode: "BAR_APPROX",
      source_event_kind: "BAR",
      config_hash: "sha256:config",
      dataset_id: "dataset-12345678",
      data_epoch: "sha256:epoch",
      snapshot_hash: "sha256:snapshot",
    },
    config: { start_time_ms: 1000, end_time_ms: 2000 },
  } as ChartStrategyResultBundle;
  const payload = buildBacktestResearchLaunchContext({
    workspaceId: "workspace-main",
    cellId: "cell-main",
    session: { exchange: "binance", marketType: "usdm", symbol: "BTCUSDT", interval: "15m" },
    attachment: {
      schemaVersion: 1,
      strategyDraftId: "draft-12345678",
      strategyRevisionId: "rev-12345678",
      displayName: "SMA",
      language: "pyne",
      parameters: { fast: 3 },
      rangeMode: "CUSTOM",
      customRange: { startMs: 10, endMs: 20 },
      fidelityPreference: "FAST",
      quickPresetId: "crypto-perp-conservative-v1",
      autoRun: true,
    },
    result,
    resolution: null,
    activeRunId: result.run.run_id,
    baselineRunId: "bt_baseline_12345678",
  });
  assert.equal(payload.latest_run_id, result.run.run_id);
  assert.deepEqual(payload.range, { mode: "CUSTOM", start_time_ms: 1000, end_time_ms: 2000 });
  assert.equal("source" in payload, false);
  assert.equal(backtestResearchContextHref("brc_context_12345678"), "/backtest.html?context=brc_context_12345678");
});

test("research context API posts payload and re-reads by opaque ID", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? "GET") });
    return new Response(JSON.stringify(context), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const api = createBacktestApi("/api/v1/backtests");
    const input = {
      source_workspace_id: context.source_workspace_id,
      source_cell_id: context.source_cell_id,
      strategy_draft_id: context.strategy_draft_id,
      strategy_revision_id: context.strategy_revision_id,
      parameters: context.parameters,
      quick_preset_id: context.quick_preset_id,
      chart_session: context.chart_session,
      range: context.range,
      dataset_identity: context.dataset_identity,
      latest_run_id: context.latest_run_id,
      baseline_run_id: context.baseline_run_id,
    };
    await api.createResearchLaunchContext(input);
    await api.getResearchLaunchContext(context.context_id);
    assert.deepEqual(calls, [
      { url: "/api/v1/backtests/research/contexts", method: "POST" },
      { url: "/api/v1/backtests/research/contexts/brc_context_12345678", method: "GET" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
