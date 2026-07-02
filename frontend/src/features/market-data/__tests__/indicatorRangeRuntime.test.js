import assert from "node:assert/strict";
import test from "node:test";

import { requestIndicatorRangeInChunks } from "../indicatorRangeRuntime.js";

test("indicator range runtime forwards the full range once", () => {
  const calls = [];

  requestIndicatorRangeInChunks((start, end) => {
    calls.push({ start, end });
  }, 1_700_000_000, 1_700_360_000);

  assert.deepEqual(calls, [{
    start: 1_700_000_000,
    end: 1_700_360_000,
  }]);
});
