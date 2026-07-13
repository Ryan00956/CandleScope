import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeIntervalValue,
  parseIntervalParts,
  parseIntervalSeconds,
} from "../intervals.js";

test("interval parsing preserves the case-sensitive month unit", () => {
  assert.deepEqual(parseIntervalParts("1M"), { amount: 1, unit: "M" });
  assert.equal(parseIntervalSeconds("1M"), 2_592_000);
  assert.equal(parseIntervalSeconds("1m"), 60);
  assert.equal(normalizeIntervalValue(" 01M "), "1M");
});

test("interval parsing rejects invalid and case-mismatched values", () => {
  for (const value of [null, "", "0m", "1.5h", "1H", "month", {}]) {
    assert.equal(parseIntervalParts(value), null);
    assert.equal(parseIntervalSeconds(value), null);
    assert.equal(normalizeIntervalValue(value), "");
  }
});
