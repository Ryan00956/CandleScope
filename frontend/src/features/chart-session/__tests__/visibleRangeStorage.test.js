import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVisibleRange,
  planVisibleRangeRestore,
} from "../visibleRangeStorage.js";

test("normalizeVisibleRange stores the phase7 anchor tuple", () => {
  assert.deepEqual(normalizeVisibleRange({
    logical: { from: 10, to: 20 },
    time: { from: 100, to: 200 },
    barSpacing: 8,
    rightOffset: 3,
    rightmostTime: 200,
    dataVersion: 99,
  }), {
    barSpacing: 8,
    rightOffset: 3,
    rightmostTime: 200,
  });
});

test("normalizeVisibleRange migrates legacy scroll and time fields", () => {
  assert.deepEqual(normalizeVisibleRange({
    time: { from: 100, to: 200 },
    barSpacing: 7,
    scrollPosition: 5,
  }), {
    barSpacing: 7,
    rightOffset: 5,
    rightmostTime: 200,
  });
});

test("planVisibleRangeRestore uses a single anchor mode", () => {
  assert.deepEqual(planVisibleRangeRestore({
    time: { from: 100, to: 200 },
    barSpacing: 7,
    scrollPosition: 5,
  }, [{ time: 150 }], { version: 1 }), {
    mode: "anchor",
    barSpacing: 7,
    rightOffset: 5,
    rightmostTime: 200,
  });
});
