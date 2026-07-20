import assert from "node:assert/strict";
import test from "node:test";

import {
  canResolveIntervalFromNativeValues,
  canonicalizeIntervalValue,
  getIntervalSemanticSpec,
  intervalSemanticSignature,
  intervalTiles,
  intervalsSemanticallyEquivalent,
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

test("fixed interval aliases canonicalize without crossing calendar alignments", () => {
  assert.equal(canonicalizeIntervalValue("60m"), "1h");
  assert.equal(canonicalizeIntervalValue("24h"), "1d");
  assert.equal(canonicalizeIntervalValue("1440m"), "1d");
  assert.equal(intervalsSemanticallyEquivalent("60m", "1h"), true);
  assert.equal(intervalsSemanticallyEquivalent("24h", "1d"), true);

  assert.equal(canonicalizeIntervalValue("7d"), "7d");
  assert.equal(canonicalizeIntervalValue("30d"), "30d");
  assert.equal(intervalsSemanticallyEquivalent("7d", "1w"), false);
  assert.equal(intervalsSemanticallyEquivalent("30d", "1M"), false);
});

test("semantic signatures encode alignment as well as nominal duration", () => {
  assert.equal(intervalSemanticSignature("60m"), "fixed-epoch:3600");
  assert.equal(intervalSemanticSignature("1w"), "weekly-monday:1");
  assert.equal(intervalSemanticSignature("1M"), "calendar-month:1");
  assert.deepEqual(getIntervalSemanticSpec("2M"), {
    amount: 2,
    unit: "M",
    alignment: "calendar-month",
    canonicalValue: "2M",
    widthSeconds: null,
    weekCount: null,
    monthCount: 2,
  });
});

test("semantic parsing fails closed for unsafe widths and excessive calendar months", () => {
  assert.equal(parseIntervalParts("9007199254740992s"), null);
  assert.equal(parseIntervalSeconds("9007199254740991d"), null);
  assert.equal(canonicalizeIntervalValue("12000M"), "12000M");
  assert.equal(parseIntervalParts("12001M"), null);
  assert.equal(canonicalizeIntervalValue("12001M"), "");
});

test("exact tiling preserves fixed, weekly, and calendar alignment semantics", () => {
  assert.equal(intervalTiles("1m", "47m"), true);
  assert.equal(intervalTiles("1m", "90s"), false);
  assert.equal(intervalTiles("1d", "1w"), true);
  assert.equal(intervalTiles("3d", "1w"), false);
  assert.equal(intervalTiles("1d", "1M"), true);
  assert.equal(intervalTiles("1w", "2w"), true);
  assert.equal(intervalTiles("1w", "7d"), false);
  assert.equal(intervalTiles("1M", "2M"), true);
  assert.equal(intervalTiles("1M", "30d"), false);
});

test("purpose-specific native values fail closed when no exact base exists", () => {
  assert.equal(canResolveIntervalFromNativeValues("7s", ["1m", "1h"]), false);
  assert.equal(canResolveIntervalFromNativeValues("7s", ["1s", "1m"]), true);
  assert.equal(canResolveIntervalFromNativeValues("60m", ["1h"]), true);
  assert.equal(canResolveIntervalFromNativeValues("90s", ["1m"]), false);
  assert.equal(canResolveIntervalFromNativeValues("2w", ["1d"]), true);
  assert.equal(canResolveIntervalFromNativeValues("2M", ["1M"]), true);
});
