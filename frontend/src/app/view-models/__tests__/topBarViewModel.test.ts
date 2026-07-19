import assert from "node:assert/strict";
import test from "node:test";

import { structuralMock } from "../../../test/testHelpers.js";
import { buildTopBarViewModel } from "../topBarViewModel.js";

type TopBarContext = Parameters<typeof buildTopBarViewModel>[0];

test("top bar indicator count includes added market-data studies", () => {
  const toggleOrderFlow = () => undefined;
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
    tradeFlowActions: {
      toggleEnabled: toggleOrderFlow,
    },
    tradeFlowView: {
      preferences: {
        enabled: true,
      },
    },
    watchlistActions: {},
    watchlistView: { watchlists: [] },
  });

  const model = buildTopBarViewModel(context);
  assert.equal(model.controls.activeIndicatorCount, 3);
  assert.equal(model.controls.orderFlowEnabled, true);
  assert.equal(model.controls.onToggleOrderFlow, toggleOrderFlow);
});
