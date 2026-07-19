import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRADE_FLOW_PREFERENCES,
  loadTradeFlowPreferences,
} from "../tradeFlowPreferencesStore.js";

test("TradeFlow preferences reject unsupported filter and bubble thresholds", () => {
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
  assert.equal(preferences.enabled, true);
  assert.equal(preferences.dockView, "profile");
  assert.equal(preferences.sideFilter, "buy");
  assert.equal(preferences.minNotional, DEFAULT_TRADE_FLOW_PREFERENCES.minNotional);
  assert.equal(
    preferences.largeTradeNotional,
    DEFAULT_TRADE_FLOW_PREFERENCES.largeTradeNotional,
  );
});
