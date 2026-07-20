import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFullCachePreloadJobs,
  buildWatchlistFullCacheTargets,
  buildWatchlistFullSocketTargets,
  prioritizeFullCacheIntervals,
} from "../watchlistFullCachePolicy.js";
import type {
  FullCacheTarget,
  FullCacheTargetOptions,
} from "../watchlistFullCacheTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";
import { buildExchangeCatalog } from "../../chart-session/exchangeCatalogRuntime.js";

test("prioritizeFullCacheIntervals puts current and common intervals first", () => {
  assert.deepEqual(
    prioritizeFullCacheIntervals(["30m", "45m", "1h", "4h", "1d"], "45m", 4),
    ["45m", "1h", "4h", "1d"],
  );
});

test("buildWatchlistFullCacheTargets includes only full subscriptions", () => {
  const targets = buildWatchlistFullCacheTargets({
    watchlists: [
      {
        id: "default",
        name: "Watchlist",
        color: "#3b82f6",
        symbols: ["spot:BTCUSDT", "okx:spot:ETH-USDT", "spot:BNBUSDT"],
      },
    ],
    subscriptionTiers: {
      "spot:BTCUSDT": "full",
      "okx:spot:ETH-USDT": "price",
      "spot:BNBUSDT": "none",
    },
    nativeIntervals: [{ value: "1m" }, { value: "1h" }],
    customIntervalRecords: [{ value: "45m" }],
    currentSession: {
      exchange: "binance",
      symbolKey: "spot:BTCUSDT",
      interval: "1h",
    },
  });

  assert.equal(targets.length, 1);
  const target = mustBeDefined(targets[0]);
  assert.equal(target.symbolKey, "spot:BTCUSDT");
  assert.deepEqual(target.intervals, ["1m", "1h", "45m"]);
  assert.deepEqual(target.preloadIntervals, ["1h", "1m", "45m"]);
});

test("buildFullCachePreloadJobs prioritizes current symbol and caps work", () => {
  const targets: FullCacheTarget[] = [
    {
      symbolKey: "spot:ETHUSDT",
      symbol: "ETHUSDT",
      exchange: "binance",
      marketType: "spot",
      intervals: ["1m", "1h"],
      preloadIntervals: ["1m", "1h"],
    },
    {
      symbolKey: "spot:BTCUSDT",
      symbol: "BTCUSDT",
      exchange: "binance",
      marketType: "spot",
      intervals: ["1h", "4h"],
      preloadIntervals: ["1h", "4h"],
    },
  ];
  const jobs = buildFullCachePreloadJobs(targets, {
    currentSymbolKey: "spot:BTCUSDT",
    maxJobs: 3,
  });

  assert.deepEqual(
    jobs.map((job) => `${job.symbolKey}:${job.interval}`),
    ["spot:BTCUSDT:1h", "spot:BTCUSDT:4h", "spot:ETHUSDT:1m"],
  );
});

test("buildFullCachePreloadJobs excludes the active series before applying the cap", () => {
  const activeSymbolKey = "binance:futures:BTCUSDT";
  const targets: FullCacheTarget[] = [{
    symbolKey: activeSymbolKey,
    symbol: "BTCUSDT",
    exchange: "binance",
    marketType: "futures",
    intervals: ["45m", "1m", "5m", "15m"],
    preloadIntervals: ["45m", "1m", "5m", "15m"],
  }];

  const jobs = buildFullCachePreloadJobs(targets, {
    currentSymbolKey: activeSymbolKey,
    excludeSeries: { symbolKey: activeSymbolKey, interval: "45m" },
    maxJobs: 3,
  });

  assert.deepEqual(jobs.map((job) => job.interval), ["1m", "5m", "15m"]);
});

