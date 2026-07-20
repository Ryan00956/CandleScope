import assert from "node:assert/strict";
import test from "node:test";

import {
  ChartBackgroundPrefetchAttemptLedger,
  shouldSkipChartBackgroundPrefetch,
} from "../useChartBackgroundPrefetch.js";

test("background prefetch yields to the active chart, memory cache, full cache, and inflight owner", () => {
  const base = {
    activeInterval: "45m",
    fullCacheRows: 0,
    fullCacheStatus: null,
    hasMemoryCache: false,
    inFlight: false,
    interval: "1h",
  } as const;

  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, interval: "45m" }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, hasMemoryCache: true }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, inFlight: true }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, fullCacheStatus: "loading" }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({
    ...base,
    fullCacheRows: 500,
    fullCacheStatus: "warm",
  }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch(base), false);
});

test("background prefetch attempts survive active interval changes and tracked interval appends", () => {
  const attempts = new ChartBackgroundPrefetchAttemptLedger();
  const scopeKey = "spot:BTCUSDT";

  attempts.enterScope(scopeKey);
  assert.equal(attempts.claimInterval("6h"), true);

  // The hook effect can restart when the active interval changes.
  attempts.enterScope(scopeKey);
  assert.equal(attempts.claimInterval("6h"), false);

  // Appending tracked intervals must not replay an alias of an earlier attempt.
  attempts.enterScope(scopeKey);
  assert.equal(attempts.claimInterval("360m"), false);
  assert.equal(attempts.claimInterval("8h"), true);
});

test("background prefetch attempts reset for a new symbol or market scope", () => {
  const attempts = new ChartBackgroundPrefetchAttemptLedger();

  attempts.enterScope("spot:BTCUSDT");
  assert.equal(attempts.claimInterval("6h"), true);
  assert.equal(attempts.claimInterval("6h"), false);

  attempts.enterScope("spot:ETHUSDT");
  assert.equal(attempts.claimInterval("6h"), true);

  attempts.enterScope("futures:ETHUSDT");
  assert.equal(attempts.claimInterval("6h"), true);
});
