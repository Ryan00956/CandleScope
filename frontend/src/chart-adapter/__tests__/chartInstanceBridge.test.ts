import assert from "node:assert/strict";
import test from "node:test";

import { createLightweightChartAdapter as createProductionAdapter } from "../chartInstanceBridge.js";
import {
  dataPointToCoordinate,
  isOrdinalAxisTime,
  type DrawingCoordinateContext,
} from "../coordinateBridge.js";
import { createDrawingFrameSnapshotFactory } from "../drawingFrameSnapshot.js";
import { createDrawingLineageIndex } from "../../features/chart-representation/drawingLineageIndex.js";
import { ProjectionStore } from "../../features/chart-representation/projectionStore.js";
import { LineBreakProjector } from "../../features/chart-representation/projectors/lineBreakProjector.js";
import type {
  DisplayRow,
  OrdinalAxisTime,
  ProjectionMetadata,
  SourceBar,
} from "../../features/chart-representation/chartRepresentationTypes.js";
import { mustBeDefined, structuralMock } from "../../test/testHelpers.js";

type AdapterConfig = NonNullable<Parameters<typeof createProductionAdapter>[0]>;
type TestDisplayRow = DisplayRow & {
  time: OrdinalAxisTime;
  customValues: { chartProjection: Readonly<ProjectionMetadata> };
};

function createLightweightChartAdapter(config: Record<string, unknown>) {
  return createProductionAdapter(structuralMock<AdapterConfig>(config));
}

