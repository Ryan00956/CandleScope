import assert from "node:assert/strict";
import test from "node:test";

import { detectGaps, klineRowsEqual } from "../chartDataRuntime.js";
import { epochSeconds } from "../../../test/testHelpers.js";

test("detectGaps reports internal K-line gaps", () => {
  const gaps = detectGaps([
    { time: epochSeconds(1000) },
    { time: epochSeconds(1060) },
    { time: epochSeconds(1240) },
  ], 60);

  assert.deepEqual(gaps, [{
    from: 1060,
    to: 1240,
    missingBars: 2,
  }]);
});

test("detectGaps does not infer tail gaps from Date.now by default", () => {
  const gaps = detectGaps([
    { time: epochSeconds(1000) },
    { time: epochSeconds(1060) },
    { time: epochSeconds(1120) },
  ], 60);

  assert.deepEqual(gaps, []);
});

test("detectGaps can report an explicit tail gap when a current time is supplied", () => {
  const gaps = detectGaps([
    { time: epochSeconds(1000) },
    { time: epochSeconds(1060) },
    { time: epochSeconds(1120) },
  ], 60, { includeTailGap: true, nowSecs: 1600 });

  assert.deepEqual(gaps, [{
    from: 1120,
    to: 1600,
    missingBars: 8,
    isTailGap: true,
  }]);
});

test("klineRowsEqual compares rows by value instead of array identity", () => {
  assert.equal(
    klineRowsEqual(
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    ),
    true,
  );

  assert.equal(
    klineRowsEqual(
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.6, volume: 10 }],
    ),
    false,
  );

  assert.equal(klineRowsEqual({ length: 0 }, { length: 0 }), false);
  assert.equal(klineRowsEqual([{}], [null]), false);
});
