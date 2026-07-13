import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRenkoAtr,
  inferRenkoMinimumTick,
  resolveRenkoProjectorOptions,
} from "../renkoProjectionOptions.js";

const ROWS = [
  { time: 1, open: 100, high: 103, low: 99, close: 102 },
  { time: 2, open: 102, high: 106, low: 101, close: 105 },
  { time: 3, open: 105, high: 107, low: 103, close: 104 },
];

test("Renko ATR uses true ranges and produces a positive fixed box", () => {
  assert.equal(calculateRenkoAtr(ROWS, 3), 13 / 3);
  const options = resolveRenkoProjectorOptions(ROWS, { mode: "atr", atrLength: 3 });
  assert.equal(options.mode, "atr");
  assert.equal(options.boxSize, 4);
  assert.match(options.configKey, /^renko:atr:3:/);
});

test("traditional Renko box sizes align to the inferred price tick", () => {
  const rows = [{ time: 1, open: 1.234, high: 1.238, low: 1.23, close: 1.237 }];
  assert.equal(inferRenkoMinimumTick(rows, 0.1), 0.001);
  assert.deepEqual(
    resolveRenkoProjectorOptions(rows, { mode: "traditional", boxSize: 0.1 }),
    {
      atrLength: 14,
      boxSize: 0.1,
      configKey: "renko:traditional:14:0.1:0.001",
      minTick: 0.001,
      mode: "traditional",
    },
  );
});

test("empty and invalid runtime settings resolve to safe deterministic options", () => {
  assert.deepEqual(
    resolveRenkoProjectorOptions([], { mode: "unknown", atrLength: 1, boxSize: 0 }),
    {
      atrLength: 2,
      boxSize: 1,
      configKey: "renko:atr:2:1:1",
      minTick: 1,
      mode: "atr",
    },
  );
});
