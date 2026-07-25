import assert from "node:assert/strict";
import test from "node:test";

import { buildChartWorkspaceViewModel } from "../chartWorkspaceViewModel.js";
import { drawingToolWhenInteractionReady } from "../../drawingInteractionReadiness.js";
import { mustBeDefined, structuralMock } from "../../../test/testHelpers.js";

type WorkspaceContext = Parameters<typeof buildChartWorkspaceViewModel>[0];

test("drawing engine tools stay inactive until pane pointer listeners are ready", () => {
  assert.equal(drawingToolWhenInteractionReady("pen", false), null);
  assert.equal(drawingToolWhenInteractionReady("line-segment", false), null);
  assert.equal(drawingToolWhenInteractionReady("pen", true), "pen");
  assert.equal(drawingToolWhenInteractionReady("cursor-crosshair", false), "cursor-crosshair");
  assert.equal(drawingToolWhenInteractionReady(null, false), null);
});

interface ContextOverrides {
  advancedMarketActions?: object;
  chartSettings?: object;
  drawingActions?: object;
  drawingView?: object;
  indicatorActions?: object;
  marketActions?: object;
  marketStatus?: object;
  settingsActions?: object;
  tradeFlowActions?: object;
  watchlistView?: object;
}

function buildContext({
  advancedMarketActions = {},
  chartSettings = { chartType: "candlestick" },
  drawingActions = {},
  drawingView = {},
  indicatorActions = {},
  marketActions = {},
  marketStatus = {},
  settingsActions = {},
  tradeFlowActions = {},
  watchlistView = {},
}: ContextOverrides = {}): WorkspaceContext {
  return structuralMock<WorkspaceContext>({
    chartSettings: structuralMock<WorkspaceContext["chartSettings"]>(chartSettings),
    advancedMarketActions,
    advancedMarketView: {
      enabled: false,
      identity: { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
      identityKey: "binance:spot:BTCUSDT",
      seriesStore: null,
    },
    drawingActions,
    drawingView,
    exportActions: {},
    exportInProgress: false,
    exportView: {},
    indicatorActions,
    indicatorComputing: false,
    indicatorView: {},
    marketActions,
    marketStatus,
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
    tradeFlowActions,
    tradeFlowStatus: { enabled: false },
    tradeFlowView: {},
    watchlistActions: {},
    watchlistView,
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
  const advancedRanges: unknown[] = [];
  const persistedRanges: unknown[] = [];
  const model = buildChartWorkspaceViewModel(buildContext({
    advancedMarketActions: {
      ensureVisibleRange: (range: unknown) => { advancedRanges.push(range); },
    },
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
  assert.deepEqual(advancedRanges, [range]);
  assert.deepEqual(persistedRanges, []);

  mustBeDefined(model.chart.chartProps.onVisibleRangeChange)(range);
  assert.deepEqual(indicatorRanges, [range]);
  assert.deepEqual(persistedRanges, [range]);
});

test("continuous drawing preference is shared by the toolbar and drawing surface", () => {
  const changes: boolean[] = [];
  const model = buildChartWorkspaceViewModel(buildContext({
    drawingActions: {
      handleDrawingContinuousEnabledChange: (enabled: boolean) => { changes.push(enabled); },
    },
    drawingView: {
      drawingContinuousEnabled: true,
    },
  }));

  assert.equal(model.drawingToolbar.drawingContinuousEnabled, true);
  assert.equal(model.chart.chartProps.drawingContinuousEnabled, true);
  mustBeDefined(model.drawingToolbar.onDrawingContinuousEnabledChange)(false);
  assert.deepEqual(changes, [false]);
});

test("latest-window recovery reaches the chart surface", () => {
  const restoreLatestWindow = async () => true;
  const model = buildChartWorkspaceViewModel(buildContext({
    marketActions: { restoreLatestWindow },
  }));

  assert.equal(model.chart.chartProps.onNeedMoreRight, restoreLatestWindow);
});

test("latest-window recovery is gated while left history owns the runtime", () => {
  const model = buildChartWorkspaceViewModel(buildContext({
    marketActions: { restoreLatestWindow: async () => true },
    marketStatus: { canRestoreLatestWindow: false },
  }));

  assert.equal(model.chart.chartProps.canRestoreLatestWindow, false);
});

test("watchlist workspace receives the stable external price store handle", () => {
  const priceStore = {
    getSnapshot: () => ({}),
    getSymbolSnapshot: () => undefined,
    subscribe: () => () => {},
    subscribeSymbol: () => () => {},
  };
  const model = buildChartWorkspaceViewModel(buildContext({
    watchlistView: { priceStore },
  }));

  assert.equal(model.watchlist.priceStore, priceStore);
  assert.equal("prices" in model.watchlist, false);
});

test("pane delete controls dispatch to the owning indicator or market study", () => {
  const removed: string[] = [];
  const model = buildChartWorkspaceViewModel(buildContext({
    advancedMarketActions: {
      removeMarketStudy: (id: string) => { removed.push(`market:${id}`); },
    },
    indicatorActions: {
      removeIndicator: (id: string) => { removed.push(`indicator:${id}`); },
    },
    tradeFlowActions: {
      removeIndicator: (id: string) => { removed.push(`trade-flow:${id}`); },
    },
  }));
  const removePane = mustBeDefined(model.chart.chartProps.onRemoveSubPane);

  removePane({
    id: "separate-rsi",
    label: "RSI",
    lines: [],
    owner: { kind: "indicator", id: "rsi" },
  });
  removePane({
    id: "advanced-funding",
    label: "资金费率 (%)",
    lines: [],
    owner: { kind: "market-study", id: "market:funding-rate" },
  });
  removePane({
    id: "unknown",
    label: "Unknown",
    lines: [],
    owner: { kind: "market-study", id: "not-a-market-study" },
  });
  removePane({
    id: "trade-flow-cvd",
    label: "CVD",
    lines: [],
    owner: { kind: "trade-flow", id: "trade-flow:cvd" },
  });
  removePane({
    id: "unknown-trade-flow",
    label: "Unknown",
    lines: [],
    owner: { kind: "trade-flow", id: "workspace" },
  });

  assert.deepEqual(removed, [
    "indicator:rsi",
    "market:market:funding-rate",
    "trade-flow:trade-flow:cvd",
  ]);
});
