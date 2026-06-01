import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinateToFractionalLogical,
  logicalToCoordinateInterpolated,
  logicalToInterpolatedSeriesTime,
} from "../../../chart-adapter/coordinateBridge.js";

function assertAlmostEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("coordinateToFractionalLogical reverses Lightweight Charts ceil snapping", () => {
  const barSpacing = 8;
  const adapter = {
    isReady: () => true,
    coordinateToLogical: (x) => Math.ceil(x / barSpacing),
    logicalToCoordinate: (logical) => logical * barSpacing,
  };

  assertAlmostEqual(coordinateToFractionalLogical(adapter, 10.1 * barSpacing), 10.1);
  assertAlmostEqual(coordinateToFractionalLogical(adapter, 10.5 * barSpacing), 10.5);
  assertAlmostEqual(coordinateToFractionalLogical(adapter, 10.9 * barSpacing), 10.9);
});

test("logicalToInterpolatedSeriesTime uses the drawing series first logical as base", () => {
  const barSpacing = 8;
  const firstGlobalLogical = 100;
  const seriesData = Array.from({ length: 12 }, (_, index) => ({
    time: 1000 + index * 60,
  }));

  const adapter = {
    isReady: () => true,
    getSeriesData: () => seriesData,
    timeToCoordinate: (time) => {
      const localIndex = (time - seriesData[0].time) / 60;
      return (firstGlobalLogical + localIndex) * barSpacing;
    },
    coordinateToLogical: (x) => Math.ceil(x / barSpacing),
  };

  assertAlmostEqual(
    logicalToInterpolatedSeriesTime(adapter, firstGlobalLogical + 10.5),
    1000 + 10.5 * 60,
  );
});

test("logicalToCoordinateInterpolated keeps fractional logical fallback away from x=0", () => {
  const barSpacing = 8;
  const timeScale = {
    logicalToCoordinate: (logical) => (Number.isInteger(logical) ? logical * barSpacing : 0),
  };

  assertAlmostEqual(logicalToCoordinateInterpolated(timeScale, 10.5), 10.5 * barSpacing);
});
