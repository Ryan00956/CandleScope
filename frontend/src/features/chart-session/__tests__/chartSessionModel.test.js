import assert from "node:assert/strict";
import test from "node:test";

import {
  loadInitialChartSession,
  loadUserPrefs,
  updateUserPref,
  USER_PREFS_KEY,
} from "../chartSessionModel.js";
import { withLocalStorage } from "./localStorageHarness.js";

test("corrupt or non-object user prefs fall back to an empty record", () => {
  for (const raw of ["{broken", "null", "[]"]) {
    withLocalStorage({ [USER_PREFS_KEY]: raw }, () => {
      assert.deepEqual(loadUserPrefs(), {});
      assert.deepEqual(loadInitialChartSession(), {
        symbol: "BTCUSDT",
        exchange: "binance",
        marketType: "spot",
        interval: "1h",
      });
    });
  }
});

test("initial session keeps valid month intervals and infers an omitted exchange", () => {
  withLocalStorage({
    [USER_PREFS_KEY]: JSON.stringify({
      lastSymbol: "BTC-USDT",
      lastMarketType: "spot",
      lastInterval: "1M",
    }),
  }, () => {
    assert.deepEqual(loadInitialChartSession(), {
      symbol: "BTC-USDT",
      exchange: "okx",
      marketType: "spot",
      interval: "1M",
    });
  });
});

test("invalid stored interval and identity fields use stable defaults", () => {
  withLocalStorage({
    [USER_PREFS_KEY]: JSON.stringify({
      lastSymbol: "BTCUSDT",
      lastExchange: { invalid: true },
      lastMarketType: "",
      lastInterval: "1H",
    }),
  }, () => {
    assert.deepEqual(loadInitialChartSession(), {
      symbol: "BTCUSDT",
      exchange: "binance",
      marketType: "spot",
      interval: "1h",
    });
  });
});

test("updating one user preference preserves the remaining record", () => {
  withLocalStorage({
    [USER_PREFS_KEY]: JSON.stringify({ lastSymbol: "ETHUSDT" }),
  }, (storage) => {
    updateUserPref("lastInterval", "15m");
    assert.deepEqual(JSON.parse(storage.getItem(USER_PREFS_KEY)), {
      lastSymbol: "ETHUSDT",
      lastInterval: "15m",
    });
  });
});
