import assert from "node:assert/strict";
import test from "node:test";

import type { BacktestChartData, BacktestReport, BacktestRunRecord } from "../../backtestTypes.js";
import {
  ChartStrategyResultCache,
  ChartStrategyResultError,
} from "../chartStrategyResultCache.js";

function run(configHash = "sha256:config-1"): BacktestRunRecord {
  return {
    run_id: "bt_result_12345678",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: configHash,
    config_json: JSON.stringify({
      start_time_ms: 1_700_000_000_000,
      end_time_ms: 1_700_003_600_000,
      chart_range_mode: "ALL_AVAILABLE",
      fee_source: "BINANCE_SPOT_V1",
      taker_fee_bps: "10",
      maker_fee_bps: "10",
      slippage_bps: "2",
    }),
  };
}

function report(runId = "bt_result_12345678"): BacktestReport {
  return {
    schemaVersion: "1",
    runId,
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    report_label: "BAR_APPROX",
    hashes: { report: "sha256:report-1" },
    metrics: {
      fill_count: 0,
      ambiguity_count: 0,
      rejected_order_count: 0,
      trade_count: 0,
      winning_trade_count: 0,
      win_rate: "0",
      realized_net_pnl: "0",
    },
    unmodeled: [],
    suitable_for: [],
    not_suitable_for: [],
    fills: [],
    trades: [],
  };
}

function chart(runId = "bt_result_12345678"): BacktestChartData {
  return {
    run_id: runId,
    chart_hash: "sha256:chart-1",
    symbol: "BTCUSDT",
    interval: "1m",
    bars: [],
    fills: [],
    equity_curve: [],
    truncated: false,
  };
}

test("result cache binds Run, report, and chart hashes and reuses immutable entries", async () => {
  const cache = new ChartStrategyResultCache();
  const calls = { run: 0, report: 0, chart: 0 };
  const api = {
    async getRun() { calls.run += 1; return run(); },
    async getReport() { calls.report += 1; return report(); },
    async getChart() { calls.chart += 1; return chart(); },
  };
  const first = await cache.load(api, "bt_result_12345678");
  const second = await cache.load(api, "bt_result_12345678");
  assert.strictEqual(second, first);
  assert.equal(first.cacheKey, "bt_result_12345678|sha256:report-1|sha256:chart-1");
  assert.deepEqual(calls, { run: 2, report: 1, chart: 1 });
  assert.deepEqual(cache.diagnostics().keys, [first.cacheKey]);
});

test("result cache fails closed on cross-Run payloads and invalid completed config", async () => {
  const cache = new ChartStrategyResultCache();
  await assert.rejects(
    cache.load({
      async getRun() { return run(); },
      async getReport() { return report("bt_other_12345678"); },
      async getChart() { return chart(); },
    }, "bt_result_12345678"),
    (reason: unknown) => reason instanceof ChartStrategyResultError
      && reason.code === "RESULT_IDENTITY_MISMATCH",
  );
  await assert.rejects(
    cache.load({
      async getRun() { return { ...run("sha256:config-2"), config_json: "{}" }; },
      async getReport() { return report(); },
      async getChart() { return chart(); },
    }, "bt_result_12345678"),
    (reason: unknown) => reason instanceof ChartStrategyResultError
      && reason.code === "RESULT_RANGE_INVALID",
  );
});
