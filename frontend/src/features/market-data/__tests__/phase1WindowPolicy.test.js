import assert from "node:assert/strict";
import test from "node:test";

import {
  activeCoverageMsFromRows,
  clampRangeToMaxBars,
  intersectRanges,
  isUserVisibleBackfillReason,
  latestBufferedRangeFromRows,
  trimRowsToMaxBars,
} from "../phase1WindowPolicy.js";

test("backfill reason whitelist includes only user-visible completion reasons", () => {
  assert.equal(isUserVisibleBackfillReason("tail_gap"), true);
  assert.equal(isUserVisibleBackfillReason("visible_range_gap"), true);
  assert.equal(isUserVisibleBackfillReason("background_gap_audit"), false);
});

test("intersectRanges returns the overlapping subrange", () => {
  assert.deepEqual(
    intersectRanges({ start: 100, end: 300 }, { start: 200, end: 400 }),
    { start: 200, end: 300 },
  );
  assert.equal(intersectRanges({ start: 100, end: 150 }, { start: 200, end: 300 }), null);
});

test("trimRowsToMaxBars keeps newest rows and reports left trim", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ time: index + 1 }));
  const trim = trimRowsToMaxBars(rows, 4);

  assert.deepEqual(trim.rows.map((row) => row.time), [3, 4, 5, 6]);
  assert.equal(trim.originalBars, 6);
  assert.equal(trim.trimmedLeft, 2);
  assert.equal(trim.trimmedRight, 0);
});

test("activeCoverageMsFromRows returns millisecond coverage for cached rows", () => {
  assert.deepEqual(
    activeCoverageMsFromRows([{ time: 20 }, { time: 10 }, { time: 30 }]),
    { start: 10_000, end: 30_000 },
  );
});

test("latestBufferedRangeFromRows builds a tail-centered seconds range", () => {
  assert.deepEqual(
    latestBufferedRangeFromRows([{ time: 1_000 }, { time: 2_000 }], 60, 10),
    { start: 1_400, end: 2_600 },
  );
});

test("clampRangeToMaxBars caps from the newest end", () => {
  assert.deepEqual(
    clampRangeToMaxBars({ start: 0, end: 600 }, 60, 5),
    { start: 360, end: 600 },
  );
});
