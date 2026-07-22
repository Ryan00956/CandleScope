import assert from "node:assert/strict";
import test from "node:test";

import {
  planInitialHistoryCountBack,
  shouldRequestInitialLatest,
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
