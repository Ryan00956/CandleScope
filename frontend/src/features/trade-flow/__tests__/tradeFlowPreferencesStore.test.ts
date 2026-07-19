import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRADE_FLOW_PREFERENCES,
  loadTradeFlowPreferences,
} from "../tradeFlowPreferencesStore.js";

test("legacy TradeFlow workspace migrates both chart indicators", () => {
  const storage = {
    getItem: () => JSON.stringify({
      enabled: true,
      dockView: "profile",
      sideFilter: "buy",
      minNotional: 12_345,
      largeTradeNotional: 0,
    }),
    setItem() {},
  };
  const preferences = loadTradeFlowPreferences(storage);
  assert.equal(preferences.dockView, "profile");
  assert.deepEqual(preferences.indicators, {
    cvd: { added: true, visible: true },
    delta: { added: true, visible: true },
  });
  assert.equal(preferences.sideFilter, "buy");
  assert.equal(preferences.minNotional, DEFAULT_TRADE_FLOW_PREFERENCES.minNotional);
  assert.equal(
    preferences.largeTradeNotional,
    DEFAULT_TRADE_FLOW_PREFERENCES.largeTradeNotional,
  );
});

test("TradeFlow v2 keeps right rail and chart indicator selections independent", () => {
  const storage = {
    getItem: () => JSON.stringify({
      dockView: "order-book",
      indicators: {
        cvd: { added: true, visible: false },
        delta: { added: false, visible: true },
      },
      sideFilter: "all",
      minNotional: 0,
      largeTradeNotional: 100_000,
    }),
    setItem() {},
  };

  const preferences = loadTradeFlowPreferences(storage);
  assert.equal(preferences.dockView, "order-book");
  assert.deepEqual(preferences.indicators, {
    cvd: { added: true, visible: false },
    delta: { added: false, visible: false },
  });
});
