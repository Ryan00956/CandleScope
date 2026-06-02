import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinateToFractionalLogical,
  dataPointToCoordinate,
  futureBarOffsetFromLogical,
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

test("futureBarOffsetFromLogical stores right-side drawing anchors relative to the last bar", () => {
  const seriesData = Array.from({ length: 10 }, (_, index) => ({ time: 1000 + index * 60 }));
  const adapter = {
    isReady: () => true,
    getSeriesData: () => seriesData,
    timeToCoordinate: (time) => ((time - 1000) / 60) * 8,
    coordinateToLogical: (x) => x / 8,
  };

  assert.equal(futureBarOffsetFromLogical(adapter, 12.2), 3);
  assert.equal(futureBarOffsetFromLogical(adapter, 9), null);
});

test("dataPointToCoordinate renders barOffsetFromLast against the current last bar", () => {
  const makeChart = (lastLogical) => ({
    timeScale: () => ({
      timeToCoordinate: (time) => (time === 2000 ? lastLogical * 8 : null),
      coordinateToLogical: (x) => x / 8,
      logicalToCoordinate: (logical) => logical * 8,
    }),
  });
  const series = {
    data: () => [{ time: 1000 }, { time: 2000 }],
  };

  assertAlmostEqual(dataPointToCoordinate(makeChart(20), series, { barOffsetFromLast: 2, price: 1 }), 22 * 8);
  assertAlmostEqual(dataPointToCoordinate(makeChart(24), series, { barOffsetFromLast: 2, price: 1 }), 26 * 8);
});
