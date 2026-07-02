import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheIndicatorSnapshot,
  resetIndicatorResultCache,
  snapshotIndicatorResultCacheDiagnostics,
} from "../../indicators/indicatorResultCacheStore.js";
import {
  getFullCacheEntry,
  mergeFullCacheRows,
  resetWatchlistFullCache,
} from "../../watchlist-full-cache/watchlistFullCacheStore.js";
import { executeFrontendGcPlan } from "../cacheTrim.js";

test("executeFrontendGcPlan dispatches victims to cache owners", () => {
  resetWatchlistFullCache();
  resetIndicatorResultCache();

  mergeFullCacheRows("binance:spot:ETHUSDT", "1m", [
    { time: 1, close: 100 },
    { time: 2, close: 101 },
  ], { status: "warm" });
  cacheIndicatorSnapshot(
    { id: "ma", engineName: "MA", params: { period: 20 } },
    { exchange: "binance", marketType: "spot", symbol: "ETHUSDT", interval: "1m" },
    { lines: [{ outputName: "ma", data: [{ time: 1, value: 100 }] }] },
  );

  const indicatorKey = snapshotIndicatorResultCacheDiagnostics().entries[0].key;
  const report = executeFrontendGcPlan({
    generatedAtMs: 100,
    victims: [
      { owner: "chart-data-cache", key: "binance-spot-SOLUSDT-1m" },
      { owner: "watchlist-full-cache", key: "binance:spot:ETHUSDT::1m" },
      { owner: "indicator-result-cache", key: indicatorKey },
    ],
  }, {
    trimChartDataCacheEntries: (victims) => ({
      owner: "chart-data-cache",
      removedCount: victims.length,
      removedBars: 5,
      removedEstimatedBytes: 1000,
      removed: victims,
    }),
  });

  assert.equal(report.removedCount, 3);
  assert.equal(report.removedBars, 7);
  assert.equal(report.removedIndicatorPoints, 1);
  assert.equal(getFullCacheEntry("binance:spot:ETHUSDT", "1m"), null);
});

test("executeFrontendGcPlan skips live watchlist entries", () => {
  resetWatchlistFullCache();
  resetIndicatorResultCache();

  mergeFullCacheRows("binance:spot:BTCUSDT", "1m", [
    { time: 1, close: 100 },
  ], { status: "live" });

  const report = executeFrontendGcPlan({
    victims: [
      { owner: "watchlist-full-cache", key: "binance:spot:BTCUSDT::1m" },
    ],
  });

  assert.equal(report.removedCount, 0);
  assert.notEqual(getFullCacheEntry("binance:spot:BTCUSDT", "1m"), null);
});
