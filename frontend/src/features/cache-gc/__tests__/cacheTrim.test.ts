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
import type { GcPlan, GcVictim } from "../cacheGcTypes.js";
import { epochSeconds, mustBeDefined, partialMock } from "../../../test/testHelpers.js";

test("executeFrontendGcPlan dispatches victims to cache owners", () => {
  resetWatchlistFullCache();
  resetIndicatorResultCache();

  mergeFullCacheRows("binance:spot:ETHUSDT", "1m", [
    { time: epochSeconds(1), close: 100 },
    { time: epochSeconds(2), close: 101 },
  ], { status: "warm" });
  cacheIndicatorSnapshot(
    { id: "ma", engineName: "MA", params: { period: 20 } },
    { exchange: "binance", marketType: "spot", symbol: "ETHUSDT", interval: "1m" },
    {
      lines: [{ outputName: "ma", data: [{ time: epochSeconds(1), value: 100 }] }],
      markers: [],
      fills: [],
      hlines: [],
      bgcolors: [],
      barcolors: [],
      signals: [],
    },
  );

  const indicatorKey = mustBeDefined(
    snapshotIndicatorResultCacheDiagnostics().entries[0],
  ).key;
  const report = executeFrontendGcPlan(partialMock<GcPlan>({
    generatedAtMs: 100,
    victims: [
      partialMock<GcVictim>({ owner: "chart-data-cache", key: "binance-spot-SOLUSDT-1m" }),
      partialMock<GcVictim>({ owner: "watchlist-full-cache", key: "binance:spot:ETHUSDT::1m" }),
      partialMock<GcVictim>({ owner: "indicator-result-cache", key: indicatorKey }),
    ],
  }), {
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
    { time: epochSeconds(1), close: 100 },
  ], { status: "live" });

  const report = executeFrontendGcPlan(partialMock<GcPlan>({
    victims: [
      partialMock<GcVictim>({ owner: "watchlist-full-cache", key: "binance:spot:BTCUSDT::1m" }),
    ],
  }));

  assert.equal(report.removedCount, 0);
  assert.notEqual(getFullCacheEntry("binance:spot:BTCUSDT", "1m"), null);
});
