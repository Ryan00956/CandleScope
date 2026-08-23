import assert from "node:assert/strict";
import test from "node:test";

import type { BacktestChartData, BacktestReport } from "../../backtestTypes.js";
import {
  boundBacktestProjectionRows,
  projectBacktestReportSummary,
  projectBacktestResultMarkers,
  projectDrawdownPolyline,
  projectEquityPolyline,
  projectFocusedTrade,
} from "../chartStrategyResultProjection.js";

function chart(): BacktestChartData {
  return {
    run_id: "bt_1",
    symbol: "BTCUSDT",
    interval: "1m",
    bars: [],
    fills: [
      { order_id: "buy-1", event_time_ms: "65000", side: "buy", action: "OPEN_LONG", price: "100" },
      { order_id: "sell-1", event_time_ms: "125000", side: "SELL", action: "CLOSE_LONG", price: "110" },
      { order_id: "off-axis", event_time_ms: "185000", side: "BUY", action: "ADD_LONG", price: "105" },
    ],
    rejected_orders: [
      { sequence: 9, event_time_ms: 65_000, reason_code: "RISK_LIMIT" },
    ],
    equity_curve: [],
    truncated: false,
  };
}

test("marker golden preserves time, direction, text, ordering and same-time rejection", () => {
  const markers = projectBacktestResultMarkers(chart(), {
    hasTime: (time) => time === 60 || time === 120,
    labels: {
      actions: { OPEN_LONG: "Open long", CLOSE_LONG: "Close long", ADD_LONG: "Add long" },
      rejection: "Rejected",
    },
  });
  assert.deepEqual(markers, [
    { id: "backtest:buy-1:0", time: 60, position: "belowBar", color: "#22c55e", shape: "arrowUp", text: "Open long 100", size: 1.2 },
    { id: "backtest:sell-1:1", time: 120, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "Close long 110", size: 1.2 },
    { id: "backtest:rejected:9:0", time: 60, position: "aboveBar", color: "#f59e0b", shape: "square", text: "Rejected", size: 1 },
  ]);
  assert.equal(markers.filter((marker) => marker.time === 60).length, 2);
});

test("equity and drawdown projections are deterministic and bounded", () => {
  assert.equal(projectEquityPolyline([
    { equity: "100" }, { equity: "110" }, { equity: "90" },
  ]), "0.00,105.00 500.00,20.00 1000.00,190.00");
  assert.equal(projectDrawdownPolyline([
    { drawdown: "-0.1" }, { drawdown: "-0.2" }, { drawdown: "0" },
  ]), "0.00,147.50 500.00,190.00 1000.00,105.00");
  assert.equal(projectEquityPolyline([{ equity: "100" }]), "");
  assert.equal(projectDrawdownPolyline([{ drawdown: "bad" }, { drawdown: "0" }]), "");

  const source = Array.from({ length: 5_001 }, (_item, index) => index);
  const bounded = boundBacktestProjectionRows(source);
  assert.ok(bounded.length <= 2_000);
  assert.equal(bounded.at(-1), 5_000);
  assert.deepEqual(boundBacktestProjectionRows(source.slice(0, 10)), source.slice(0, 10));
});

test("report summary keeps the legacy four visible values", () => {
  const report: BacktestReport = {
    schemaVersion: "candlescope.backtest-report/1",
    runId: "bt_1",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    report_label: "APPROXIMATE",
    hashes: { report: "sha256:report" },
    metrics: {
      fill_count: 3,
      ambiguity_count: 0,
      rejected_order_count: 0,
      trade_count: 2,
      winning_trade_count: 1,
      win_rate: "0.5",
      realized_net_pnl: "42.5",
    },
    account: { equity: "10042.5" },
    unmodeled: [],
    suitable_for: [],
    not_suitable_for: [],
    fills: [],
    trades: [],
  };
  assert.deepEqual(projectBacktestReportSummary(report), {
    reportLabel: "APPROXIMATE",
    fillCount: 3,
    tradeCount: 2,
    finalEquity: "10042.5",
  });
});

test("focused trade view model preserves reasons and explicit decision/accept/fill clocks", () => {
  const projected = projectFocusedTrade([{
    trade_id: "trade-1",
    entry_price: "100",
    exit_price: "110",
    mae: "-2",
    mfe: "12",
    entry_reason: "RSI_ENTER",
    exit_reason: "RSI_EXIT",
    decision_time_ms: "1000",
    order_accepted_time_ms: "1005",
    entry_time_ms: "1010",
    fees: "1",
    funding: "0.2",
  }], "trade-1");
  assert.deepEqual(projected, {
    tradeId: "trade-1",
    entryPrice: "100",
    exitPrice: "110",
    mae: "-2",
    mfe: "12",
    entryReason: "RSI_ENTER",
    exitReason: "RSI_EXIT",
    decisionTimeMs: 1_000,
    acceptedTimeMs: 1_005,
    fillTimeMs: 1_010,
    chartFocusTimeMs: 1_010,
    fees: "1",
    funding: "0.2",
  });
  assert.equal(projectFocusedTrade([], "missing"), null);
});

test("focused trade clocks fall back to fill time without inventing a reason", () => {
  const projected = projectFocusedTrade([{
    trade_id: "trade-2",
    entry_time_ms: "2020",
  }], "trade-2");
  assert.equal(projected?.decisionTimeMs, 2_020);
  assert.equal(projected?.acceptedTimeMs, 2_020);
  assert.equal(projected?.fillTimeMs, 2_020);
  assert.equal(projected?.entryReason, "—");
  assert.equal(projected?.exitReason, "—");
});
