import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLineBreakNumberOfLines,
  resolveLineBreakProjectorOptions,
} from "../lineBreakProjectionOptions.js";

test("Line Break options normalize the configured lookback", () => {
  assert.deepEqual(resolveLineBreakProjectorOptions([], { numberOfLines: 5 }), {
    configKey: "line-break:5:1",
    minTick: 1,
    numberOfLines: 5,
  });
  assert.deepEqual(
    resolveLineBreakProjectorOptions([{ open: 1.23, high: 1.24, low: 1.2, close: 1.21 }]),
    { configKey: "line-break:3:0.01", minTick: 0.01, numberOfLines: 3 },
  );
  assert.equal(normalizeLineBreakNumberOfLines("4.9"), 4);
});

test("Line Break options reject unsafe lookbacks", () => {
  for (const value of [0, -1, 51, Number.NaN, "invalid"]) {
    assert.deepEqual(resolveLineBreakProjectorOptions([], { numberOfLines: value }), {
      configKey: "line-break:3:1",
      minTick: 1,
      numberOfLines: 3,
    });
  }
});

test("Line Break tick inference depends only on source closes", () => {
  const ordinaryRows = [
    { open: 1.2, high: 1.3, low: 1.1, close: 1.2 },
    { open: 1.2, high: 1.4, low: 1.1, close: 1.3 },
  ];
  const preciseWickRows = [
    { open: 1.20000001, high: 1.34567891, low: 1.10000001, close: 1.2 },
    { open: 1.20000001, high: 1.45678912, low: 1.10000001, close: 1.3 },
  ];

  assert.deepEqual(
    resolveLineBreakProjectorOptions(preciseWickRows),
    resolveLineBreakProjectorOptions(ordinaryRows),
  );
  assert.equal(resolveLineBreakProjectorOptions(preciseWickRows).minTick, 0.1);
});
