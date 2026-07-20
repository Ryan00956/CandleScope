import assert from "node:assert/strict";
import test from "node:test";

import {
  fullCacheKey,
  getFullCacheEntry,
  getWatchlistFullCacheMaxBars,
  getWarmRows,
  mergeFullCacheRows,
  patchFullCacheRealtimeKline,
  resetWatchlistFullCache,
  setFullCacheEntrySubscribed,
  snapshotWatchlistFullCacheDiagnostics,
  trimWatchlistFullCacheEntries,
  WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
} from "../watchlistFullCacheStore.js";
import type { GcVictim } from "../../cache-gc/cacheGcTypes.js";
import { planFrontendGc } from "../../cache-gc/cachePolicy.js";
import {
  epochSeconds,
  mustBeDefined,
} from "../../../test/testHelpers.js";

type WatchlistDiagnosticEntry = ReturnType<
  typeof snapshotWatchlistFullCacheDiagnostics
>["entries"][number];

function trimVictimFromDiagnostic(entry: WatchlistDiagnosticEntry): GcVictim {
  const trimPlan = mustBeDefined(entry.trimPlan);
  return {
    owner: "watchlist-full-cache",
    key: entry.key,
    tier: "subscribed",
    category: "kline",
    action: "trim-range",
    keepStart: trimPlan.keepStart,
    bars: trimPlan.removedBars,
    points: 0,
    items: 0,
    estimatedBytes: trimPlan.removedEstimatedBytes,
    generation: entry.generation,
    expectedRevision: entry.revision,
    lastAccessMs: entry.lastAccessMs,
    lastUpdatedMs: entry.lastUpdatedMs,
    lastRealtimeMs: entry.lastRealtimeMs,
    trimSafety: entry.trimSafety,
    trimPlan,
    resourceTotals: {
      bars: entry.bars,
      indicatorPoints: 0,
      indicatorItems: 0,
      estimatedBytes: entry.estimatedBytes,
    },
    relief: {
      bars: trimPlan.removedBars,
      indicatorPoints: 0,
      indicatorItems: 0,
      estimatedBytes: trimPlan.removedEstimatedBytes,
    },
  } as unknown as GcVictim;
}

