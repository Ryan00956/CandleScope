import assert from "node:assert/strict";
import test from "node:test";

import {
  canFinalizePendingInitialHistory,
  canUseWarmCacheWithoutImmediateRevalidation,
  initialHistoryCacheProof,
  planInitialHistoryCountBack,
  planInitialViewportCountBack,
  shouldRequestInitialLatest,
  WARM_CACHE_REVALIDATE_TTL_MS,
} from "../useChartInitialLoad.js";
import {
  planLoadMorePageSize,
  resolveBeforePageProgress,
  resolveBeforePageRequest,
} from "../useChartLoadMoreLeft.js";
import { epochSeconds } from "../../../test/testHelpers.js";

test("initial latest is reserved for exchange-native intervals", () => {
  const nativeIntervals = ["1m", "5m", "1h", "4h"];

  assert.equal(shouldRequestInitialLatest("1m", nativeIntervals), true);
  assert.equal(shouldRequestInitialLatest("60m", nativeIntervals), true);
  assert.equal(shouldRequestInitialLatest("47m", nativeIntervals), false);
  assert.equal(shouldRequestInitialLatest("8h", nativeIntervals), false);
});

test("only an explicitly complete, contiguous and recent activation skips REST revalidation", () => {
  const nowMs = 100_000;
  const rows = Array.from({ length: 1_500 }, (_, time) => ({
    time: epochSeconds(time),
  }));
  const activation = {
    coverage: {
      firstTime: rows[0]!.time,
      lastTime: rows.at(-1)!.time,
      bars: rows.length,
      gaps: [],
    },
    historyComplete: true,
    historyRepairPending: false,
    historyValidatedCountBack: 1_500,
    lastTailUpdatedMs: null,
    lastValidatedMs: nowMs - WARM_CACHE_REVALIDATE_TTL_MS,
    rightTruncated: false,
    rows,
  };

  assert.equal(canUseWarmCacheWithoutImmediateRevalidation(
    activation,
    1_500,
    nowMs,
  ), true);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    lastValidatedMs: nowMs - WARM_CACHE_REVALIDATE_TTL_MS - 1,
  }, 1_500, nowMs), false);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    lastValidatedMs: nowMs + 1,
  }, 1_500, nowMs), false);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    historyComplete: false,
  }, 1_500, nowMs), false, "partial history cannot become warm from its row count");
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    historyRepairPending: true,
  }, 1_500, nowMs), false);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    historyValidatedCountBack: 1_499,
  }, 1_500, nowMs), false);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    rightTruncated: true,
  }, 1_500, nowMs), false);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    coverage: {
      ...activation.coverage,
      gaps: [{ from: epochSeconds(10), to: epochSeconds(11), missingBars: 1 }],
    },
  }, 1_500, nowMs), false);

  const exhaustedRows = rows.slice(0, 12);
  assert.equal(canUseWarmCacheWithoutImmediateRevalidation({
    ...activation,
    coverage: {
      firstTime: exhaustedRows[0]!.time,
      lastTime: exhaustedRows.at(-1)!.time,
      bars: exhaustedRows.length,
      gaps: [],
    },
    rows: exhaustedRows,
  }, 1_500, nowMs), true, "a proven exhausted market does not need a row-count heuristic");
});

