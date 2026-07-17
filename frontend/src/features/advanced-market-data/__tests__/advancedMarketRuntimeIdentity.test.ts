import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdvancedMarketHistoryContextKey,
  buildTailFirstHistoryRanges,
  isAdvancedMarketHistoryRequestCurrent,
  type AdvancedMarketHistoryRequestGuard,
} from "../useAdvancedMarketDataRuntime.js";

test("initial metric history prioritizes the newest chart bars without overlap", () => {
  const barTimes = Array.from({ length: 1_500 }, (_, index) => 1_000 + index * 60);
  const fullRange = {
    startMs: barTimes[0]! * 1000,
    endMs: barTimes.at(-1)! * 1000,
  };

  const ranges = buildTailFirstHistoryRanges(fullRange, barTimes);

  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0], {
    startMs: barTimes[1_380]! * 1000,
    endMs: fullRange.endMs,
  });
  assert.deepEqual(ranges[1], {
    startMs: fullRange.startMs,
    endMs: ranges[0]!.startMs - 1,
  });
});

test("small chart windows stay in one initial history request", () => {
  const barTimes = [1_000, 1_060, 1_120];
  const fullRange = { startMs: 1_000_000, endMs: 1_120_000 };

  assert.deepEqual(buildTailFirstHistoryRanges(fullRange, barTimes, 240), [fullRange]);
});

test("tail-first bootstrap caps high-interval charts by duration", () => {
  const daySeconds = 24 * 60 * 60;
  const barTimes = Array.from({ length: 365 }, (_, index) => 1_000 + index * daySeconds);
  const fullRange = {
    startMs: barTimes[0]! * 1000,
    endMs: barTimes.at(-1)! * 1000,
  };

  const ranges = buildTailFirstHistoryRanges(fullRange, barTimes, 240);

  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0], {
    startMs: fullRange.endMs - 10 * daySeconds * 1000,
    endMs: fullRange.endMs,
  });
  assert.equal(ranges[1]!.endMs, ranges[0]!.startMs - 1);
});

function currentGuard(
  overrides: Partial<AdvancedMarketHistoryRequestGuard> = {},
): AdvancedMarketHistoryRequestGuard {
  return {
    aborted: false,
    disposed: false,
    expectedGeneration: 4,
    currentGeneration: 4,
    expectedHistoryContextKey: "binance:futures:BTCUSDT|1h|open_interest",
    currentHistoryContextKey: "binance:futures:BTCUSDT|1h|open_interest",
    expectedIdentityKey: "binance:futures:BTCUSDT",
    currentIdentityKey: "binance:futures:BTCUSDT",
    expectedInterval: "1h",
    currentInterval: "1h",
    channel: "open_interest",
    period: "1h",
    currentMetricChannels: ["open_interest"],
    seriesReady: true,
    ...overrides,
  };
}

test("history context changes when chart interval or selected metric channels change", () => {
  const identityKey = "binance:futures:BTCUSDT";
  const current = buildAdvancedMarketHistoryContextKey(identityKey, "1h", ["open_interest"]);

  assert.notEqual(
    buildAdvancedMarketHistoryContextKey(identityKey, "5m", ["open_interest"]),
    current,
  );
  assert.notEqual(
    buildAdvancedMarketHistoryContextKey(identityKey, "1h", ["funding_rate"]),
    current,
  );
});

test("late OI history is rejected after interval, period, or generation changes", () => {
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard()), true);
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard({
    currentInterval: "5m",
    currentHistoryContextKey: "binance:futures:BTCUSDT|5m|open_interest",
  })), false);
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard({ period: "5m" })), false);
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard({ currentGeneration: 5 })), false);
});

test("history responses are rejected after unmount, abort, or series transition", () => {
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard({ disposed: true })), false);
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard({ aborted: true })), false);
  assert.equal(isAdvancedMarketHistoryRequestCurrent(currentGuard({ seriesReady: false })), false);
});