function ordinal(order: number, sourceTime: number, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

function displayRow(order: number, sourceTime: number, sourceOrdinal = 0): TestDisplayRow {
  return {
    time: ordinal(order, sourceTime, sourceOrdinal),
    customValues: {
      chartProjection: {
        projectorId: "renko",
        sourceFromTime: sourceTime,
        sourceOrdinal,
        sourceToTime: sourceTime,
        synthetic: true,
      },
    },
  };
}

function sourceRow(time: number, close: number): SourceBar {
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

function ordinalTime(row: DisplayRow): OrdinalAxisTime {
  if (!isOrdinalAxisTime(row.time)) throw new Error("Expected ordinal display time");
  return row.time;
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
        timeToCoordinate: (time: unknown) => {
          if (!isOrdinalAxisTime(time)) throw new TypeError("ordinal time required");
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
  assert.deepEqual(adapter.axisTimeToDrawingAnchor(mustBeDefined(rows[1]).time), {
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

test("coordinate contexts prefer one atomic snapshot projection config over a conflicting ref", () => {
  const rows = [displayRow(0, 100, 0), displayRow(1, 200, 0)];
  const lineageIndex = createDrawingLineageIndex(rows);
  let snapshotReads = 0;
  let configRefReads = 0;
  const adapter = createLightweightChartAdapter({
    chartRef: { current: {} },
    seriesRef: { current: {} },
    projectionConfigRef: {
      get current() {
        configRefReads += 1;
        return "dataset-stale:kagi:5";
      },
    },
    drawingCoordinateSnapshotProvider: () => {
      snapshotReads += 1;
      return {
        drawingProjectionConfig: "dataset-a:renko:10",
        indexRevision: lineageIndex.revision,
        ordinalSeriesIndex: lineageIndex,
        seriesData: rows,
      };
    },
  });

  assert.deepEqual(adapter.axisTimeToDrawingAnchor(mustBeDefined(rows[1]).time), {
    time: 200,
    sourceOrdinal: 0,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });
  assert.equal(snapshotReads, 1);
  assert.equal(configRefReads, 0);
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
          coordinateToLogical: (x: number) => x / 10,
          coordinateToTime: (x: number) => rows.find((row) => row.time.order === Math.round(x / 10))?.time || null,
          logicalToCoordinate: (logical: number) => logical * 10,
          options: () => ({ barSpacing: 10 }),
          timeToCoordinate: (time: unknown) => (
            isOrdinalAxisTime(time) ? time.order * 10 : null
          ),
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
      timeToCoordinate: (time: unknown) => (
        isOrdinalAxisTime(time) ? time.order * 10 : null
      ),
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

test("adapter operations hydrate one real drawing frame snapshot into the coordinate context", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }, { time: 300 }];
  const factory = createDrawingFrameSnapshotFactory();
  const baseInput = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    drawingProjectionConfig: "dataset-a:time:1m",
    heightCssPx: 600,
    projectionKey: "dataset-a:time:1m",
    seriesData: rows,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 300,
    surfaceToken: "surface-a",
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  };
  const initialSnapshot = factory.capture(baseInput);
  const viewportSnapshot = factory.capture({
    ...baseInput,
    viewportKey: "viewport-b",
  });

  assert.notStrictEqual(viewportSnapshot, initialSnapshot);
  assert.equal(
    viewportSnapshot.viewportRevision,
    initialSnapshot.viewportRevision + 1,
  );
  assert.equal(viewportSnapshot.worldRevisionKey, initialSnapshot.worldRevisionKey);
  assert.equal(viewportSnapshot.dataRevision, initialSnapshot.dataRevision);
  assert.equal(viewportSnapshot.projectionRevision, initialSnapshot.projectionRevision);
  assert.equal(
    viewportSnapshot.lineageIndexRevision,
    initialSnapshot.lineageIndexRevision,
  );
  assert.strictEqual(viewportSnapshot.coordinateIndex, initialSnapshot.coordinateIndex);
  assert.equal(viewportSnapshot.coordinateIndex.validationCount, 1);

  const reads = {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    seriesData: 0,
    snapshot: 0,
  };
  const coordinateContext: DrawingCoordinateContext = {};
  let attachedCoordinate: number | null = null;
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time: unknown) => {
        if (time === 100) return 10;
        if (time === 200) return 20;
        if (time === 300) return 30;
        return null;
      },
    }),
  };
  const series = {
    attachPrimitive: () => {
      attachedCoordinate = dataPointToCoordinate(
        chart,
        series,
        { time: 150 },
        coordinateContext,
      );
    },
    data: () => {
      reads.seriesData += 1;
      return rows;
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    seriesRef: { current: series },
    seriesDataRef: {
      get current() {
        reads.seriesData += 1;
        return rows;
      },
    },
    projectionConfigRef: {
      get current() {
        reads.config += 1;
        return "dataset-stale:kagi:5";
      },
    },
    sourceIntervalRef: {
      get current() {
        reads.interval += 1;
        return "2m";
      },
    },
    sourceIntervalSecondsRef: {
      get current() {
        reads.intervalSeconds += 1;
        return 120;
      },
    },
    sourceTimeHorizonRef: {
      get current() {
        reads.horizon += 1;
        return 999;
      },
    },
    drawingCoordinateSnapshotProvider: () => {
      reads.snapshot += 1;
      return viewportSnapshot;
    },
  });

  assert.equal(adapter.attachPrimitive({}), true);
  assert.equal(attachedCoordinate, 15);
  assert.deepEqual(reads, {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    seriesData: 0,
    snapshot: 1,
  });
  assert.strictEqual(coordinateContext.drawingFrameSnapshot, viewportSnapshot);
  assert.strictEqual(
    coordinateContext.drawingCoordinateIndex,
    viewportSnapshot.coordinateIndex,
  );
  assert.strictEqual(coordinateContext.seriesData, viewportSnapshot.seriesData);
  assert.equal(
    coordinateContext.drawingProjectionConfig,
    viewportSnapshot.drawingProjectionConfig,
  );
  assert.equal(coordinateContext.sourceInterval, viewportSnapshot.sourceInterval);
  assert.equal(
    coordinateContext.sourceIntervalSeconds,
    viewportSnapshot.sourceIntervalSeconds,
  );
  assert.equal(
    coordinateContext.sourceTimeHorizon,
    viewportSnapshot.sourceTimeHorizon,
  );
  const contextSnapshot = coordinateContext.drawingFrameSnapshot as typeof viewportSnapshot;
  assert.strictEqual(contextSnapshot.coordinateIndex, viewportSnapshot.coordinateIndex);
  assert.equal(contextSnapshot.dataRevision, viewportSnapshot.dataRevision);
  assert.equal(contextSnapshot.projectionRevision, viewportSnapshot.projectionRevision);
  assert.equal(
    contextSnapshot.lineageIndexRevision,
    viewportSnapshot.lineageIndexRevision,
  );
  assert.equal(contextSnapshot.worldRevisionKey, viewportSnapshot.worldRevisionKey);
  assert.equal(viewportSnapshot.coordinateIndex.validationCount, 1);
  assert.equal(
    viewportSnapshot.coordinateIndex.stats.numericBinarySearchCount
      + viewportSnapshot.coordinateIndex.stats.numericBatchMergeWalkCount,
    1,
  );
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
  const firstRow = mustBeDefined(currentDisplayRows[0]);
  const lastRow = mustBeDefined(currentDisplayRows[currentDisplayRows.length - 1]);
  Object.defineProperty(firstRow, "customValues", {
    configurable: true,
    get() {
      throw new Error("stable projected prefix metadata was rescanned");
    },
  });

  let fallbackDataCalls = 0;
  let attachedCoordinates = null;
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time: unknown) => (
        isOrdinalAxisTime(time) ? time.order * 5 : null
      ),
    }),
  };
  const series = {
    attachPrimitive: () => {
      const context = {};
      attachedCoordinates = [
        dataPointToCoordinate(chart, series, { time: ordinalTime(firstRow).sourceTime }, context),
        dataPointToCoordinate(chart, series, { time: ordinalTime(lastRow).sourceTime }, context),
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
  assert.deepEqual(attachedCoordinates, [
    ordinalTime(firstRow).order * 5,
    ordinalTime(lastRow).order * 5,
  ]);
  assert.equal(fallbackDataCalls, 0);
  assert.strictEqual(
    mustBeDefined(store.drawingCoordinateSnapshot().ordinalSeriesIndex).seriesData,
    currentDisplayRows,
  );
});

test("adapter keeps numeric drawing anchor behavior for time axes", () => {
  const rows = [{ time: 100 }, { time: 200 }];
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        timeScale: () => ({
          timeToCoordinate: (time: unknown) => (
            typeof time === "number" ? time / 10 : null
          ),
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
      return "dataset-stale:kagi:5";
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
      coordinateToTime: (x: number) => (
        rows.find((row) => row.time.order === Math.round(x / 10))?.time || null
      ),
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time: unknown) => (
        isOrdinalAxisTime(time) ? time.order * 10 : null
      ),
    }),
  };
  const series = { coordinateToPrice: (y: number) => 100 - y };
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
        drawingProjectionConfig: "dataset-a:renko:10",
        indexRevision: index.revision,
        ordinalSeriesIndex: index,
        seriesData: rows,
      };
    },
  });

  const first = adapter.captureFreehandStrokeBatch([{ x: 5, y: 10 }]);
  assert.ok(first);
  assert.deepEqual(mustBeDefined(first.captures[0]?.span).exact, {
    left: { time: 100, sourceOrdinal: 0 },
    right: { time: 100, sourceOrdinal: 1 },
  });
  assert.equal(first.sourceProjectionConfig, "dataset-a:renko:10");
  assert.equal(snapshotCalls, 1);
  assert.equal(configReads, 0);
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
  assert.equal(configReads, 0);
  assert.equal(horizonReads, 2);
  assert.equal(intervalIdReads, 2);
  assert.equal(intervalReads, 2);
  assert.equal(seriesReads, 2);
  assert.equal(Object.isFrozen(first.captureIdentity), true);
  assert.equal(Object.keys(first.captureIdentity).length, 0);
});

