import assert from "node:assert/strict";
import test from "node:test";

import {
  getFullCacheEntry,
  getWarmRows,
  mergeFullCacheRows,
  patchFullCacheRealtimeKline,
  resetWatchlistFullCache,
} from "../watchlistFullCacheStore.js";
import {
  epochSeconds,
  mustBeDefined,
} from "../../../test/testHelpers.js";

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

  const seed = Array.from({ length: 4_096 }, (_, index) => ({
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
    { time: epochSeconds(10_000 + seed.length), close: 4_096 },
  );
  const appendReads = numericReads;
  assert.strictEqual(appended.rows, proxiedRows);
  assert.ok(appendReads <= 4, `append performed ${appendReads} indexed reads`);
  assert.equal(rawRows.at(-1)?.close, 4_096);
});
