import assert from "node:assert/strict";
import test from "node:test";

import { resolveKagiProjectorOptions } from "../kagiProjectionOptions.js";

const ROWS = [
  { time: 1, open: 100, high: 103, low: 99, close: 102 },
  { time: 2, open: 102, high: 106, low: 101, close: 105 },
  { time: 3, open: 105, high: 107, low: 103, close: 104 },
];

test("Kagi ATR resolves one fixed reversal distance", () => {
  assert.deepEqual(
    resolveKagiProjectorOptions(ROWS, { mode: "atr", atrLength: 3 }),
    {
      atrLength: 3,
      configKey: "kagi:atr:3:4:1",
      minTick: 1,
      mode: "atr",
      reversalAmount: 4,
      reversalTicks: 4,
    },
  );
});

test("traditional Kagi reversal distances align to the inferred minimum tick", () => {
  const rows = [{ time: 1, open: 1.234, high: 1.238, low: 1.23, close: 1.237 }];
  assert.deepEqual(
    resolveKagiProjectorOptions(rows, { mode: "traditional", reversalAmount: 0.1 }),
    {
      atrLength: 14,
      configKey: "kagi:traditional:14:0.1:0.001",
      minTick: 0.001,
      mode: "traditional",
      reversalAmount: 0.1,
      reversalTicks: 100,
    },
  );
});

test("invalid Kagi options fall back deterministically", () => {
  assert.deepEqual(
    resolveKagiProjectorOptions([], {
      mode: "unknown",
      atrLength: 1,
      reversalAmount: 0,
    }),
    {
      atrLength: 2,
      configKey: "kagi:atr:2:1:1",
      minTick: 1,
      mode: "atr",
      reversalAmount: 1,
      reversalTicks: 1,
    },
  );
});
