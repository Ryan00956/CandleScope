import assert from "node:assert/strict";
import test from "node:test";

import {
  ChartBackgroundPrefetchAttemptLedger,
  ChartBackgroundPrefetchPriorityGate,
  estimateBackgroundPrefetchSourceRows,
  hasChartForegroundWork,
  planBackgroundPrefetchRequest,
  PREFETCH_SOURCE_ROW_BUDGET,
  shouldSkipChartBackgroundPrefetch,
} from "../useChartBackgroundPrefetch.js";

test("cold, pagination, repair, restore, and indicator ownership all block warming", () => {
  assert.equal(hasChartForegroundWork(), false);
  for (const state of [
    { loading: true },
    { loadingMoreLeft: true },
    { restoringLatestWindow: true },
    { pendingInitial: true },
    { activePagination: true },
    { pendingRepairs: 1 },
    { indicatorRequests: 1 },
  ]) {
    assert.equal(hasChartForegroundWork(state), true);
  }
});

test("foreground work synchronously aborts speculative warming and starts a fresh idle grace", () => {
  const priority = new ChartBackgroundPrefetchPriorityGate(1_000);
  const first = priority.tryAcquire(10_000);
  assert.ok(first);
  assert.equal(priority.isCurrent(first), true);

  priority.yieldToForeground(10_100);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(priority.isCurrent(first), false);
  assert.equal(priority.waitMs(10_100), 1_000);
  assert.equal(priority.tryAcquire(11_099), null);

  const resumed = priority.tryAcquire(11_100);
  assert.ok(resumed);
  assert.notEqual(resumed.generation, first.generation);
  assert.equal(priority.tryAcquire(11_100), null, "only one speculative request may own the gate");
  priority.release(first);
  assert.equal(priority.isCurrent(resumed), true, "a stale release must not steal the resumed lease");
  priority.release(resumed);
  assert.ok(priority.tryAcquire(11_100));
});

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
  assert.ok(attempts.claimInterval("6h"));

  // The hook effect can restart when the active interval changes.
  attempts.enterScope(scopeKey);
  assert.equal(attempts.claimInterval("6h"), null);

  // Appending tracked intervals must not replay an alias of an earlier attempt.
  attempts.enterScope(scopeKey);
  assert.equal(attempts.claimInterval("360m"), null);
  assert.ok(attempts.claimInterval("8h"));
});

test("a foreground-aborted attempt can be retried after the next idle window", () => {
  const attempts = new ChartBackgroundPrefetchAttemptLedger();
  attempts.enterScope("spot:BTCUSDT");
  const interrupted = attempts.claimInterval("6h");
  assert.ok(interrupted);
  assert.equal(attempts.releaseInterval(interrupted), true);
  assert.ok(attempts.claimInterval("360m"));
});

test("a slow old-scope settlement cannot release the new scope's same-interval claim", () => {
  const attempts = new ChartBackgroundPrefetchAttemptLedger();
  attempts.enterScope("spot:BTCUSDT");
  const oldClaim = attempts.claimInterval("6h");
  assert.ok(oldClaim);

  attempts.enterScope("spot:ETHUSDT");
  const currentClaim = attempts.claimInterval("360m");
  assert.ok(currentClaim);

  assert.equal(attempts.releaseInterval(oldClaim), false);
  assert.equal(attempts.retryAfterFailure(oldClaim), null);
  assert.equal(attempts.completeInterval(oldClaim), false);
  assert.equal(attempts.claimInterval("6h"), null, "current alias claim must remain owned");

  assert.equal(attempts.releaseInterval(currentClaim), true);
  assert.ok(attempts.claimInterval("6h"));
});

test("transient prefetch failures retry with bounded exponential backoff", () => {
  const attempts = new ChartBackgroundPrefetchAttemptLedger();
  attempts.enterScope("spot:BTCUSDT");

  const first = attempts.claimInterval("6h");
  assert.ok(first);
  assert.equal(attempts.retryAfterFailure(first), 5_000);

  const second = attempts.claimInterval("6h");
  assert.ok(second);
  assert.equal(attempts.retryAfterFailure(second), 10_000);

  const final = attempts.claimInterval("6h");
  assert.ok(final);
  assert.equal(attempts.retryAfterFailure(final), null);
  assert.equal(attempts.claimInterval("6h"), null, "third failure exhausts the retry budget");
});

test("background prefetch attempts reset for a new symbol or market scope", () => {
  const attempts = new ChartBackgroundPrefetchAttemptLedger();

  attempts.enterScope("spot:BTCUSDT");
  assert.ok(attempts.claimInterval("6h"));
  assert.equal(attempts.claimInterval("6h"), null);

  attempts.enterScope("spot:ETHUSDT");
  assert.ok(attempts.claimInterval("6h"));

  attempts.enterScope("futures:ETHUSDT");
  assert.ok(attempts.claimInterval("6h"));
});

test("background prefetch enforces a bounded source-row budget for derived intervals", () => {
  const nativeIntervals = ["1m", "3m", "5m", "15m", "1h"];

  assert.equal(estimateBackgroundPrefetchSourceRows("1h", nativeIntervals), 500);
  assert.equal(estimateBackgroundPrefetchSourceRows("45m", nativeIntervals), 1_509);
  assert.equal(estimateBackgroundPrefetchSourceRows("57m", nativeIntervals), 9_557);
  assert.equal(estimateBackgroundPrefetchSourceRows("47m", nativeIntervals), 9_964);
  assert.equal(estimateBackgroundPrefetchSourceRows("91m", nativeIntervals), 9_919);
  assert.equal(planBackgroundPrefetchRequest("47m", nativeIntervals)?.targetBars, 209);
  assert.equal(planBackgroundPrefetchRequest("91m", nativeIntervals)?.targetBars, 106);

  const base = {
    activeInterval: "1h",
    fullCacheRows: 0,
    fullCacheStatus: null,
    hasMemoryCache: false,
    inFlight: false,
    nativeIntervals,
  } as const;
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, interval: "45m" }), false);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, interval: "57m" }), false);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, interval: "47m" }), false);
  assert.equal(shouldSkipChartBackgroundPrefetch({
    ...base,
    interval: "47m",
    sourceRowBudget: PREFETCH_SOURCE_ROW_BUDGET * 3,
  }), false);
  assert.equal(shouldSkipChartBackgroundPrefetch({
    ...base,
    interval: "91m",
    sourceRowBudget: 100,
  }), true);
});