test("freehand future capture uses snapshot-owned config, horizon, and interval", () => {
  const rows = [displayRow(0, 100, 0), displayRow(1, 200, 0)];
  const index = createDrawingLineageIndex(rows);
  const reads = { config: 0, horizon: 0, interval: 0, intervalSeconds: 0, snapshot: 0 };
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        timeScale: () => ({
          coordinateToTime: (x: number) => rows.find(
            (row) => row.time.order === Math.round(x / 10),
          )?.time || null,
          options: () => ({ barSpacing: 10 }),
          timeToCoordinate: (time: unknown) => (
            isOrdinalAxisTime(time) ? time.order * 10 : null
          ),
          width: () => 100,
        }),
      },
    },
    seriesRef: { current: { coordinateToPrice: (y: number) => 100 - y } },
    projectionConfigRef: {
      get current() {
        reads.config += 1;
        return "dataset-stale:kagi:5";
      },
    },
    sourceTimeHorizonRef: {
      get current() {
        reads.horizon += 1;
        return 999;
      },
    },
    sourceIntervalRef: {
      get current() {
        reads.interval += 1;
        return "2m";
      },
    },
    sourceIntervalSecondsRef: {
      get current() {
        reads.intervalSeconds += 1;
        return 120;
      },
    },
    drawingCoordinateSnapshotProvider: () => {
      reads.snapshot += 1;
      return {
        drawingProjectionConfig: "dataset-a:renko:10",
        indexRevision: index.revision,
        ordinalSeriesIndex: index,
        seriesData: rows,
        sourceInterval: "1m",
        sourceIntervalSeconds: 60,
        sourceTimeHorizon: 200,
      };
    },
  });

  const batch = mustBeDefined(adapter.captureFreehandStrokeBatch([{ x: 15, y: 20 }]));
  assert.deepEqual(batch.captures[0], {
    time: 230,
    price: 80,
    screen: { x: 15, y: 20 },
  });
  assert.equal(batch.sourceProjectionConfig, "dataset-a:renko:10");
  assert.deepEqual(reads, {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    snapshot: 1,
  });
});
