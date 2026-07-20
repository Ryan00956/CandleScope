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
  snapshotWatchlistFullCacheDiagnostics,
} from "../../watchlist-full-cache/watchlistFullCacheStore.js";
import { executeFrontendGcPlan } from "../cacheTrim.js";
import { planFrontendGc } from "../cachePolicy.js";
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

  const watchlistSnapshot = snapshotWatchlistFullCacheDiagnostics();
  const indicatorSnapshot = snapshotIndicatorResultCacheDiagnostics();
  const nowMs = Date.now();
  const ownerPlan = planFrontendGc({
    generatedAtMs: nowMs,
    estimatedBytes: watchlistSnapshot.estimatedBytes + indicatorSnapshot.estimatedBytes,
    klineBars: watchlistSnapshot.totalBars,
    indicatorPoints: indicatorSnapshot.totalPoints,
    owners: {
      chart: { entries: [] },
      watchlist: watchlistSnapshot,
      indicators: indicatorSnapshot,
    },
  }, {
    maxEstimatedBytes: 1,
    maxKlineBars: 0,
    maxIndicatorPoints: 0,
    nowMs,
  });
  assert.deepEqual(
    new Set(ownerPlan.victims.map((victim) => victim.owner)),
    new Set(["watchlist-full-cache", "indicator-result-cache"]),
  );

  const report = executeFrontendGcPlan({
    ...ownerPlan,
    victims: [
      partialMock<GcVictim>({
        owner: "chart-data-cache",
        key: "binance-spot-SOLUSDT-1m",
        action: "delete-entry",
      }),
      ...ownerPlan.victims,
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

test("indicator range-trim plan and execution use identical accounting", () => {
  resetWatchlistFullCache();
  resetIndicatorResultCache();
  mergeFullCacheRows("binance:spot:ETHUSDT", "1m", [
    { time: epochSeconds(1), close: 100 },
  ], { status: "warm" });
  cacheIndicatorSnapshot(
    { id: "ma", engineName: "MA", params: { period: 20 } },
    { exchange: "binance", marketType: "spot", symbol: "ETHUSDT", interval: "1m" },
    {
      lines: [{
        outputName: "ma",
        data: [
          { time: 10, value: 1 },
          { time: 20, value: 2 },
          { time: 30, value: 3 },
          { time: 40, value: 4 },
        ],
        colorData: [
          { time: 10, color: "red" },
          { time: 20, color: "red" },
          { time: 30, color: "green" },
          { time: 40, color: "green" },
        ],
      }],
      markers: [],
      fills: [],
      hlines: [],
      bgcolors: [],
      barcolors: [],
      signals: [],
    },
  );
  const indicatorSnapshot = snapshotIndicatorResultCacheDiagnostics();
  const nowMs = Date.now();
  const plan = planFrontendGc({
    generatedAtMs: nowMs,
    estimatedBytes: indicatorSnapshot.estimatedBytes,
    indicatorPoints: indicatorSnapshot.totalPoints,
    klineBars: 0,
    owners: {
      chart: { entries: [] },
      watchlist: { entries: [] },
      indicators: indicatorSnapshot,
    },
  }, {
    maxEstimatedBytes: 1_000_000,
    maxIndicatorPoints: 2,
    maxKlineBars: 1_000,
    nowMs,
  });

  const result = executeFrontendGcPlan(plan);

  assert.equal(mustBeDefined(plan.victims[0]).action, "trim-range");
  assert.equal(plan.wouldFreeIndicatorPoints, 2);
  assert.equal(plan.wouldFreeIndicatorItems, 2);
  assert.equal(plan.wouldFreeEstimatedBytes, 400);
  assert.equal(result.removedIndicatorPoints, plan.wouldFreeIndicatorPoints);
  assert.equal(result.removedIndicatorItems, plan.wouldFreeIndicatorItems);
  assert.equal(result.removedEstimatedBytes, plan.wouldFreeEstimatedBytes);
  assert.equal(result.accountingMatchesPlan, true);
});

test("executeFrontendGcPlan rejects an expired plan before owner dispatch", () => {
  let chartCalls = 0;
  const result = executeFrontendGcPlan(partialMock<GcPlan>({
    generatedAtMs: 100,
    expiresAtMs: Date.now() - 1,
    victims: [
      partialMock<GcVictim>({
        owner: "chart-data-cache",
        key: "expired",
        bars: 1,
        estimatedBytes: 200,
      }),
    ],
  }), {
    trimChartDataCacheEntries: () => {
      chartCalls += 1;
      return { owner: "chart-data-cache", removedCount: 1 };
    },
  });

  assert.equal(chartCalls, 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "plan-expired");
});
