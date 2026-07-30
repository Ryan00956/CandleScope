import assert from "node:assert/strict";
import test from "node:test";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import {
  analyzeIndicatorLineCoverage,
  buildIndicatorRuntimeDiagnosticSnapshot,
} from "../indicatorRuntimeDiagnostics.js";

const chart = [100, 200, 300, 400, 500].map((time) => ({
  time,
  is_closed: true,
})) as KlineBar[];

test("indicator line diagnostics separate warmup, interior, and trailing gaps", () => {
  const coverage = analyzeIndicatorLineCoverage({
    id: "main",
    data: [
      { time: 200, value: 2 },
      { time: 400, value: 4 },
    ],
  }, chart.map((bar) => Number(bar.time)));

  assert.equal(coverage.leadingMissingBars, 1);
  assert.equal(coverage.interiorMissingBars, 1);
  assert.deepEqual(coverage.interiorMissingRanges, [{
    start: 300,
    end: 300,
    missingBars: 1,
  }]);
  assert.equal(coverage.trailingMissingBars, 1);
  assert.equal(coverage.status, "gapped");
});

test("runtime diagnostics ignore a forming chart bar for closed-history coverage", () => {
  const snapshot = buildIndicatorRuntimeDiagnosticSnapshot({
    activeIndicators: [{
      id: "vol",
      name: "Volume",
      visible: true,
      lines: [{
        id: "volume",
        data: [100, 200, 300, 400].map((time) => ({ time, value: time })),
      }],
    }],
    chartData: chart.map((bar, index) => ({
      ...bar,
      is_closed: index < chart.length - 1,
    })) as KlineBar[],
    context: {
      exchange: "binance",
      interval: "1m",
      marketType: "spot",
      sessionKey: "chart",
      symbol: "BTCUSDT",
    },
    state: {
      initialHistoryPending: false,
      initialHydrationSettled: true,
    },
  }, () => 1234);

  assert.equal(snapshot.capturedAtMs, 1234);
  assert.equal(snapshot.chart.barCount, 5);
  assert.equal(snapshot.chart.closedBarCount, 4);
  assert.equal(snapshot.indicators.at(0)?.status, "ok");
  assert.deepEqual(snapshot.issues, []);
});

test("runtime diagnostics expose pending gates without treating normal loading as a gap", () => {
  const snapshot = buildIndicatorRuntimeDiagnosticSnapshot({
    activeIndicators: [{ id: "rsi", visible: true, lines: [] }],
    chartData: chart,
    context: {
      exchange: "binance",
      interval: "1m",
      marketType: "spot",
      sessionKey: "chart",
      symbol: "BTCUSDT",
    },
    state: {
      historyWindowPending: true,
      initialHistoryPending: true,
      initialHydrationSettled: false,
    },
  });

  assert.equal(snapshot.indicators.at(0)?.status, "no-data");
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(snapshot.gates, [
    "initial-history-pending",
    "history-window-pending",
    "initial-hydration-unsettled",
  ]);
});

test("runtime diagnostics flag no data after chart and hydration are settled", () => {
  const snapshot = buildIndicatorRuntimeDiagnosticSnapshot({
    activeIndicators: [{ id: "rsi", visible: true, lines: [] }],
    chartData: chart,
    context: {
      exchange: "binance",
      interval: "1m",
      marketType: "spot",
      sessionKey: "chart",
      symbol: "BTCUSDT",
    },
    state: {
      chartDataReady: true,
      initialHydrationSettled: true,
    },
  });

  assert.deepEqual(snapshot.gates, []);
  assert.deepEqual(snapshot.issues, ["visible-indicator-no-data"]);
});
