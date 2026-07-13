import assert from "node:assert/strict";
import test from "node:test";

import { buildRealtimeTrackedIntervals } from "../trackedIntervalsPolicy.js";

test("tracked intervals subscribe only current interval plus 1m", () => {
  assert.deepEqual(buildRealtimeTrackedIntervals("15m"), ["15m", "1m"]);
});

test("tracked intervals dedupe current 1m", () => {
  assert.deepEqual(buildRealtimeTrackedIntervals("1m"), ["1m"]);
});

test("tracked intervals keep 1s special case with 1m price feed", () => {
  assert.deepEqual(buildRealtimeTrackedIntervals("1s"), ["1s", "1m"]);
});

test("tracked intervals keep custom current interval with 1m", () => {
  assert.deepEqual(buildRealtimeTrackedIntervals("45m"), ["45m", "1m"]);
});
