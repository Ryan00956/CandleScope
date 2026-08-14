import assert from "node:assert/strict";
import test from "node:test";

import {
  getCommonLocalIntervals,
  resolveLocalIntervalSupport,
} from "./localIntervalPolicy.js";


const source15m = { interval: "15m", alignment_offset_ms: 0 };

test("15m local data composes 30m, 1h, and custom 90m", () => {
  assert.deepEqual(
    ["30m", "1h", "90m"].map((value) => {
      const support = resolveLocalIntervalSupport(source15m, value);
      return [support.target, support.factor, support.supported];
    }),
    [["30m", 2, true], ["1h", 4, true], ["90m", 6, true]],
  );
  assert.ok(getCommonLocalIntervals(source15m).includes("90m"));
});

test("15m local data rejects 89m with an explicit integer-multiple reason", () => {
  const support = resolveLocalIntervalSupport(source15m, "89m");

  assert.equal(support.supported, false);
  assert.equal(support.code, "interval_not_composable");
  assert.match(support.message, /89m 不是 15m 的整数倍/);
});

test("derived intervals fail closed when imported timestamps are phase shifted", () => {
  const support = resolveLocalIntervalSupport(
    { interval: "15m", alignment_offset_ms: 5 * 60_000 },
    "30m",
  );

  assert.equal(support.supported, false);
  assert.equal(support.code, "interval_alignment_incompatible");
});
