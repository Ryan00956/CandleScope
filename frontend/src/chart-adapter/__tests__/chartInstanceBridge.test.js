import assert from "node:assert/strict";
import test from "node:test";

import { createLightweightChartAdapter } from "../chartInstanceBridge.js";
import { dataPointToCoordinate } from "../coordinateBridge.js";
import { createDrawingLineageIndex } from "../../features/chart-representation/drawingLineageIndex.js";
import { ProjectionStore } from "../../features/chart-representation/projectionStore.js";
import { LineBreakProjector } from "../../features/chart-representation/projectors/lineBreakProjector.js";

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

function sourceRow(time, close) {
  return {
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1,
    is_closed: true,
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
  const lineageIndex = createDrawingLineageIndex(rows);
  let fallbackDataCalls = 0;
  let snapshotCalls = 0;
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
    drawingCoordinateSnapshotProvider: () => {
      snapshotCalls += 1;
      return {
        indexRevision: lineageIndex.revision,
        ordinalSeriesIndex: lineageIndex,
        seriesData: rows,
      };
    },
  });

  assert.equal(adapter.attachPrimitive({}), true);
  assert.equal(attachedCoordinate, 10);
  assert.equal(fallbackDataCalls, 0);
  assert.equal(snapshotCalls, 1);
});

test("projection snapshots keep primitive coordinates on the current incremental tail", () => {
  const size = 2_000;
  const sourceRows = Array.from(
    { length: size },
    (_, index) => sourceRow(index + 1, 100 + index),
  );
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  store.reset(sourceRows);
  const staleDisplayRows = store.displaySnapshot();
  const nextSourceRows = sourceRows.concat(sourceRow(size + 1, 100 + size));
  store.applySourceDelta({ type: "tick", appended: true }, nextSourceRows);
  const currentDisplayRows = store.displaySnapshot();
  const firstRow = currentDisplayRows[0];
  const lastRow = currentDisplayRows[currentDisplayRows.length - 1];
  Object.defineProperty(firstRow, "customValues", {
    configurable: true,
    get() {
      throw new Error("stable projected prefix metadata was rescanned");
    },
  });

  let fallbackDataCalls = 0;
  let attachedCoordinates = null;
  const chart = {
    timeScale: () => ({ timeToCoordinate: (time) => time.order * 5 }),
  };
  const series = {
    attachPrimitive: () => {
      const context = {};
      attachedCoordinates = [
        dataPointToCoordinate(chart, series, { time: firstRow.time.sourceTime }, context),
        dataPointToCoordinate(chart, series, { time: lastRow.time.sourceTime }, context),
      ];
    },
    data: () => {
      fallbackDataCalls += 1;
      return staleDisplayRows;
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => store.drawingCoordinateSnapshot(),
    seriesDataRef: { current: staleDisplayRows },
    seriesRef: { current: series },
    sourceTimeHorizonRef: { current: size + 1 },
  });

  assert.equal(adapter.attachPrimitive({}), true);
  assert.deepEqual(attachedCoordinates, [firstRow.time.order * 5, lastRow.time.order * 5]);
  assert.equal(fallbackDataCalls, 0);
  assert.strictEqual(
    store.drawingCoordinateSnapshot().ordinalSeriesIndex.seriesData,
    currentDisplayRows,
  );
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
