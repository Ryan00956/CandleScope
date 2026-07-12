import assert from "node:assert/strict";
import test from "node:test";

import { createLightweightChartAdapter } from "../chartInstanceBridge.js";
import { dataPointToCoordinate } from "../coordinateBridge.js";

function ordinal(order, sourceTime, sourceOrdinal = 0) {
  return { order, sourceTime, sourceOrdinal };
}

function displayRow(order, sourceTime, sourceOrdinal = 0) {
  return {
    time: ordinal(order, sourceTime, sourceOrdinal),
    customValues: {
      chartProjection: {
        projectorId: "renko",
        sourceFromTime: sourceTime,
        sourceOrdinal,
        sourceToTime: sourceTime,
      },
    },
  };
}

test("visible range reads return null while Lightweight Charts is between datasets", () => {
  const chartRef = {
    current: {
      timeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 10, to: 20 }),
        getVisibleRange() {
          throw new Error("Value is null");
        },
        options: () => ({ barSpacing: 6 }),
        scrollPosition: () => 0,
      }),
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef,
    seriesRef: { current: {} },
  });

  assert.equal(adapter.getVisibleRange(), null);
  assert.equal(adapter.getVisibleTimeRange(), null);
});

test("adapter exposes persistence-safe ordinal drawing coordinates", () => {
  const rows = [
    displayRow(0, 100, 0),
    displayRow(1, 100, 1),
    displayRow(2, 200, 0),
  ];
  let logicalCalls = 0;
  const chartRef = {
    current: {
      timeScale: () => ({
        timeToCoordinate: (time) => {
          if (!time || typeof time !== "object") throw new TypeError("ordinal time required");
          return time.order * 12;
        },
        logicalToCoordinate: () => {
          logicalCalls += 1;
          return 999;
        },
      }),
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef,
    seriesRef: { current: { data: () => rows } },
    seriesDataRef: { current: rows },
    sourceTimeHorizonRef: { current: 400 },
    projectionConfigRef: { current: "dataset-a:renko:10" },
  });

  assert.equal(adapter.usesOrdinalTime(), true);
  assert.deepEqual(adapter.axisTimeToDrawingAnchor(rows[1].time), {
    time: 100,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });
  assert.equal(adapter.dataPointToCoordinate({
    time: 100,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
    logical: 99,
  }), 12);
  assert.equal(adapter.dataPointToCoordinate({ time: 300, logical: 99 }), 24);
  assert.equal(adapter.dataPointToCoordinate({ time: 500, logical: 99 }), null);
  assert.equal(logicalCalls, 0);
});

test("adapter registers stable drawing context before primitive attachment", () => {
  const rows = [displayRow(0, 100, 0), displayRow(1, 200, 0)];
  let fallbackDataCalls = 0;
  let attachedCoordinate = null;
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = {
    attachPrimitive: () => {
      attachedCoordinate = dataPointToCoordinate(chart, series, { time: 300 });
    },
    data: () => {
      fallbackDataCalls += 1;
      return [...rows];
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    seriesRef: { current: series },
    seriesDataRef: { current: rows },
    sourceTimeHorizonRef: { current: 400 },
    projectionConfigRef: { current: "dataset-a:renko:10" },
  });

  assert.equal(adapter.attachPrimitive({}), true);
  assert.equal(attachedCoordinate, 10);
  assert.equal(fallbackDataCalls, 0);
});

test("adapter keeps numeric drawing anchor behavior for time axes", () => {
  const rows = [{ time: 100 }, { time: 200 }];
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        timeScale: () => ({
          timeToCoordinate: (time) => time / 10,
        }),
      },
    },
    seriesRef: { current: { data: () => rows } },
    seriesDataRef: { current: rows },
  });

  assert.equal(adapter.usesOrdinalTime(), false);
  assert.deepEqual(adapter.axisTimeToDrawingAnchor(150), { time: 150 });
  assert.equal(adapter.dataPointToCoordinate({ time: 150 }), 15);
});
