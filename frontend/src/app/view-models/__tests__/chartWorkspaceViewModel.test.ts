import assert from "node:assert/strict";
import test from "node:test";

import { buildChartWorkspaceViewModel } from "../chartWorkspaceViewModel.js";
import { mustBeDefined, structuralMock } from "../../../test/testHelpers.js";

type WorkspaceContext = Parameters<typeof buildChartWorkspaceViewModel>[0];

interface ContextOverrides {
  chartSettings?: object;
  indicatorActions?: object;
  marketActions?: object;
  settingsActions?: object;
}

function buildContext({
  chartSettings = { chartType: "candlestick" },
  indicatorActions = {},
  marketActions = {},
  settingsActions = {},
}: ContextOverrides = {}): WorkspaceContext {
  return structuralMock<WorkspaceContext>({
    chartSettings: structuralMock<WorkspaceContext["chartSettings"]>(chartSettings),
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
    settingsActions,
    watchlistActions: {},
    watchlistView: {},
  });
}

test("chart type is controlled by persisted appearance settings and shared with the chart", () => {
  const updates: unknown[] = [];
  const model = buildChartWorkspaceViewModel(buildContext({
    settingsActions: { update: (settings: unknown) => { updates.push(settings); } },
  }));

  assert.equal(model.drawingToolbar.chartType, "candlestick");
  assert.equal(model.chart.chartProps.chartType, "candlestick");
  mustBeDefined(model.drawingToolbar.onChartTypeChange)("area");
  assert.deepEqual(updates, [{ chartType: "area" }]);
});

test("Point & Figure projection settings reach the chart surface", () => {
  const model = buildChartWorkspaceViewModel(buildContext({
    chartSettings: {
      chartType: "point-and-figure",
      pointFigureBoxSizeMode: "traditional",
      pointFigureAtrLength: 21,
      pointFigureBoxSize: 25,
      pointFigureReversalAmount: 4,
    },
  }));

  assert.deepEqual({
    chartType: model.chart.chartProps.chartType,
    mode: model.chart.chartProps.pointFigureBoxSizeMode,
    atrLength: model.chart.chartProps.pointFigureAtrLength,
    boxSize: model.chart.chartProps.pointFigureBoxSize,
    reversalAmount: model.chart.chartProps.pointFigureReversalAmount,
  }, {
    chartType: "point-and-figure",
    mode: "traditional",
    atrLength: 21,
    boxSize: 25,
    reversalAmount: 4,
  });
});

test("Kagi projection settings reach the chart surface", () => {
  const model = buildChartWorkspaceViewModel(buildContext({
    chartSettings: {
      chartType: "kagi",
      kagiReversalMode: "traditional",
      kagiAtrLength: 21,
      kagiReversalAmount: 25,
    },
  }));

  assert.deepEqual({
    chartType: model.chart.chartProps.chartType,
    mode: model.chart.chartProps.kagiReversalMode,
    atrLength: model.chart.chartProps.kagiAtrLength,
    reversalAmount: model.chart.chartProps.kagiReversalAmount,
  }, {
    chartType: "kagi",
    mode: "traditional",
    atrLength: 21,
    reversalAmount: 25,
  });
});

test("Line Break projection settings reach the chart surface", () => {
  const model = buildChartWorkspaceViewModel(buildContext({
    chartSettings: {
      chartType: "line-break",
      lineBreakNumberOfLines: 5,
    },
  }));

  assert.equal(model.chart.chartProps.chartType, "line-break");
  assert.equal(model.chart.chartProps.lineBreakNumberOfLines, 5);
});

test("chart range handlers separate indicator coverage from user persistence", () => {
  const indicatorRanges: unknown[] = [];
  const persistedRanges: unknown[] = [];
  const model = buildChartWorkspaceViewModel(buildContext({
    indicatorActions: {
      ensureVisibleIndicatorRange: (range: unknown) => { indicatorRanges.push(range); },
    },
    marketActions: {
      onVisibleRangeChange: (range: unknown) => { persistedRanges.push(range); },
    },
  }));
  const range = {
    logical: { from: -0.5, to: 1_500.5 },
    time: { from: 1_640_995_200, to: 1_770_652_800 },
  };

  mustBeDefined(model.chart.chartProps.onViewportRangeChange)(range);
  assert.deepEqual(indicatorRanges, [range]);
  assert.deepEqual(persistedRanges, []);

  mustBeDefined(model.chart.chartProps.onVisibleRangeChange)(range);
  assert.deepEqual(indicatorRanges, [range]);
  assert.deepEqual(persistedRanges, [range]);
});
