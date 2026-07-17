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
    watchlistView: { watchlists: [] },
  });

  const panel = buildLazySurfaceViewModel(context).indicatorPanel;
  assert.deepEqual(panel.marketStudies?.[0], {
    id: "market:funding-rate",
    name: "资金费率",
    description: "Funding",
    added: true,
    visible: false,
    supported: false,
    unsupportedReason: "仅合约市场支持",
    status: "dormant",
    statusText: "仅合约市场支持",
    error: null,
  });

  panel.onAddMarketStudy?.("market:funding-rate");
  panel.onRemoveMarketStudy?.("market:funding-rate");
  panel.onToggleMarketStudyVisibility?.("market:funding-rate");
  panel.onAddMarketStudy?.("unknown");
  assert.deepEqual(calls, [
    "add:market:funding-rate",
    "remove:market:funding-rate",
    "toggle:market:funding-rate",
  ]);
});
