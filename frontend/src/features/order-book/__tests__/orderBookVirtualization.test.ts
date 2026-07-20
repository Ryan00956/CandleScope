import test from "node:test";
import assert from "node:assert/strict";
import { fixedRowWindow } from "../orderBookVirtualization.js";

test("fixed row window renders only the visible order-book slice plus overscan", () => {
  assert.deepEqual(fixedRowWindow({
    rowCount: 100,
    rowHeight: 22,
    viewportHeight: 220,
    scrollTop: 440,
    overscan: 4,
  }), {
    start: 16,
    end: 34,
    totalHeight: 2_200,
  });
});

test("fixed row window clamps the ask-side bottom anchor and empty books", () => {
  assert.deepEqual(fixedRowWindow({
    rowCount: 100,
    rowHeight: 22,
    viewportHeight: 220,
    scrollTop: Number.POSITIVE_INFINITY,
    overscan: 4,
  }), {
    start: 86,
    end: 100,
    totalHeight: 2_200,
  });
  assert.deepEqual(fixedRowWindow({
    rowCount: 0,
    rowHeight: 22,
    viewportHeight: 220,
    scrollTop: 0,
  }), { start: 0, end: 0, totalHeight: 0 });
});
