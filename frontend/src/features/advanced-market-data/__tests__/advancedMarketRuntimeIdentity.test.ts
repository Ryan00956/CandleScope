import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdvancedMarketHistoryContextKey,
  isAdvancedMarketHistoryRequestCurrent,
  type AdvancedMarketHistoryRequestGuard,
} from "../useAdvancedMarketDataRuntime.js";

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
