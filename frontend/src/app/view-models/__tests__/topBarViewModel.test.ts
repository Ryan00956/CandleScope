import assert from "node:assert/strict";
import test from "node:test";

import { structuralMock } from "../../../test/testHelpers.js";
import { buildTopBarViewModel } from "../topBarViewModel.js";

type TopBarContext = Parameters<typeof buildTopBarViewModel>[0];

test("top bar indicator count includes added market-data studies", () => {
  const context = structuralMock<TopBarContext>({
    advancedMarketView: {
      marketStudies: [
        { added: true },
        { added: false },
      ],
    },
    alertsActions: {},
    alertsView: {},
    indicatorActions: {},
    indicatorView: {
      activeIndicators: [{ id: "rsi" }, { id: "macd" }],
      isPanelOpen: false,
    },
    marketDisplay: {},
    sessionActions: {},
    sessionView: {
      symbol: "BTCUSDT",
      exchange: "binance",
      marketType: "futures",
      exchangeCatalog: {},
    },
    settingsActions: {},
    tradeFlowView: {
      preferences: {
        indicators: {
          cvd: { added: true, visible: true },
          delta: { added: false, visible: false },
        },
      },
    },
    watchlistActions: {},
    watchlistView: { watchlists: [] },
  });

  const model = buildTopBarViewModel(context);
  assert.equal(model.controls.activeIndicatorCount, 4);
  assert.equal("orderFlowEnabled" in model.controls, false);
  assert.equal("onToggleOrderFlow" in model.controls, false);
});
