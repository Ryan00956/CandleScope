import assert from "node:assert/strict";
import test from "node:test";

import { structuralMock } from "../../../test/testHelpers.js";
import { buildLazySurfaceViewModel } from "../lazySurfaceViewModel.js";

type LazyContext = Parameters<typeof buildLazySurfaceViewModel>[0];

test("indicator panel receives capability-aware market studies and routed actions", () => {
  const calls: string[] = [];
  const context = structuralMock<LazyContext>({
    advancedMarketActions: {
      addMarketStudy: (id: string) => calls.push(`add:${id}`),
      removeMarketStudy: (id: string) => calls.push(`remove:${id}`),
      toggleMarketStudyVisibility: (id: string) => calls.push(`toggle:${id}`),
    },
    advancedMarketView: {
      marketStudies: [
        {
          id: "market:funding-rate",
          channel: "funding_rate",
          name: "资金费率",
          description: "Funding",
          category: "contract-data",
          paneTarget: "sub",
          added: true,
          visible: false,
          supported: false,
          supportReason: "仅合约市场支持",
          status: "unavailable",
          error: null,
        },
      ],
    },
    alertsActions: {},
    alertsView: {},
    chartSettings: {},
    displayData: null,
    indicatorActions: {},
    indicatorComputing: false,
    indicatorView: { activeIndicators: [], paramSchemas: {}, isPanelOpen: true },
    marketStatus: {},
    marketView: {},
    sessionView: {
      symbol: "BTCUSDT",
      exchange: "binance",
      marketType: "spot",
      interval: "1m",
    },
    settingsActions: {},
    settingsView: {},
    tradeFlowActions: {
      addIndicator: (id: string) => calls.push(`add:${id}`),
      removeIndicator: (id: string) => calls.push(`remove:${id}`),
      toggleIndicatorVisibility: (id: string) => calls.push(`toggle:${id}`),
    },
    tradeFlowView: {
      supported: true,
      supportMessage: null,
      preferences: {
        indicators: {
          cvd: { added: true, visible: false },
          delta: { added: false, visible: false },
        },
      },
    },
    watchlistView: { watchlists: [] },
  });

  const panel = buildLazySurfaceViewModel(context).indicatorPanel;
  assert.deepEqual(panel.marketStudies?.[0], {
    id: "market:funding-rate",
    name: "资金费率",
    description: "Funding",
    category: "contract-data",
    added: true,
    visible: false,
    supported: false,
    unsupportedReason: "仅合约市场支持",
    status: "dormant",
    statusText: "仅合约市场支持",
    error: null,
  });
  assert.deepEqual(panel.marketStudies?.[1], {
    id: "trade-flow:cvd",
    name: "CVD（累计成交量差）",
    description: "基于 K 线主动买卖量构建的连续前缀和；与右侧实时订单流独立。",
    category: "volume",
    added: true,
    visible: false,
    supported: true,
    unsupportedReason: null,
    status: "dormant",
    statusText: "已隐藏；右侧成交/分布视图不受影响",
    error: null,
  });

  panel.onAddMarketStudy?.("market:funding-rate");
  panel.onRemoveMarketStudy?.("market:funding-rate");
  panel.onToggleMarketStudyVisibility?.("market:funding-rate");
  panel.onAddMarketStudy?.("trade-flow:delta");
  panel.onRemoveMarketStudy?.("trade-flow:cvd");
  panel.onToggleMarketStudyVisibility?.("trade-flow:cvd");
  panel.onAddMarketStudy?.("unknown");
  assert.deepEqual(calls, [
    "add:market:funding-rate",
    "remove:market:funding-rate",
    "toggle:market:funding-rate",
    "add:trade-flow:delta",
    "remove:trade-flow:cvd",
    "toggle:trade-flow:cvd",
  ]);
});

test("hidden liquidation study reports that collection continues", () => {
  const context = structuralMock<LazyContext>({
    advancedMarketActions: {},
    advancedMarketView: {
      marketStudies: [{
        id: "market:liquidations",
        channel: "liquidation",
        name: "观测爆仓额",
        description: "Liquidations",
        category: "contract-data",
        paneTarget: "sub",
        added: true,
        visible: false,
        supported: true,
        supportReason: null,
        status: "hidden",
        error: null,
      }],
    },
    alertsActions: {},
    alertsView: {},
    chartSettings: {},
    displayData: null,
    indicatorActions: {},
    indicatorComputing: false,
    indicatorView: { activeIndicators: [], paramSchemas: {}, isPanelOpen: true },
    marketStatus: {},
    marketView: {},
    sessionView: {
      symbol: "BTCUSDT",
      exchange: "binance",
      marketType: "futures",
      interval: "1h",
    },
    settingsActions: {},
    settingsView: {},
    tradeFlowActions: {},
    tradeFlowView: {
      supported: true,
      supportMessage: null,
      preferences: {
        indicators: {
          cvd: { added: false, visible: false },
          delta: { added: false, visible: false },
        },
      },
    },
    watchlistView: { watchlists: [] },
  });

  const study = buildLazySurfaceViewModel(context).indicatorPanel.marketStudies?.[0];
  assert.equal(study?.status, "ready");
  assert.equal(study?.statusText, "已隐藏，仍在后台采集观测爆仓");
});
