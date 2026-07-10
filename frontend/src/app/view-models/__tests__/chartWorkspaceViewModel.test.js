import assert from "node:assert/strict";
import test from "node:test";

import { buildChartWorkspaceViewModel } from "../chartWorkspaceViewModel.js";

function buildContext({ indicatorActions = {}, marketActions = {} } = {}) {
  return {
    chartSettings: {},
    drawingActions: {},
    drawingView: {},
    exportActions: {},
    exportInProgress: false,
    exportView: {},
    indicatorActions,
    indicatorComputing: false,
    indicatorView: {},
    marketActions,
    marketStatus: {},
    marketView: {},
    priceScaleActions: {},
    priceScaleView: {},
    resolvedTheme: "dark",
    sessionActions: {},
    sessionView: {
      datasetKey: "binance::spot::BTCUSDT::1d",
      exchange: "binance",
      interval: "1d",
      marketType: "spot",
      symbol: "BTCUSDT",
    },
    watchlistActions: {},
    watchlistView: {},
  };
}

test("chart range handlers separate indicator coverage from user persistence", () => {
  const indicatorRanges = [];
  const persistedRanges = [];
  const model = buildChartWorkspaceViewModel(buildContext({
    indicatorActions: {
      ensureVisibleIndicatorRange: (range) => indicatorRanges.push(range),
    },
    marketActions: {
      onVisibleRangeChange: (range) => persistedRanges.push(range),
    },
  }));
  const range = {
    logical: { from: -0.5, to: 1_500.5 },
    time: { from: 1_640_995_200, to: 1_770_652_800 },
  };

  model.chart.chartProps.onViewportRangeChange(range);
  assert.deepEqual(indicatorRanges, [range]);
  assert.deepEqual(persistedRanges, []);

  model.chart.chartProps.onVisibleRangeChange(range);
  assert.deepEqual(indicatorRanges, [range]);
  assert.deepEqual(persistedRanges, [range]);
});
