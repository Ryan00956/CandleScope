import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinateToFractionalLogical,
  dataPointToCoordinate,
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

test("logicalToInterpolatedSeriesTime stores right-side drawing anchors as absolute future time", () => {
  const seriesData = Array.from({ length: 10 }, (_, index) => ({ time: 1000 + index * 60 }));
  const adapter = {
    isReady: () => true,
    getSeriesData: () => seriesData,
    timeToCoordinate: (time) => ((time - 1000) / 60) * 8,
    coordinateToLogical: (x) => x / 8,
  };

  assertAlmostEqual(logicalToInterpolatedSeriesTime(adapter, 12.2), 1000 + 12.2 * 60);
  assertAlmostEqual(logicalToInterpolatedSeriesTime(adapter, 9), 1000 + 9 * 60);
});

test("dataPointToCoordinate extrapolates absolute future time from the last two bars", () => {
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time) => {
        if (time === 1000) return 0;
        if (time === 1060) return 8;
        return null;
      },
      coordinateToLogical: (x) => x / 8,
      logicalToCoordinate: (logical) => logical * 8,
    }),
  };
  const series = {
    data: () => [{ time: 1000 }, { time: 1060 }],
  };

  assertAlmostEqual(dataPointToCoordinate(chart, series, { time: 1180, price: 1 }), 24);
});

test("dataPointToCoordinate prefers time over stale logical when both are present", () => {
  let dataCalls = 0;
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time) => {
        if (time === 1000) return 0;
        if (time === 1060) return 10;
        return null;
      },
      logicalToCoordinate: (logical) => logical * 10,
    }),
  };
  const series = {
    data: () => {
      dataCalls += 1;
      return [{ time: 1000 }, { time: 1060 }];
    },
  };

  assertAlmostEqual(
    dataPointToCoordinate(chart, series, { time: 1030, logical: 99, price: 1 }),
    5,
  );
  assert.equal(dataCalls, 1);
});

test("dataPointToCoordinate reuses cached series data for legacy fractional time points", () => {
  let dataCalls = 0;
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time) => {
        if (time === 1000) return 0;
        if (time === 1060) return 10;
        if (time === 1120) return 20;
        return null;
      },
      logicalToCoordinate: (logical) => logical * 10,
    }),
  };
  const series = {
    data: () => {
      dataCalls += 1;
      return [{ time: 1000 }, { time: 1060 }, { time: 1120 }];
    },
  };
  const context = {};

  assertAlmostEqual(dataPointToCoordinate(chart, series, { time: 1030, price: 1 }, context), 5);
  assertAlmostEqual(dataPointToCoordinate(chart, series, { time: 1090, price: 1 }, context), 15);
  assert.equal(dataCalls, 1);
});
