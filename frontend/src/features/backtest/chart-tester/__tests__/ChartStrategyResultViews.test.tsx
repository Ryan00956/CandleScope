import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChartStrategyResultBundle } from "../chartStrategyResultCache.js";
import {
  ChartStrategyResultContextBar,
  ChartStrategyResultOverview,
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
