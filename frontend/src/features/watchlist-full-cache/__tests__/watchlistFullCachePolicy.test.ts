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
  assert.equal(targets[0].symbolKey, "spot:BTCUSDT");
  assert.deepEqual(targets[0].intervals, ["1m", "1h", "45m"]);
  assert.deepEqual(targets[0].preloadIntervals, ["1h", "1m", "45m"]);
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

test("buildWatchlistFullSocketTargets ignores current interval priority", () => {
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

  assert.notDeepEqual(oneHourTargets[0].preloadIntervals, customTargets[0].preloadIntervals);
  assert.deepEqual(oneHourSocketTargets, customSocketTargets);
  assert.deepEqual(oneHourSocketTargets[0].intervals, ["1m", "1h", "45m"]);
});
