import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeFullCacheRows,
  resetWatchlistFullCache,
  setFullCacheEntryStatus,
} from "../watchlistFullCacheStore.js";
import {
  resolveInitialRows,
  resolveWatchlistWarmRows,
} from "../watchlistFullCacheResolver.js";
import {
  epochSeconds,
  mustBeDefined,
} from "../../../test/testHelpers.js";

test("resolveWatchlistWarmRows returns live watchlist full rows first", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("okx:spot:BTC-USDT", "1h", [{ time: epochSeconds(1000), close: 1 }], {
    status: "live",
    source: "ws",
  });

  const resolved = mustBeDefined(resolveWatchlistWarmRows({
    symbol: "BTC-USDT",
    interval: "1h",
    marketType: "spot",
    exchange: "okx",
  }));

  assert.equal(resolved.cacheState, "live");
  assert.equal(resolved.source, "watchlist-full-ws");
  assert.equal(resolved.needsRepair, false);
  assert.deepEqual(resolved.rows, [{ time: 1000, close: 1 }]);
});

test("resolveWatchlistWarmRows marks stale rows as needing repair", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("spot:BTCUSDT", "4h", [{ time: epochSeconds(1000), close: 1 }], {
    status: "warm",
    source: "latest",
  });
  setFullCacheEntryStatus("spot:BTCUSDT", "4h", "stale", { source: "latest" });

  const resolved = mustBeDefined(resolveWatchlistWarmRows({
    symbol: "BTCUSDT",
    interval: "4h",
    marketType: "spot",
    exchange: "binance",
  }));

  assert.equal(resolved.cacheState, "stale");
  assert.equal(resolved.needsRepair, true);
  assert.equal(resolved.source, "watchlist-full-latest");
});

test("resolveInitialRows falls back to market data memory cache on warm miss", () => {
  resetWatchlistFullCache();
  const resolved = mustBeDefined(resolveInitialRows({
    symbol: "ETHUSDT",
    interval: "1h",
    marketType: "spot",
    exchange: "binance",
    getMemoryRows: () => [{ time: epochSeconds(1000), close: 2 }],
  }));

  assert.equal(resolved.tier, "market-data-memory");
  assert.equal(resolved.source, "memory-cache-hit");
  assert.deepEqual(resolved.rows, [{ time: 1000, close: 2 }]);
});

test("resolveInitialRows preserves a complete chart window over a sparse watchlist tail", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("futures:BTCUSDT", "1m", [
    { time: epochSeconds(2000), close: 2 },
  ], {
    status: "live",
    source: "ws",
  });
  const memoryRows = [
    { time: epochSeconds(1000), close: 1 },
    { time: epochSeconds(1060), close: 1.5 },
  ];

  const resolved = mustBeDefined(resolveInitialRows({
    symbol: "BTCUSDT",
    interval: "1m",
    marketType: "futures",
    exchange: "binance",
    getMemoryRows: () => memoryRows,
  }));

  assert.equal(resolved.tier, "market-data-memory");
  assert.equal(resolved.rows, memoryRows);
});

test("resolveInitialRows uses a fuller watchlist window to repair sparse chart memory", () => {
  resetWatchlistFullCache();
  const warmRows = [
    { time: epochSeconds(1000), close: 1 },
    { time: epochSeconds(1060), close: 1.5 },
  ];
  mergeFullCacheRows("futures:ETHUSDT", "1m", warmRows, {
    status: "live",
    source: "ws",
  });

  const resolved = mustBeDefined(resolveInitialRows({
    symbol: "ETHUSDT",
    interval: "1m",
    marketType: "futures",
    exchange: "binance",
    getMemoryRows: () => [{ time: epochSeconds(1060), close: 1.5 }],
  }));

  assert.equal(resolved.tier, "watchlist-full");
  assert.deepEqual(resolved.rows, warmRows);
});

test("resolveInitialRows rejects a fuller watchlist window that still needs repair", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("futures:SOLUSDT", "1m", [
    { time: epochSeconds(1000), close: 1 },
    { time: epochSeconds(1060), close: 1.5 },
  ], {
    status: "partial",
    source: "preload",
  });
  const memoryRows = [{ time: epochSeconds(1060), close: 1.5 }];

  const resolved = mustBeDefined(resolveInitialRows({
    symbol: "SOLUSDT",
    interval: "1m",
    marketType: "futures",
    exchange: "binance",
    getMemoryRows: () => memoryRows,
  }));

  assert.equal(resolved.tier, "market-data-memory");
  assert.equal(resolved.rows, memoryRows);
});

test("resolveInitialRows rejects a fuller but older watchlist window", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("futures:BNBUSDT", "1m", [
    { time: epochSeconds(900), close: 1 },
    { time: epochSeconds(960), close: 1.5 },
  ], {
    status: "live",
    source: "ws",
  });
  const memoryRows = [{ time: epochSeconds(1060), close: 2 }];

  const resolved = mustBeDefined(resolveInitialRows({
    symbol: "BNBUSDT",
    interval: "1m",
    marketType: "futures",
    exchange: "binance",
    getMemoryRows: () => memoryRows,
  }));

  assert.equal(resolved.tier, "market-data-memory");
  assert.equal(resolved.rows, memoryRows);
});
