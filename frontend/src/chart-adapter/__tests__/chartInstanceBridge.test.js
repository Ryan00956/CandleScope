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

test("adapter exposes the drawable time-scale width separately from the chart container", () => {
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        timeScale: () => ({ width: () => 912 }),
      },
    },
    seriesRef: { current: {} },
  });

  assert.equal(adapter.getTimeScaleWidth(), 912);
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

test("future drawing anchors use one atomic snapshot and persist only absolute source time", () => {
  const rows = [displayRow(0, 100, 0), displayRow(1, 200, 0)];
  const lineageIndex = createDrawingLineageIndex(rows);
  let snapshotCalls = 0;
  let intervalIdReads = 0;
  let intervalReads = 0;
  let horizonReads = 0;
  let snapshotOwnsHorizon = true;
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        timeScale: () => ({
          coordinateToLogical: (x) => x / 10,
          coordinateToTime: (x) => rows.find((row) => row.time.order === Math.round(x / 10))?.time || null,
          logicalToCoordinate: (logical) => logical * 10,
          options: () => ({ barSpacing: 10 }),
          timeToCoordinate: (time) => time.order * 10,
        }),
      },
    },
    seriesRef: { current: {} },
    sourceIntervalRef: {
      get current() {
        intervalIdReads += 1;
        return "2m";
      },
    },
    sourceIntervalSecondsRef: {
      get current() {
        intervalReads += 1;
        return 120;
      },
    },
    sourceTimeHorizonRef: {
      get current() {
        horizonReads += 1;
        return 300;
      },
    },
    projectionConfigRef: { current: "dataset-a:renko:10" },
    drawingCoordinateSnapshotProvider: () => {
      snapshotCalls += 1;
      return {
        indexRevision: lineageIndex.revision,
        ordinalSeriesIndex: lineageIndex,
        seriesData: rows,
        ...(snapshotOwnsHorizon ? {
          sourceInterval: "1m",
          sourceIntervalSeconds: 60,
          sourceTimeHorizon: 200,
        } : {}),
      };
    },
  });

  const fromSnapshot = adapter.coordinateToDrawingAnchor(15);
  assert.deepEqual(fromSnapshot, { time: 230 });
  assert.equal(snapshotCalls, 1);
  assert.equal(intervalIdReads, 0);
  assert.equal(intervalReads, 0);
  assert.equal(horizonReads, 0);
  assert.equal(JSON.stringify(fromSnapshot).includes("order"), false);
  assert.equal(JSON.stringify(fromSnapshot).includes("logical"), false);

  snapshotOwnsHorizon = false;
  const fromFallbackRef = adapter.coordinateToDrawingAnchor(15);
  assert.deepEqual(fromFallbackRef, { time: 360 });
  assert.equal(snapshotCalls, 2);
  assert.equal(intervalIdReads, 1);
  assert.equal(intervalReads, 1);
  assert.equal(horizonReads, 1);
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

test("freehand capture reads one atomic snapshot per batch and keeps tail-stable identity", () => {
  const prefix = [displayRow(0, 100, 0), displayRow(1, 100, 1)];
  let rows = prefix.concat(displayRow(2, 200, 0));
  const index = createDrawingLineageIndex(rows);
  let snapshotCalls = 0;
  let configReads = 0;
  let horizonReads = 0;
  let intervalIdReads = 0;
  let intervalReads = 0;
  let seriesReads = 0;
  const configRef = {
    get current() {
      configReads += 1;
      return "dataset-a:renko:10";
    },
  };
  const horizonRef = {
    get current() {
      horizonReads += 1;
      return 300;
    },
  };
  const chart = {
    timeScale: () => ({
      coordinateToTime: (x) => (
        rows.find((row) => row.time.order === Math.round(x / 10))?.time || null
      ),
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = { coordinateToPrice: (y) => 100 - y };
  const seriesRef = {
    get current() {
      seriesReads += 1;
      return series;
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    seriesRef,
    projectionConfigRef: configRef,
    sourceIntervalRef: {
      get current() {
        intervalIdReads += 1;
        return "1m";
      },
    },
    sourceIntervalSecondsRef: {
      get current() {
        intervalReads += 1;
        return 60;
      },
    },
    sourceTimeHorizonRef: horizonRef,
    drawingCoordinateSnapshotProvider: () => {
      snapshotCalls += 1;
      return {
        indexRevision: index.revision,
        ordinalSeriesIndex: index,
        seriesData: rows,
      };
    },
  });

  const first = adapter.captureFreehandStrokeBatch([{ x: 5, y: 10 }]);
  assert.ok(first);
  assert.deepEqual(first.captures[0].span.exact, {
    left: { time: 100, sourceOrdinal: 0 },
    right: { time: 100, sourceOrdinal: 1 },
  });
  assert.equal(snapshotCalls, 1);
  assert.equal(configReads, 1);
  assert.equal(horizonReads, 1);
  assert.equal(intervalIdReads, 1);
  assert.equal(intervalReads, 1);
  assert.equal(seriesReads, 1);
  assert.equal(JSON.stringify(first).includes("order"), false);
  assert.equal(JSON.stringify(first).includes("logical"), false);

  const nextTail = displayRow(2, 201, 0);
  const nextRows = prefix.concat(nextTail);
  assert.equal(index.replaceTail({
    previousSeriesData: rows,
    fromOutputIndex: 2,
    insert: [nextTail],
    nextSeriesData: nextRows,
  }), true);
  rows = nextRows;
  const second = adapter.captureFreehandStrokeBatch([{ x: 5, y: 20 }]);
  assert.ok(second);
  assert.strictEqual(second.captureIdentity, first.captureIdentity);
  assert.equal(snapshotCalls, 2);
  assert.equal(configReads, 2);
  assert.equal(horizonReads, 2);
  assert.equal(intervalIdReads, 2);
  assert.equal(intervalReads, 2);
  assert.equal(seriesReads, 2);
  assert.equal(Object.isFrozen(first.captureIdentity), true);
  assert.equal(Object.keys(first.captureIdentity).length, 0);
});
