import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_METRICS_DPR_EPSILON,
  devicePixelRatioMatches,
} from "./drawing-device-metrics.mjs";

test("device DPR matching accepts Chrome float noise but rejects real scale drift", () => {
  assert.equal(DEVICE_METRICS_DPR_EPSILON, 0.001);
  assert.equal(devicePixelRatioMatches(1, 1), true);
  assert.equal(devicePixelRatioMatches(1.0000000298023224, 1), true);
  assert.equal(devicePixelRatioMatches(1.5, 1.5), true);
  assert.equal(devicePixelRatioMatches(1.01, 1), false);
  assert.equal(devicePixelRatioMatches(2, 1), false);
  assert.equal(devicePixelRatioMatches(0, 1), false);
  assert.equal(devicePixelRatioMatches(Number.NaN, 1), false);
});
