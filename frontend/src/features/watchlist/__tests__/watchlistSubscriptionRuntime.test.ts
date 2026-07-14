import assert from "node:assert/strict";
import test from "node:test";

import { parseWatchlistPriceTick } from "../watchlistSubscriptionRuntime.js";

test("watchlist price ticks omit malformed numeric fields", () => {
  assert.deepEqual(parseWatchlistPriceTick({
    symbol: "BTCUSDT",
    price: "bad",
    open: Number.POSITIVE_INFINITY,
    daily_change: null,
    daily_change_pct: "bad",
    change_pct: Number.NaN,
    source: "stream",
  }), {
    symbol: "BTCUSDT",
    source: "stream",
  });

  assert.deepEqual(parseWatchlistPriceTick({
    symbol: "BTCUSDT",
    price: 100,
    open: 90,
    daily_change: 10,
    daily_change_pct: 11.1,
    change_pct: 11.1,
  }), {
    symbol: "BTCUSDT",
    price: 100,
    open: 90,
    daily_change: 10,
    daily_change_pct: 11.1,
    change_pct: 11.1,
  });
});
