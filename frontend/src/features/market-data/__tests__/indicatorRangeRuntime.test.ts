import assert from "node:assert/strict";
import test from "node:test";

import { epochSeconds } from "../../../test/testHelpers.js";
import {
  mergeIndicatorWindowChangedRanges,
  requestIndicatorRangeForWindowMeta,
  requestIndicatorRangeInChunks,
  resolveIndicatorRangeFromWindowMeta,
  resolveIndicatorRangesFromWindowMeta,
} from "../indicatorRangeRuntime.js";

test("deferred partial commits retain prepend and correction ranges for one settled publish", () => {
  assert.deepEqual(mergeIndicatorWindowChangedRanges(
    [{ start: epochSeconds(600), end: epochSeconds(900), type: "prepend" }],
    [
      { start: epochSeconds(600), end: epochSeconds(900), type: "prepend" },
      { start: epochSeconds(1_200), end: epochSeconds(1_500), type: "mid-merge" },
    ],
    [{ start: epochSeconds(1_400), end: epochSeconds(1_800), type: "mid-merge" }],
  ), [
    { start: 1_200, end: 1_800, type: "mid-merge" },
    { start: 600, end: 900, type: "prepend" },
  ]);
});

interface RangeCall {
  start: number;
  end: number;
  reason?: string | undefined;
}

test("indicator range runtime forwards the full range once", () => {
  const calls: RangeCall[] = [];

  requestIndicatorRangeInChunks((start, end) => {
    calls.push({ start, end });
  }, 1_700_000_000, 1_700_360_000);

  assert.deepEqual(calls, [{
    start: 1_700_000_000,
    end: 1_700_360_000,
  }]);
});

test("indicator range runtime plans only prepend and mid-merge window deltas", () => {
  assert.deepEqual(resolveIndicatorRangeFromWindowMeta({
    windowDeltaType: "prepend",
    incomingFirstTime: 100,
    incomingLastTime: 200,
  }), { start: 100, end: 200, reason: "window-prepend" });

  assert.deepEqual(resolveIndicatorRangeFromWindowMeta({
    windowDeltaType: "mid-merge",
    incomingFirstTime: 300,
    incomingLastTime: 360,
  }), { start: 300, end: 360, reason: "window-mid-merge" });

  assert.equal(resolveIndicatorRangeFromWindowMeta({
    windowDeltaType: "append",
    incomingFirstTime: 300,
    incomingLastTime: 360,
  }), null);
});

test("indicator range runtime publishes planned window delta range once", () => {
  const calls: RangeCall[] = [];
  const sent = requestIndicatorRangeForWindowMeta((start, end, reason) => {
    calls.push({ start, end, reason });
  }, {
    windowDeltaType: "mid-merge",
    incomingFirstTime: 1_700_000_000,
    incomingLastTime: 1_700_000_120,
  });

  assert.equal(sent, true);
  assert.deepEqual(calls, [{
    start: 1_700_000_000,
    end: 1_700_000_120,
    reason: "window-mid-merge",
  }]);
});

test("indicator range runtime prefers exact changed ranges over a large merge envelope", () => {
  assert.deepEqual(resolveIndicatorRangesFromWindowMeta({
    windowDeltaType: "mid-merge",
    incomingFirstTime: 100,
    incomingLastTime: 10_000,
    changedRanges: [
      { start: 100, end: 200, type: "prepend" },
      { start: 5_000, end: 5_060, type: "mid-merge" },
      { start: 10_000, end: 10_000, type: "append" },
    ],
  }), [
    { start: 100, end: 200, reason: "window-prepend" },
    { start: 5_000, end: 5_060, reason: "window-mid-merge" },
  ]);

  const calls: RangeCall[] = [];
  requestIndicatorRangeForWindowMeta((start, end, reason) => {
    calls.push({ start, end, reason });
  }, {
    windowDeltaType: "mid-merge",
    incomingFirstTime: 100,
    incomingLastTime: 10_000,
    changedRanges: [
      { start: 100, end: 200, type: "prepend" },
      { start: 5_000, end: 5_060, type: "mid-merge" },
    ],
  });
  assert.deepEqual(calls, [
    { start: 100, end: 200, reason: "window-prepend" },
    { start: 5_000, end: 5_060, reason: "window-mid-merge" },
  ]);
});

test("indicator range runtime preserves every rapid commit and its exact delta reason", () => {
  const calls: RangeCall[] = [];
  const publish = (start: number, end: number, reason?: string) => {
    calls.push({ start, end, reason });
  };

  requestIndicatorRangeForWindowMeta(publish, {
    windowDeltaType: "prepend",
    incomingFirstTime: 600,
    incomingLastTime: 900,
  });
  requestIndicatorRangeForWindowMeta(publish, {
    windowDeltaType: "mid-merge",
    incomingFirstTime: 1_200,
    incomingLastTime: 1_500,
  });

  assert.deepEqual(calls, [
    { start: 600, end: 900, reason: "window-prepend" },
    { start: 1_200, end: 1_500, reason: "window-mid-merge" },
  ]);
});
