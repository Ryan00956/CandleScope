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

test("resolveWatchlistWarmRows returns live watchlist full rows first", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("okx:spot:BTC-USDT", "1h", [{ time: 1000, close: 1 }], {
    status: "live",
    source: "ws",
  });

  const resolved = resolveWatchlistWarmRows({
    symbol: "BTC-USDT",
    interval: "1h",
    marketType: "spot",
    exchange: "okx",
  });

  assert.equal(resolved.cacheState, "live");
  assert.equal(resolved.source, "watchlist-full-ws");
  assert.equal(resolved.needsRepair, false);
  assert.deepEqual(resolved.rows, [{ time: 1000, close: 1 }]);
});

test("resolveWatchlistWarmRows marks stale rows as needing repair", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows("spot:BTCUSDT", "4h", [{ time: 1000, close: 1 }], {
    status: "warm",
    source: "latest",
  });
  setFullCacheEntryStatus("spot:BTCUSDT", "4h", "stale", { source: "latest" });

  const resolved = resolveWatchlistWarmRows({
    symbol: "BTCUSDT",
    interval: "4h",
    marketType: "spot",
    exchange: "binance",
  });

  assert.equal(resolved.cacheState, "stale");
  assert.equal(resolved.needsRepair, true);
  assert.equal(resolved.source, "watchlist-full-latest");
});

test("resolveInitialRows falls back to market data memory cache on warm miss", () => {
  resetWatchlistFullCache();
  const resolved = resolveInitialRows({
    symbol: "ETHUSDT",
    interval: "1h",
    marketType: "spot",
    exchange: "binance",
    getMemoryRows: () => [{ time: 1000, close: 2 }],
  });

  assert.equal(resolved.tier, "market-data-memory");
  assert.equal(resolved.source, "memory-cache-hit");
  assert.deepEqual(resolved.rows, [{ time: 1000, close: 2 }]);
});
