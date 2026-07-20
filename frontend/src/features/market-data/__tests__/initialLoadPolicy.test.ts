import assert from "node:assert/strict";
import test from "node:test";

import { shouldRequestInitialLatest } from "../useChartInitialLoad.js";

test("initial latest is reserved for exchange-native intervals", () => {
  const nativeIntervals = ["1m", "5m", "1h", "4h"];

  assert.equal(shouldRequestInitialLatest("1m", nativeIntervals), true);
  assert.equal(shouldRequestInitialLatest("60m", nativeIntervals), true);
  assert.equal(shouldRequestInitialLatest("47m", nativeIntervals), false);
  assert.equal(shouldRequestInitialLatest("8h", nativeIntervals), false);
});