function planCurrentWatchlistGc(maxKlineBars = 0) {
  const diagnostics = snapshotWatchlistFullCacheDiagnostics();
  return planFrontendGc({
    estimatedBytes: diagnostics.estimatedBytes,
    indicatorPoints: 0,
    klineBars: diagnostics.totalBars,
    owners: {
      chart: { entries: [] },
      watchlist: diagnostics,
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 1_000_000,
    maxIndicatorPoints: 1_000,
    maxKlineBars,
    nowMs: 1_000,
  });
}

test("watchlist full cache stores and reads rows by symbolKey and interval", () => {
  resetWatchlistFullCache();

  mergeFullCacheRows(
    "okx:spot:BTC-USDT",
    "1h",
    [
      { time: epochSeconds(1000), open: 1, high: 2, low: 1, close: 2, volume: 10 },
      { time: epochSeconds(1060), open: 2, high: 3, low: 2, close: 3, volume: 11 },
    ],
    { status: "warm", source: "latest" },
  );

  const entry = mustBeDefined(getFullCacheEntry("okx:spot:BTC-USDT", "1h"));
  assert.equal(entry.status, "warm");
  assert.deepEqual(entry.coverage, { firstTime: 1000, lastTime: 1060, bars: 2 });

  const warm = mustBeDefined(getWarmRows("okx:spot:BTC-USDT", "1h"));
  assert.equal(warm.rows.length, 2);
  assert.equal(warm.source, "latest");
});

test("watchlist full cache patches realtime klines without replacing other intervals", () => {
  resetWatchlistFullCache();

  mergeFullCacheRows("spot:BTCUSDT", "1m", [{ time: epochSeconds(1000), close: 1 }]);
  mergeFullCacheRows("spot:BTCUSDT", "1h", [{ time: epochSeconds(1000), close: 10 }]);

  patchFullCacheRealtimeKline("spot:BTCUSDT", "1m", { time: epochSeconds(1060), close: 2 });
  patchFullCacheRealtimeKline("spot:BTCUSDT", "1h", { time: epochSeconds(1000), close: 11 });

  assert.deepEqual(
    mustBeDefined(getWarmRows("spot:BTCUSDT", "1m")).rows.map((row) => row.close),
    [1, 2],
  );
  assert.deepEqual(
    mustBeDefined(getWarmRows("spot:BTCUSDT", "1h")).rows.map((row) => row.close),
    [11],
  );
});

test("watchlist full cache uses the same O(1) realtime tail path for every interval", () => {
  resetWatchlistFullCache();

  const intervalCases = [
    { interval: "1s", step: 1 },
    { interval: "1m", step: 60 },
    { interval: "1h", step: 3_600 },
    { interval: "1d", step: 86_400 },
    { interval: "1w", step: 604_800 },
    { interval: "1M", step: 2_592_000 },
    { interval: "45m", step: 2_700 },
  ];

  for (const { interval, step } of intervalCases) {
    const firstTime = epochSeconds(1_000_000);
    const tailTime = epochSeconds(1_000_000 + step);
    const nextTime = epochSeconds(1_000_000 + step * 2);
    mergeFullCacheRows("spot:BTCUSDT", interval, [
      { time: firstTime, close: 1 },
      { time: tailTime, close: 2 },
    ], { nowMs: 100, status: "warm" });

    const before = mustBeDefined(getFullCacheEntry("spot:BTCUSDT", interval));
    const rows = before.rows;
    const updated = patchFullCacheRealtimeKline(
      "spot:BTCUSDT",
      interval,
      { time: tailTime, close: 3 },
      { nowMs: 200 },
    );
    assert.strictEqual(updated.rows, rows, `${interval} tail update must retain the rows array`);
    assert.equal(updated.rows.at(-1)?.close, 3);
    assert.deepEqual(updated.coverage, {
      firstTime,
      lastTime: tailTime,
      bars: 2,
    });

    const appended = patchFullCacheRealtimeKline(
      "spot:BTCUSDT",
      interval,
      { time: nextTime, close: 4 },
      { nowMs: 300 },
    );
    assert.strictEqual(appended.rows, rows, `${interval} append must retain the rows array`);
    assert.deepEqual(appended.rows.map((row) => row.close), [1, 3, 4]);
    assert.deepEqual(appended.coverage, {
      firstTime,
      lastTime: nextTime,
      bars: 3,
    });
    assert.equal(appended.lastRealtimeMs, 300);
  }
});

test("watchlist full cache treats an identical realtime tail as a no-op", () => {
  resetWatchlistFullCache();

  const time = epochSeconds(1_000);
  mergeFullCacheRows(
    "spot:BTCUSDT",
    "1s",
    [{ time, close: 1, trades: 5 }],
    { nowMs: 100, status: "warm" },
  );
  const before = mustBeDefined(getFullCacheEntry("spot:BTCUSDT", "1s"));
  const rows = before.rows;

  const unchanged = patchFullCacheRealtimeKline(
    "spot:BTCUSDT",
    "1s",
    { time, close: 1, trades: 5 },
    { nowMs: 200 },
  );

  assert.strictEqual(unchanged, before);
  assert.strictEqual(unchanged.rows, rows);
  assert.equal(unchanged.lastUpdatedMs, 100);
  assert.equal(unchanged.lastRealtimeMs, null);
});

test("watchlist full cache ignores out-of-order realtime ticks", () => {
  resetWatchlistFullCache();

  mergeFullCacheRows("spot:BTCUSDT", "1m", [
    { time: epochSeconds(1_000), close: 1 },
    { time: epochSeconds(1_060), close: 2 },
    { time: epochSeconds(1_120), close: 3 },
  ], { nowMs: 100, status: "live" });
  const before = mustBeDefined(getFullCacheEntry("spot:BTCUSDT", "1m"));
  const rows = before.rows;

  const existingInterior = patchFullCacheRealtimeKline(
    "spot:BTCUSDT",
    "1m",
    { time: epochSeconds(1_060), close: 20 },
    { nowMs: 200 },
  );
  const missingInterior = patchFullCacheRealtimeKline(
    "spot:BTCUSDT",
    "1m",
    { time: epochSeconds(1_090), close: 30 },
    { nowMs: 300 },
  );

  assert.strictEqual(existingInterior, before);
  assert.strictEqual(missingInterior, before);
  assert.strictEqual(missingInterior.rows, rows);
  assert.deepEqual(rows.map((row) => row.close), [1, 2, 3]);
  assert.equal(missingInterior.lastUpdatedMs, 100);
  assert.equal(missingInterior.lastRealtimeMs, null);
});

test("watchlist full cache realtime updates only inspect a constant-sized tail", () => {
  resetWatchlistFullCache();

  const seedLength = 1_024;
  const seed = Array.from({ length: seedLength }, (_, index) => ({
    time: epochSeconds(10_000 + index),
    close: index,
  }));
  mergeFullCacheRows("spot:BTCUSDT", "1s", seed, { status: "warm" });
  const entry = mustBeDefined(getFullCacheEntry("spot:BTCUSDT", "1s"));
  const rawRows = entry.rows;
  let numericReads = 0;
  const proxiedRows = new Proxy(rawRows, {
    get(target, property, receiver): unknown {
      if (property === Symbol.iterator || property === "sort" || property === "findIndex") {
        throw new Error(`realtime update attempted a full-array operation: ${String(property)}`);
      }
      if (typeof property === "string" && /^\d+$/.test(property)) {
        const index = Number(property);
        if (index !== 0 && index < target.length - 1) {
          throw new Error(`realtime update inspected historical index ${index}`);
        }
        numericReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  entry.rows = proxiedRows;

  const tailTime = epochSeconds(10_000 + seed.length - 1);
  const updated = patchFullCacheRealtimeKline(
    "spot:BTCUSDT",
    "1s",
    { time: tailTime, close: -1 },
  );
  const updateReads = numericReads;
  assert.strictEqual(updated.rows, proxiedRows);
  assert.ok(updateReads <= 4, `tail update performed ${updateReads} indexed reads`);
  assert.equal(rawRows.at(-1)?.close, -1);

  numericReads = 0;
  const appended = patchFullCacheRealtimeKline(
    "spot:BTCUSDT",
    "1s",
    { time: epochSeconds(10_000 + seed.length), close: seedLength },
  );
  const appendReads = numericReads;
  assert.strictEqual(appended.rows, proxiedRows);
  assert.ok(appendReads <= 4, `append performed ${appendReads} indexed reads`);
  assert.equal(rawRows.at(-1)?.close, seedLength);
});

test("watchlist full cache bounds HTTP merges for seconds and longer intervals", () => {
  resetWatchlistFullCache();

  for (const interval of ["1s", "1m"]) {
    const maxBars = getWatchlistFullCacheMaxBars(interval);
    const totalBars = maxBars + 137;
    const rows = Array.from({ length: totalBars }, (_, index) => ({
      time: epochSeconds(50_000 + index),
      close: index,
    }));

    const entry = mergeFullCacheRows("spot:BTCUSDT", interval, rows, {
      status: "warm",
      nowMs: 100,
    });

    assert.equal(entry.rows.length, maxBars);
    assert.equal(entry.rows[0]?.close, totalBars - maxBars);
    assert.equal(entry.rows.at(-1)?.close, totalBars - 1);
    assert.deepEqual(entry.coverage, {
      firstTime: 50_000 + totalBars - maxBars,
      lastTime: 50_000 + totalBars - 1,
      bars: maxBars,
    });
  }

  assert.ok(
    getWatchlistFullCacheMaxBars("1s") < getWatchlistFullCacheMaxBars("1m"),
    "1s retention must remain lower than normal interval retention",
  );
});

test("watchlist full cache stays bounded during long-running realtime appends", () => {
  resetWatchlistFullCache();

  const interval = "1s";
  const maxBars = getWatchlistFullCacheMaxBars(interval);
  mergeFullCacheRows(
    "spot:BTCUSDT",
    interval,
    [{ time: epochSeconds(100_000), close: 0 }],
    { status: "live" },
  );
  const initial = mustBeDefined(getFullCacheEntry("spot:BTCUSDT", interval));
  const rows = initial.rows;
  const appendedBars = maxBars + 2_000;

  for (let index = 1; index <= appendedBars; index += 1) {
    const entry = patchFullCacheRealtimeKline(
      "spot:BTCUSDT",
      interval,
      { time: epochSeconds(100_000 + index), close: index },
      { nowMs: index },
    );
    assert.ok(entry.rows.length <= maxBars);
  }

  const finalEntry = mustBeDefined(getFullCacheEntry("spot:BTCUSDT", interval));
  assert.strictEqual(finalEntry.rows, rows);
  assert.equal(finalEntry.rows.length, maxBars);
  assert.equal(finalEntry.rows[0]?.close, appendedBars - maxBars + 1);
  assert.equal(finalEntry.rows.at(-1)?.close, appendedBars);
  assert.equal(finalEntry.coverage?.bars, maxBars);
});

test("watchlist diagnostics expose exact safe trim plans only above the subscribed tail", () => {
  resetWatchlistFullCache();

  const liveSymbol = "spot:BTCUSDT";
  const subscribedSymbol = "spot:ETHUSDT";
  const seedRows = (bars: number) => Array.from({ length: bars }, (_, index) => ({
    time: epochSeconds(200_000 + index * 60),
    close: index,
  }));
  mergeFullCacheRows(liveSymbol, "1m", seedRows(800), { status: "live" });
  mergeFullCacheRows(subscribedSymbol, "1m", seedRows(750), { status: "stale" });
  setFullCacheEntrySubscribed(subscribedSymbol, "1m", true);
  mergeFullCacheRows("spot:SOLUSDT", "1m", seedRows(500), { status: "live" });
  mergeFullCacheRows("spot:XRPUSDT", "1m", seedRows(800), { status: "warm" });

  const diagnostics = snapshotWatchlistFullCacheDiagnostics();
  const live = mustBeDefined(diagnostics.entries.find((entry) => entry.symbolKey === liveSymbol));
  const subscribed = mustBeDefined(
    diagnostics.entries.find((entry) => entry.symbolKey === subscribedSymbol),
  );
  const protectedFloor = mustBeDefined(
    diagnostics.entries.find((entry) => entry.symbolKey === "spot:SOLUSDT"),
  );
  const warm = mustBeDefined(
    diagnostics.entries.find((entry) => entry.symbolKey === "spot:XRPUSDT"),
  );

  assert.deepEqual(live.trimSafety, { safeRangeTrim: true });
  assert.deepEqual(live.trimPlan, {
    keepStart: epochSeconds(218_000),
    keepBars: WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
    removedBars: 300,
    removedEstimatedBytes: 60_000,
  });
  assert.deepEqual(subscribed.trimPlan, {
    keepStart: epochSeconds(215_000),
    keepBars: WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
    removedBars: 250,
    removedEstimatedBytes: 50_000,
  });
  assert.equal(protectedFloor.trimSafety, undefined);
  assert.equal(protectedFloor.trimPlan, undefined);
  assert.equal(warm.trimSafety, undefined);
  assert.equal(warm.trimPlan, undefined);
});

test("GC trims live and subscribed series only with an exact trim action", () => {
  resetWatchlistFullCache();

  const liveSymbol = "spot:BTCUSDT";
  const subscribedSymbol = "spot:ETHUSDT";
  const seedRows = (bars: number) => Array.from({ length: bars }, (_, index) => ({
    time: epochSeconds(300_000 + index * 60),
    close: index,
  }));
  mergeFullCacheRows(liveSymbol, "1m", seedRows(800), { status: "live" });
  mergeFullCacheRows(subscribedSymbol, "1m", seedRows(750), { status: "stale" });
  setFullCacheEntrySubscribed(subscribedSymbol, "1m", true);

  const liveKey = fullCacheKey(liveSymbol, "1m");
  const subscribedKey = fullCacheKey(subscribedSymbol, "1m");
  const blockedDelete = trimWatchlistFullCacheEntries([
    { key: liveKey, action: "delete-entry" } as GcVictim,
    { key: subscribedKey, action: "delete-entry" } as GcVictim,
  ]);
  assert.equal(blockedDelete.removedCount, 0);
  assert.deepEqual(
    blockedDelete.skipped.map((entry) => entry.reason),
    ["subscribed-delete-protected", "subscribed-delete-protected"],
  );

  const diagnostics = snapshotWatchlistFullCacheDiagnostics();
  const liveDiagnostic = mustBeDefined(
    diagnostics.entries.find((entry) => entry.key === liveKey),
  );
  const subscribedDiagnostic = mustBeDefined(
    diagnostics.entries.find((entry) => entry.key === subscribedKey),
  );
  const result = trimWatchlistFullCacheEntries([
    trimVictimFromDiagnostic(liveDiagnostic),
    trimVictimFromDiagnostic(subscribedDiagnostic),
  ]);

  const live = mustBeDefined(getFullCacheEntry(liveSymbol, "1m"));
  const subscribed = mustBeDefined(getFullCacheEntry(subscribedSymbol, "1m"));
  assert.equal(live.rows.length, WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS);
  assert.equal(subscribed.rows.length, WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS);
  assert.equal(subscribed.subscribed, true);
  assert.equal(result.removedCount, 2);
  assert.equal(result.removedBars, 550);
  assert.deepEqual(result.removed.map((entry) => entry.action), ["trim-range", "trim-range"]);
});

test("GC rejects a subscribed trim plan after realtime growth makes its relief stale", () => {
  resetWatchlistFullCache();

  const symbol = "spot:BTCUSDT";
  const rows = Array.from({ length: 800 }, (_, index) => ({
    time: epochSeconds(400_000 + index * 60),
    close: index,
  }));
  mergeFullCacheRows(symbol, "1m", rows, { status: "live" });
  const diagnostic = mustBeDefined(
    snapshotWatchlistFullCacheDiagnostics().entries.find((entry) => entry.symbolKey === symbol),
  );
  const staleVictim = trimVictimFromDiagnostic(diagnostic);

  patchFullCacheRealtimeKline(
    symbol,
    "1m",
    { time: epochSeconds(448_000), close: 800 },
  );
  const result = trimWatchlistFullCacheEntries([staleVictim]);

  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.skipped, [{
    owner: "watchlist-full-cache",
    key: fullCacheKey(symbol, "1m"),
    reason: "trim-plan-stale-or-invalid",
  }]);
  assert.equal(mustBeDefined(getFullCacheEntry(symbol, "1m")).rows.length, 801);
});

test("real watchlist diagnostics plan and execute an exact subscribed tail trim", () => {
  resetWatchlistFullCache();

  const symbol = "spot:BTCUSDT";
  mergeFullCacheRows(
    symbol,
    "1m",
    Array.from({ length: 800 }, (_, index) => ({
      time: epochSeconds(500_000 + index * 60),
      close: index,
    })),
    { status: "live" },
  );
  const diagnostics = snapshotWatchlistFullCacheDiagnostics();
  const plan = planFrontendGc({
    estimatedBytes: diagnostics.estimatedBytes,
    indicatorPoints: 0,
    klineBars: diagnostics.totalBars,
    owners: {
      chart: { entries: [] },
      watchlist: diagnostics,
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 1_000_000,
    maxIndicatorPoints: 1_000,
    maxKlineBars: WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
    nowMs: 600_000,
  });

  const victim = mustBeDefined(plan.victims[0]);
  assert.equal(victim.action, "trim-range");
  assert.equal(victim.bars, 300);
  assert.equal(victim.estimatedBytes, 60_000);
  assert.equal(victim.trimPlan?.keepBars, WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS);

  const result = trimWatchlistFullCacheEntries(plan.victims);
  assert.equal(result.removedCount, 1);
  assert.equal(result.removedBars, 300);
  assert.equal(mustBeDefined(getFullCacheEntry(symbol, "1m")).rows.length, 500);
});

test("warm Full cache deletion executes only against its exact planned snapshot", () => {
  resetWatchlistFullCache();

  const symbol = "spot:ADAUSDT";
  mergeFullCacheRows(symbol, "1m", [
    { time: epochSeconds(600_000), close: 1 },
    { time: epochSeconds(600_060), close: 2 },
  ], { status: "warm", nowMs: 100 });
  const plan = planCurrentWatchlistGc();
  const victim = mustBeDefined(plan.victims[0]);
  const diagnostic = mustBeDefined(
    snapshotWatchlistFullCacheDiagnostics().entries.find((entry) => entry.symbolKey === symbol),
  );

  assert.equal(victim.action, "delete-entry");
  assert.equal(victim.generation, diagnostic.generation);
  assert.equal(victim.expectedRevision, diagnostic.revision);
  assert.deepEqual(victim.resourceTotals, {
    bars: 2,
    indicatorPoints: 0,
    indicatorItems: 0,
    estimatedBytes: 400,
  });

  const result = trimWatchlistFullCacheEntries(plan.victims);
  assert.equal(result.removedCount, 1);
  assert.equal(snapshotWatchlistFullCacheDiagnostics().entries.length, 0);
});

test("warm Full cache deletion rejects plans stale after access, update, or recreation", () => {
  const symbol = "spot:ADAUSDT";
  const seed = () => {
    resetWatchlistFullCache();
    mergeFullCacheRows(symbol, "1m", [
      { time: epochSeconds(700_000), close: 1 },
      { time: epochSeconds(700_060), close: 2 },
    ], { status: "warm", nowMs: 100 });
    return mustBeDefined(planCurrentWatchlistGc().victims[0]);
  };
  const expectStaleSkip = (victim: GcVictim) => {
    const result = trimWatchlistFullCacheEntries([victim]);
    assert.equal(result.removedCount, 0);
    assert.deepEqual(result.skipped, [{
      owner: "watchlist-full-cache",
      key: fullCacheKey(symbol, "1m"),
      reason: "delete-plan-stale-or-invalid",
    }]);
    assert.equal(snapshotWatchlistFullCacheDiagnostics().entries.length, 1);
  };

  const accessedVictim = seed();
  const beforeAccess = mustBeDefined(
    snapshotWatchlistFullCacheDiagnostics().entries.find((entry) => entry.symbolKey === symbol),
  );
  const accessed = mustBeDefined(getFullCacheEntry(symbol, "1m"));
  assert.equal(accessed.revision, beforeAccess.revision + 1);
  expectStaleSkip(accessedVictim);

  const updatedVictim = seed();
  mergeFullCacheRows(
    symbol,
    "1m",
    [{ time: epochSeconds(700_120), close: 3 }],
    { status: "warm", nowMs: 200 },
  );
  expectStaleSkip(updatedVictim);

  const recreatedVictim = seed();
  const oldGeneration = recreatedVictim.generation;
  resetWatchlistFullCache();
  mergeFullCacheRows(symbol, "1m", [
    { time: epochSeconds(700_000), close: 1 },
    { time: epochSeconds(700_060), close: 2 },
  ], { status: "warm", nowMs: 100 });
  const recreated = mustBeDefined(
    snapshotWatchlistFullCacheDiagnostics().entries.find((entry) => entry.symbolKey === symbol),
  );
  assert.notEqual(recreated.generation, oldGeneration);
  expectStaleSkip(recreatedVictim);
});