test("initial history cache proof requires every history response quality signal", () => {
  const complete = {
    complete: true,
    retryable: false,
    history_state: "ready" as const,
    verified_contiguous: true,
    all_rows_final: true,
    has_tail_gap: false,
    truncated: false,
    missing_ranges: [],
    data: [{ time: epochSeconds(1) }],
  };
  assert.deepEqual(initialHistoryCacheProof(complete, 1_500), {
    historyComplete: true,
    historyRepairPending: false,
    historyValidatedCountBack: 1_500,
  });
  assert.equal(initialHistoryCacheProof({ ...complete, history_state: "exhausted" }, 1_500).historyComplete, true);
  const without = (field: keyof typeof complete) => {
    const result: Partial<typeof complete> = { ...complete };
    delete result[field];
    return result;
  };
  for (const result of [
    { ...complete, complete: false },
    { ...complete, retryable: true },
    { ...complete, history_state: "pending" as const },
    { ...complete, verified_contiguous: false },
    { ...complete, all_rows_final: false },
    { ...complete, has_tail_gap: true },
    { ...complete, truncated: true },
    { ...complete, missing_ranges: [{ start_ms: 1_000, end_ms: 2_000 }] },
    without("complete"),
    without("retryable"),
    without("history_state"),
    without("verified_contiguous"),
    without("all_rows_final"),
    without("has_tail_gap"),
    without("missing_ranges"),
    { data: complete.data },
  ]) {
    assert.equal(initialHistoryCacheProof(result, 1_500).historyComplete, false);
  }
  assert.equal(
    initialHistoryCacheProof(without("truncated"), 1_500).historyComplete,
    true,
    "the history endpoint has no truncated field; only an explicit true value is negative evidence",
  );
});

test("pending initial history finalizes only with explicit proof covering its full range", () => {
  const pendingInitial = {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "3m",
    countBack: 1_500,
    range: { start: 1_000 as never, end: 10_000 as never },
  };
  const complete = {
    start_ms: 1_000,
    end_ms: 10_000,
    history_state: "ready" as const,
    complete: true,
    retryable: false,
    verified_contiguous: true,
    all_rows_final: true,
    has_tail_gap: false,
    truncated: false,
    missing_ranges: [],
  };

  assert.equal(canFinalizePendingInitialHistory(pendingInitial, complete), true);
  assert.equal(canFinalizePendingInitialHistory(pendingInitial, {
    ...complete,
    history_state: "pending",
    complete: false,
    retryable: true,
    verified_contiguous: false,
    all_rows_final: false,
    has_tail_gap: true,
    truncated: true,
    missing_ranges: [{
      start_ms: 1_000,
      end_ms: 10_000,
      reason: "aggregate_quality_unproven",
    }],
  }), false, "pending aggregate proof cannot terminate the initial lifecycle");
  assert.equal(canFinalizePendingInitialHistory(pendingInitial, {
    ...complete,
    start_ms: 8_000,
  }), false, "one completed child cannot prove the parent range");
  const withoutFinality: Partial<typeof complete> = { ...complete };
  delete withoutFinality.all_rows_final;
  assert.equal(
    canFinalizePendingInitialHistory(pendingInitial, withoutFinality),
    false,
    "missing quality fields fail closed",
  );
});

test("derived initial history is bounded by native source-row expansion", () => {
  const nativeIntervals = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h"];

  assert.equal(planInitialHistoryCountBack("1m", nativeIntervals), 1_500);
  assert.equal(planInitialHistoryCountBack("45m", nativeIntervals), 1_500);
  assert.equal(planInitialHistoryCountBack("57m", nativeIntervals), 1_049);
  assert.equal(planInitialHistoryCountBack("47m", nativeIntervals), 422);
  assert.equal(planInitialHistoryCountBack("91m", nativeIntervals), 216);
  assert.equal(planInitialHistoryCountBack("10001m", nativeIntervals), 0);
  assert.equal(planInitialHistoryCountBack("invalid", nativeIntervals), 0);
  assert.equal(planInitialHistoryCountBack("89m", []), 0);

  assert.equal(planInitialViewportCountBack("1m", nativeIntervals), 500);
  assert.equal(planInitialViewportCountBack("45m", nativeIntervals), 500);
  assert.equal(planInitialViewportCountBack("57m", nativeIntervals), 500);
  assert.equal(planInitialViewportCountBack("47m", nativeIntervals), 422);
  assert.equal(planInitialViewportCountBack("91m", nativeIntervals), 216);
  assert.equal(planInitialViewportCountBack("10001m", nativeIntervals), 0);
  assert.equal(planInitialViewportCountBack("89m", []), 0);
});

