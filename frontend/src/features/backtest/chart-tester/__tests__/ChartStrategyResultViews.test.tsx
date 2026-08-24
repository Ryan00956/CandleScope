import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RecentRunCompareV1, TradeExplanationV1 } from "../../backtestTypes.js";
import type { ChartStrategyResultBundle } from "../chartStrategyResultCache.js";
import {
  ChartStrategyResultContextBar,
  ChartStrategyResultOverview,
  TradeExplanationPopover,
} from "../ChartStrategyResultViews.js";

const result: ChartStrategyResultBundle = {
  cacheKey: "bt_result_12345678|sha256:report|sha256:chart",
  run: {
    run_id: "bt_result_12345678",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:config",
  },
  config: {
    start_time_ms: 1_700_000_000_000,
    end_time_ms: 1_700_003_600_000,
    chart_range_mode: "ALL_AVAILABLE",
    fee_source: "BINANCE_SPOT_V1",
    taker_fee_bps: "10",
    maker_fee_bps: "10",
    slippage_bps: "2",
  },
  reportHash: "sha256:report",
  chartHash: "sha256:chart",
  report: {
    schemaVersion: "1",
    runId: "bt_result_12345678",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    report_label: "快速估算",
    hashes: { report: "sha256:report" },
    metrics: {
      fill_count: 0,
      ambiguity_count: 0,
      rejected_order_count: 0,
      trade_count: 0,
      winning_trade_count: 0,
      win_rate: "0%",
      realized_net_pnl: "0",
    },
    credibility: {
      level: "LOCAL_RESEARCH",
      sample_role: "IN_SAMPLE",
      profit_guarantee: false,
      open_positions_excluded_from_trade_metrics: true,
    },
    unmodeled: [],
    suitable_for: [],
    not_suitable_for: [],
    fills: [],
    trades: [],
  },
  chart: {
    run_id: "bt_result_12345678",
    chart_hash: "sha256:chart",
    symbol: "BTCUSDT",
    interval: "1m",
    bars: [],
    fills: [],
    equity_curve: [],
    truncated: false,
  },
};

function explanation(): TradeExplanationV1 {
  const fixture = JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../backend/tests/fixtures/backtest/trade_explanation_v1_jcs.json",
  ), "utf8")) as { payload: TradeExplanationV1 };
  return fixture.payload;
}

function comparison(directComparisonAllowed: boolean): RecentRunCompareV1 {
  return {
    schema: "RUN_COMPARE_RECENT_V1",
    currentRunId: result.run.run_id,
    baselineRunId: "bt_baseline_12345678",
    comparison: {
      schema: "RUN_COMPARE_V3",
      directComparisonAllowed,
      incompatibleFields: directComparisonAllowed ? [] : ["fidelity_mode"],
      comparisonContext: { leftHash: "sha256:left", rightHash: directComparisonAllowed ? "sha256:left" : "sha256:right" },
      precisionExplanation: null,
      parameterDiff: {},
      tradeDiff: {
        netPnl: { left: "10", right: "12", delta: "2" },
        maxDrawdown: { left: "-4", right: "-3", delta: "1" },
        tradeCount: { left: 3, right: 4, delta: "1" },
      },
      costDiff: {},
      fingerprintDiff: {
        version: "TRADE_FINGERPRINT_V2",
        available: directComparisonAllowed,
        addedCount: directComparisonAllowed ? 2 : null,
        removedCount: directComparisonAllowed ? 1 : null,
        unchangedCount: directComparisonAllowed ? 2 : null,
        added: [],
        removed: [],
      },
      left: { runId: "bt_baseline_12345678", hashes: {}, equity: [], equityDaily: [], drawdownDaily: [], metrics: {} },
      right: { runId: result.run.run_id, hashes: {}, equity: [], equityDaily: [], drawdownDaily: [], metrics: {} },
    },
  };
}

test("result context is completed-Run authoritative and never claims all history", () => {
  const html = renderToStaticMarkup(
    <ChartStrategyResultContextBar result={result} locale="zh-CN" stale={false} />,
  );
  assert.match(html, /BTCUSDT · 1m/);
  assert.match(html, /全部本地可用数据/);
  assert.doesNotMatch(html, /全部历史/);
  assert.match(html, /BINANCE_SPOT_V1/);
  assert.match(html, /backtest\.html\?run=bt_result_12345678/);
  assert.match(html, /data-result-cache-key="bt_result_12345678\|sha256:report\|sha256:chart"/);
});

test("stale and zero-trade result states remain explicit and explainable", () => {
  const context = renderToStaticMarkup(
    <ChartStrategyResultContextBar result={result} locale="zh-CN" stale />,
  );
  const overview = renderToStaticMarkup(
    <ChartStrategyResultOverview result={result} stale onOpenTrades={() => undefined} />,
  );
  assert.match(context, /结果已过期/);
  assert.match(overview, /需要重新运行/);
  assert.match(overview, /本次运行没有形成完整交易/);
  assert.match(overview, /这不是加载失败/);
});

test("trade explanation renders bounded decision-time and Host evidence", () => {
  const evidence = explanation();
  const html = renderToStaticMarkup(
    <TradeExplanationPopover
      selection={{ id: "fill-1", title: "Trade trade-1", items: [{ label: "Entry", explanation: evidence }] }}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /data-testid="trade-explanation-popover"/);
  assert.match(html, /COMPLETE/);
  assert.match(html, /fast &gt; slow/);
  assert.match(html, /FILLED/);
  assert.match(html, new RegExp(evidence.evidenceHash));
});

test("ordinary overview exposes directional deltas only for exact compatible Runs", () => {
  const compatible = renderToStaticMarkup(
    <ChartStrategyResultOverview
      result={result}
      stale={false}
      comparison={comparison(true)}
      onOpenTrades={() => undefined}
    />,
  );
  assert.match(compatible, /data-testid="chart-strategy-run-comparison"/);
  assert.match(compatible, /\+2 \/ −1/);
  assert.match(compatible, /backtest\.html\?run=bt_result_12345678&amp;compare=bt_baseline_12345678/);

  const incompatible = renderToStaticMarkup(
    <ChartStrategyResultOverview
      result={result}
      stale={false}
      comparison={comparison(false)}
      onOpenTrades={() => undefined}
    />,
  );
  assert.match(incompatible, /运行条件不一致，不显示方向性结论/);
  assert.doesNotMatch(incompatible, /chart-strategy-run-comparison-grid/);
  assert.doesNotMatch(incompatible, /新增 2/);
});