test("buildWatchlistFullSocketTargets ignores current interval priority", () => {
  const exchangeCatalog = buildExchangeCatalog([{
    exchange: "binance",
    name: "Binance",
    capability_schema_version: 3,
    markets: [{ market_type: "spot", product_type: "spot", label: "Spot" }],
    native_intervals: ["1m", "1h"],
    channels: [{
      channel: "kline",
      market_types: ["spot"],
      history: true,
      realtime: true,
      params: { interval: ["1m", "1h"] },
    }],
    protocol_features: [],
    limits: {},
    known_limitations: [],
  }]);
  const base: Omit<FullCacheTargetOptions, "currentSession"> = {
    watchlists: [
      {
        id: "default",
        name: "Watchlist",
        color: "#3b82f6",
        symbols: ["spot:BTCUSDT"],
      },
    ],
    subscriptionTiers: {
      "spot:BTCUSDT": "full",
    },
    nativeIntervals: [{ value: "1m" }, { value: "1h" }],
    exchangeCatalog,
    customIntervalRecords: [{ value: "45m" }],
  };
  const oneHourTargets = buildWatchlistFullCacheTargets({
    ...base,
    currentSession: {
      exchange: "binance",
      symbolKey: "spot:BTCUSDT",
      interval: "1h",
    },
  });
  const customTargets = buildWatchlistFullCacheTargets({
    ...base,
    currentSession: {
      exchange: "binance",
      symbolKey: "spot:BTCUSDT",
      interval: "45m",
    },
  });
  const oneHourSocketTargets = buildWatchlistFullSocketTargets({
    ...base,
    currentSession: {
      exchange: "binance",
      symbolKey: "spot:BTCUSDT",
      interval: "1h",
    },
  });
  const customSocketTargets = buildWatchlistFullSocketTargets({
    ...base,
    currentSession: {
      exchange: "binance",
      symbolKey: "spot:BTCUSDT",
      interval: "45m",
    },
  });

  assert.notDeepEqual(
    mustBeDefined(oneHourTargets[0]).preloadIntervals,
    mustBeDefined(customTargets[0]).preloadIntervals,
  );
  assert.deepEqual(oneHourSocketTargets, customSocketTargets);
  assert.deepEqual(mustBeDefined(oneHourSocketTargets[0]).intervals, ["1m", "1h", "45m"]);
});

test("full-cache REST and WebSocket targets honor history and realtime capabilities", () => {
  const exchangeCatalog = buildExchangeCatalog([{
    exchange: "split",
    name: "Split",
    capability_schema_version: 3,
    markets: [
      { market_type: "spot", product_type: "spot", label: "Spot" },
      { market_type: "futures", product_type: "perpetual", label: "Futures" },
    ],
    native_intervals: ["1m", "5m"],
    channels: [
      {
        channel: "kline",
        market_types: ["spot"],
        history: true,
        realtime: false,
        params: { interval: ["1m"] },
      },
      {
        channel: "kline",
        market_types: ["futures"],
        history: false,
        realtime: true,
        params: { interval: ["5m"] },
      },
    ],
    protocol_features: [],
    limits: {},
    known_limitations: [],
  }]);
  const options: FullCacheTargetOptions = {
    watchlists: [{
      id: "default",
      name: "Watchlist",
      color: "#3b82f6",
      symbols: ["split:spot:HISTORY", "split:futures:LIVE"],
    }],
    subscriptionTiers: {
      "split:spot:HISTORY": "full",
      "split:futures:LIVE": "full",
    },
    exchangeCatalog,
    customIntervalRecords: [{ value: "45m" }],
  };

  const historyTargets = buildWatchlistFullCacheTargets(options);
  assert.deepEqual(historyTargets.map((target) => ({
    symbolKey: target.symbolKey,
    intervals: target.intervals,
  })), [{
    symbolKey: "split:spot:HISTORY",
    intervals: ["1m", "45m"],
  }]);

  const realtimeTargets = buildWatchlistFullSocketTargets(options);
  assert.deepEqual(realtimeTargets.map((target) => ({
    symbolKey: target.symbolKey,
    intervals: target.intervals,
  })), [{
    symbolKey: "split:futures:LIVE",
    intervals: ["5m", "45m"],
  }]);
});
