import assert from "node:assert/strict";
import test from "node:test";

import {
  requestIndicatorRangeForWindowMeta,
  requestIndicatorRangeInChunks,
  resolveIndicatorRangeFromWindowMeta,
} from "../indicatorRangeRuntime.js";

test("indicator range runtime forwards the full range once", () => {
  const calls = [];

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
  const calls = [];
  const sent = requestIndicatorRangeForWindowMeta((start, end) => {
    calls.push({ start, end });
  }, {
    windowDeltaType: "mid-merge",
    incomingFirstTime: 1_700_000_000,
    incomingLastTime: 1_700_000_120,
  });

  assert.equal(sent, true);
  assert.deepEqual(calls, [{ start: 1_700_000_000, end: 1_700_000_120 }]);
});
