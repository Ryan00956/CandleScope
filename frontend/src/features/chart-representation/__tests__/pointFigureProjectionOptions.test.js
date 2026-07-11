import assert from "node:assert/strict";
import test from "node:test";

import { resolvePointFigureProjectorOptions } from "../pointFigureProjectionOptions.js";

const ROWS = [
  { time: 1, open: 100, high: 103, low: 99, close: 102 },
  { time: 2, open: 102, high: 106, low: 101, close: 105 },
  { time: 3, open: 105, high: 107, low: 103, close: 104 },
];

test("Point & Figure ATR resolves one fixed box size and reversal amount", () => {
  assert.deepEqual(
    resolvePointFigureProjectorOptions(ROWS, {
      mode: "atr",
      atrLength: 3,
      reversalAmount: 4,
    }),
    {
      atrLength: 3,
      boxSize: 4,
      configKey: "point-and-figure:atr:3:4:1:4",
      minTick: 1,
      mode: "atr",
      reversalAmount: 4,
    },
  );
});
test("traditional Point & Figure boxes align to the inferred minimum tick", () => {
  const rows = [{ time: 1, open: 1.234, high: 1.238, low: 1.23, close: 1.237 }];
  assert.deepEqual(
    resolvePointFigureProjectorOptions(rows, {
      mode: "traditional",
      boxSize: 0.1,
      reversalAmount: 3,
    }),
    {
      atrLength: 14,
      boxSize: 0.1,
      configKey: "point-and-figure:traditional:14:0.1:0.001:3",
      minTick: 0.001,
      mode: "traditional",
      reversalAmount: 3,
    },
  );
});

test("invalid Point & Figure options fall back deterministically", () => {
  assert.deepEqual(
    resolvePointFigureProjectorOptions([], {
      mode: "unknown",
      atrLength: 1,
      boxSize: 0,
      reversalAmount: 0,
    }),
    {
      atrLength: 2,
      boxSize: 1,
      configKey: "point-and-figure:atr:2:1:1:3",
      minTick: 1,
      mode: "atr",
      reversalAmount: 3,
    },
  );
});
