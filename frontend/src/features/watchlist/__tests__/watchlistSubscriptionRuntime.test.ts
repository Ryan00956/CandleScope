import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWatchlistPriceTick,
  resolveWatchlistFullSubscriptionInputs,
} from "../watchlistSubscriptionRuntime.js";
import { buildExchangeCatalog } from "../../chart-session/exchangeCatalogRuntime.js";
import type { CustomIntervalRecord } from "../../chart-session/chartSessionTypes.js";

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

test("watchlist full subscriptions use each symbol's realtime market capability", () => {
  const exchangeCatalog = buildExchangeCatalog([{
    exchange: "binance",
    name: "Binance",
    capability_schema_version: 3,
    markets: [
      { market_type: "spot", product_type: "spot", label: "Spot" },
      { market_type: "futures", product_type: "perpetual", label: "Futures" },
    ],
    native_intervals: ["1s", "1m"],
    channels: [
      {
        channel: "kline",
        market_types: ["spot"],
        history: true,
        realtime: true,
        params: { interval: ["1s", "1m"] },
      },
      {
        channel: "kline",
        market_types: ["futures"],
        history: true,
        realtime: false,
        params: { interval: ["1m"] },
      },
    ],
    protocol_features: [],
    limits: {},
    known_limitations: [],
  }]);
  const custom: CustomIntervalRecord[] = [{
    value: "45m",
    createdAt: 1,
    lastUsedAt: 1,
    usageCount: 1,
    pinned: false,
    order: 0,
  }];

  assert.deepEqual(
    resolveWatchlistFullSubscriptionInputs("spot:BTCUSDT", exchangeCatalog, custom),
    {
      nativeIntervals: [
        { value: "1s", label: "1s", seconds: 1 },
        { value: "1m", label: "1m", seconds: 60 },
      ],
      customIntervalRecords: custom,
    },
  );
  assert.deepEqual(
    resolveWatchlistFullSubscriptionInputs("binance:futures:BTCUSDT", exchangeCatalog, custom),
    { nativeIntervals: [], customIntervalRecords: [] },
  );
});