test("derived left pagination uses the smaller interactive source-row budget", () => {
  const nativeIntervals = ["1m", "3m", "5m", "15m", "30m", "1h"];

  assert.equal(planLoadMorePageSize("1m", nativeIntervals), 500);
  assert.equal(planLoadMorePageSize("45m", nativeIntervals), 500);
  assert.equal(planLoadMorePageSize("57m", nativeIntervals), 500);
  assert.equal(planLoadMorePageSize("47m", nativeIntervals), 209);
  assert.equal(planLoadMorePageSize("91m", nativeIntervals), 106);
  assert.equal(planLoadMorePageSize("10001m", nativeIntervals), 0);
  assert.equal(planLoadMorePageSize("89m", []), 0);
});

test("left pagination advances with the server next_before cursor", () => {
  const progress = resolveBeforePageProgress({
    requestedBefore: epochSeconds(1_000),
    nextBeforeMs: 800_000,
    hasMore: true,
    rows: [{ time: epochSeconds(900) }],
  });

  assert.deepEqual(progress, {
    phase: "idle",
    hasMoreLeft: true,
    madeProgress: true,
    nextBefore: 800,
  });
});

test("left pagination falls back to the oldest incoming row when no cursor is returned", () => {
  const progress = resolveBeforePageProgress({
    requestedBefore: epochSeconds(1_000),
    hasMore: true,
    rows: [{ time: epochSeconds(900) }, { time: epochSeconds(700) }],
  });

  assert.equal(progress.phase, "idle");
  assert.equal(progress.nextBefore, 700);
  assert.equal(progress.madeProgress, true);
});

test("left pagination fails closed when a completed page makes no progress", () => {
  const progress = resolveBeforePageProgress({
    requestedBefore: epochSeconds(1_000),
    nextBeforeMs: 1_000_000,
    hasMore: true,
    rows: [{ time: epochSeconds(1_000) }],
  });

  assert.deepEqual(progress, {
    phase: "stalled",
    hasMoreLeft: false,
    madeProgress: false,
    nextBefore: null,
  });
});

test("a pending page remains resumable even before the cursor advances", () => {
  const progress = resolveBeforePageProgress({
    requestedBefore: epochSeconds(1_000),
    pending: true,
    rows: [],
  });

  assert.deepEqual(progress, {
    phase: "pending",
    hasMoreLeft: true,
    madeProgress: false,
    nextBefore: 1_000,
  });
});

test("a pending page retries its owned boundary instead of skipping to an older cursor", () => {
  const progress = resolveBeforePageProgress({
    requestedBefore: epochSeconds(1_000),
    nextBeforeMs: 800_000,
    pending: true,
    rows: [{ time: epochSeconds(900) }],
  });

  assert.equal(progress.phase, "pending");
  assert.equal(progress.madeProgress, true);
  assert.equal(progress.nextBefore, 1_000);
});

test("user gestures join a pending page and cannot skip its owned cursor", () => {
  const pendingPage = { requestedBefore: epochSeconds(1_000) };

  assert.deepEqual(resolveBeforePageRequest({
    oldestChartTime: epochSeconds(600),
    oldestLoadedTime: epochSeconds(500),
    nextBefore: epochSeconds(1_000),
    pendingPage,
  }), {
    action: "join-pending",
    before: 1_000,
  });
  assert.deepEqual(resolveBeforePageRequest({
    oldestChartTime: epochSeconds(600),
    oldestLoadedTime: epochSeconds(400),
    nextBefore: epochSeconds(1_000),
    pendingPage,
  }), {
    action: "join-pending",
    before: 1_000,
  });
});

test("pending ownership cannot start a second direct request for the same cursor", () => {
  const pendingPage = { requestedBefore: epochSeconds(1_000) };

  assert.deepEqual(resolveBeforePageRequest({
    oldestChartTime: epochSeconds(500),
    oldestLoadedTime: epochSeconds(400),
    nextBefore: epochSeconds(800),
    pendingPage,
  }), {
    action: "join-pending",
    before: 1_000,
  });
});
