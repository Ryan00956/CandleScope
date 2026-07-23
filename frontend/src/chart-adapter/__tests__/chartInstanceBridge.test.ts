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

test("main-pane plot rect uses the public pane surface and offsets past only the left price scale", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const testWindow = { devicePixelRatio: 2.5 };
  const paneIndexes: Array<number | undefined> = [];
  const priceScaleRequests: Array<readonly [string, number | undefined]> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });

  try {
    const adapter = createLightweightChartAdapter({
      chartRef: {
        current: {
          paneSize: (paneIndex?: number) => {
            paneIndexes.push(paneIndex);
            return { width: 912, height: 438 };
          },
          priceScale: (priceScaleId: string, paneIndex?: number) => {
            priceScaleRequests.push([priceScaleId, paneIndex]);
            return { width: () => 64 };
          },
        },
      },
      seriesRef: { current: {} },
    });

    assert.deepEqual(adapter.getMainPanePlotRect(), {
      x: 64,
      y: 0,
      width: 912,
      height: 438,
      dpr: 2.5,
    });
    assert.deepEqual(paneIndexes, [0]);
    assert.deepEqual(priceScaleRequests, [["left", 0]]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("main-pane plot rect re-reads pane size, left scale width, and DPR after resize", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const testWindow = { devicePixelRatio: 1 };
  let pane = { width: 700, height: 320 };
  let leftPriceScaleWidth = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });

  try {
    const adapter = createLightweightChartAdapter({
      chartRef: {
        current: {
          paneSize: () => pane,
          priceScale: () => ({ width: () => leftPriceScaleWidth }),
        },
      },
      seriesRef: { current: {} },
    });

    assert.deepEqual(adapter.getMainPanePlotRect(), {
      x: 0,
      y: 0,
      width: 700,
      height: 320,
      dpr: 1,
    });

    pane = { width: 944, height: 511 };
    leftPriceScaleWidth = 57;
    testWindow.devicePixelRatio = 2;
    assert.deepEqual(adapter.getMainPanePlotRect(), {
      x: 57,
      y: 0,
      width: 944,
      height: 511,
      dpr: 2,
    });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("main-pane plot rect follows a reordered main pane and reports its DOM offset", () => {
  const paneIndexes: Array<number | undefined> = [];
  const priceScaleRequests: Array<readonly [string, number | undefined]> = [];
  const mainPaneIndexRef = { current: 2 };
  let containerTop = 100;
  let paneTop = 420;
  let containerRectReads = 0;
  let paneRectReads = 0;
  const paneElement = {
    getBoundingClientRect: () => {
      paneRectReads += 1;
      return { top: paneTop };
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        paneSize: (paneIndex?: number) => {
          paneIndexes.push(paneIndex);
          return { width: 900, height: 300 };
        },
        priceScale: (priceScaleId: string, paneIndex?: number) => {
          priceScaleRequests.push([priceScaleId, paneIndex]);
          return { width: () => 52 };
        },
      },
    },
    containerRef: {
      current: {
        getBoundingClientRect: () => {
          containerRectReads += 1;
          return { top: containerTop };
        },
      },
    },
    drawingPaneIndexRef: mainPaneIndexRef,
    seriesRef: {
      current: {
        coordinateToPrice: (coordinate: number) => coordinate / 2,
        getPane: () => ({
          getHTMLElement: () => paneElement,
        }),
        priceToCoordinate: (price: number) => price * 2,
      },
    },
  });

  const expectedPlotRect = {
    x: 52,
    y: 320,
    width: 900,
    height: 300,
    dpr: 1,
  };
  assert.deepEqual(adapter.getDrawingPanePlotRect(), expectedPlotRect);
  assert.deepEqual(adapter.getMainPanePlotRect(), expectedPlotRect);
  assert.equal(adapter.drawingPaneToContainerY(24), 344);
  assert.equal(adapter.containerToDrawingPaneY(344), 24);
  assert.equal(adapter.priceToCoordinate(12), 344);
  assert.equal(adapter.coordinateToPrice(344), 12);
  assert.equal(containerRectReads, 1);
  assert.equal(paneRectReads, 1);

  // Coordinate conversions use the cached pane/container relationship. A
  // layout owner invalidates it explicitly after a real pane move.
  containerTop = 120;
  paneTop = 500;
  assert.equal(adapter.drawingPaneToContainerY(24), 344);
  assert.equal(containerRectReads, 1);
  assert.equal(paneRectReads, 1);
  adapter.notifyDrawingFrameInvalidation();
  assert.equal(adapter.drawingPaneToContainerY(24), 404);
  assert.equal(adapter.priceToCoordinate(12), 404);
  assert.equal(containerRectReads, 2);
  assert.equal(paneRectReads, 2);
  assert.deepEqual(paneIndexes, [2, 2]);
  assert.deepEqual(priceScaleRequests, [["left", 2], ["left", 2]]);
});

test("drawing invalidation tolerates a disposed series and recovers for its replacement", () => {
  const seriesRef: {
    current: {
      getPane?: () => { getHTMLElement?: () => { getBoundingClientRect: () => { top: number } } };
    } | null;
  } = {
    current: {
      getPane: () => {
        throw new Error("Value is null");
      },
    },
  };
  const containerRef = {
    current: {
      getBoundingClientRect: () => ({ top: 100 }),
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: {} },
    containerRef,
    seriesRef,
  });

  assert.doesNotThrow(() => adapter.notifyDrawingFrameInvalidation());
  assert.equal(adapter.drawingPaneToContainerY(24), 24);

  seriesRef.current = {
    getPane: () => ({
      getHTMLElement: () => ({
        getBoundingClientRect: () => ({ top: 420 }),
      }),
    }),
  };
  adapter.notifyDrawingFrameInvalidation();

  assert.equal(adapter.drawingPaneToContainerY(24), 344);
});

test("main-pane plot rect fails closed for invalid public geometry without container fallback", () => {
  let pane: { width: number; height: number } | null = { width: 0, height: 320 };
  let leftPriceScaleWidth = 48;
  const adapter = createLightweightChartAdapter({
    chartRef: {
      current: {
        paneSize: () => pane,
        priceScale: () => ({ width: () => leftPriceScaleWidth }),
        timeScale: () => ({ width: () => 1_280 }),
      },
    },
    seriesRef: { current: {} },
  });

  assert.equal(adapter.getMainPanePlotRect(), null);
  pane = { width: 912, height: Number.NaN };
  assert.equal(adapter.getMainPanePlotRect(), null);
  pane = { width: 912, height: 438 };
  leftPriceScaleWidth = -1;
  assert.equal(adapter.getMainPanePlotRect(), null);
  pane = null;
  assert.equal(adapter.getMainPanePlotRect(), null);
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

test("atomic drawing frames preserve provider identity and bind to one series generation", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }];
  const seriesA = { priceToCoordinate: (price: number) => price };
  const seriesB = { priceToCoordinate: (price: number) => price * 2 };
  const seriesRef = { current: seriesA };
  const chart = { timeScale: () => ({}) };
  const factory = createDrawingFrameSnapshotFactory();
  const input = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    drawingProjectionConfig: "time:identity",
    heightCssPx: 600,
    projectionKey: "time:identity",
    seriesData: rows,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 200,
    surfaceToken: seriesA,
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  };
  let currentSnapshot = factory.capture(input);
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => currentSnapshot,
    seriesRef,
  });

  const captured = mustBeDefined(adapter.captureDrawingFrame());
  assert.strictEqual(captured, currentSnapshot);
  assert.equal(adapter.isDrawingFrameCurrent(captured), true);

  currentSnapshot = factory.capture({ ...input, viewportKey: "viewport-b" });
  assert.equal(adapter.isDrawingFrameCurrent(captured), false);
  const panned = mustBeDefined(adapter.captureDrawingFrame());
  assert.strictEqual(panned, currentSnapshot);

  seriesRef.current = seriesB;
  currentSnapshot = factory.capture({
    ...input,
    surfaceToken: seriesB,
    viewportKey: "viewport-b",
  });
  assert.equal(adapter.isDrawingFrameCurrent(panned), false);
  const replacement = mustBeDefined(adapter.captureDrawingFrame());
  assert.strictEqual(replacement, currentSnapshot);
  assert.equal(replacement.surfaceGeneration, panned.surfaceGeneration + 1);
  assert.equal(adapter.isDrawingFrameCurrent(replacement), true);
});

test("drawing frame batch projection returns interleaved Float64 XY without point objects", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }, { time: 300 }];
  const timeCoordinates = new Map<unknown, number>([
    [100, 10],
    [200, 20],
    [300, 30],
  ]);
  const chart = {
    timeScale: () => ({
      logicalToCoordinate: (logical: number) => logical * 10,
      timeToCoordinate: (time: unknown) => timeCoordinates.get(time) ?? null,
    }),
  };
  const series = { priceToCoordinate: (price: number) => 1_000 - price * 2 };
  const factory = createDrawingFrameSnapshotFactory();
  const snapshot = factory.capture({
    axisKind: "time",
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    heightCssPx: 600,
    projectionKey: "time:identity",
    seriesData: rows,
    surfaceToken: series,
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  });
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => snapshot,
    seriesRef: { current: series },
  });
  const frame = mustBeDefined(adapter.captureDrawingFrame());
  const coordinates = mustBeDefined(adapter.projectDrawingFrameDataPoints(frame, [
    { price: 10, time: 100 },
    { price: 20, time: 150 },
    { price: "invalid", time: 200 },
  ]));

  assert.equal(coordinates instanceof Float64Array, true);
  assert.deepEqual(Array.from(coordinates), [
    10, 980,
    15, 960,
    20, Number.NaN,
  ]);
  assert.equal(snapshot.coordinateIndex.stats.numericBatchMergeWalkCount, 1);
  assert.deepEqual(Array.from(mustBeDefined(adapter.projectDrawingFrameDataPoints(frame, [
    { price: 30, time: "invalid" },
  ]))), [Number.NaN, 940]);
});

test("drawing frame projection sessions bound provider reads and reject a stale whole build", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }];
  const factory = createDrawingFrameSnapshotFactory();
  const input = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    heightCssPx: 600,
    projectionKey: "time:identity",
    seriesData: rows,
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  };
  let currentSnapshot = factory.capture({ ...input, surfaceToken: "surface-a" });
  let providerReads = 0;
  let advanceDuringPriceProjection = false;
  const series = {
    priceToCoordinate: (price: number) => {
      if (advanceDuringPriceProjection) {
        advanceDuringPriceProjection = false;
        currentSnapshot = factory.capture({
          ...input,
          surfaceToken: "surface-a",
          viewportKey: "viewport-b",
        });
      }
      return 1_000 - price;
    },
  };
  currentSnapshot = factory.capture({ ...input, surfaceToken: series });
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time: unknown) => time === 100 ? 10 : time === 200 ? 20 : null,
    }),
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => {
      providerReads += 1;
      return currentSnapshot;
    },
    seriesRef: { current: series },
  });
  const frame = mustBeDefined(adapter.captureDrawingFrame());
  const readsBeforeSession = providerReads;
  const projectedBatchCount = adapter.runDrawingFrameProjectionSession(frame, () => {
    assert.equal(adapter.runDrawingFrameProjectionSession(frame, () => 1), null,
      "projection sessions reject nested re-entry");
    for (let index = 0; index < 64; index += 1) {
      const projected = adapter.projectDrawingFrameDataPoints(frame, [
        { price: index, time: index % 2 === 0 ? 100 : 200 },
      ]);
      assert.ok(projected);
    }
    return 64;
  });

  assert.equal(projectedBatchCount, 64);
  assert.equal(providerReads - readsBeforeSession, 2,
    "the session performs one fresh provider read at each atomic boundary");

  const readsBeforeInvalidatedSession = providerReads;
  const invalidatedResult = adapter.runDrawingFrameProjectionSession(frame, () => {
    adapter.notifyDrawingFrameInvalidation("viewport");
    return adapter.projectDrawingFrameDataPoints(frame, [{ price: 10, time: 100 }]);
  });
  assert.equal(invalidatedResult, null,
    "a synchronous invalidation rejects the whole session even if its snapshot identity is stable");
  assert.equal(providerReads - readsBeforeInvalidatedSession, 2);

  const readsBeforeStaleSession = providerReads;
  advanceDuringPriceProjection = true;
  const staleResult = adapter.runDrawingFrameProjectionSession(frame, () => (
    adapter.projectDrawingFrameDataPoints(frame, [{ price: 10, time: 100 }])
  ));
  assert.equal(staleResult, null,
    "a provider advance inside public coordinate projection rejects the whole session");
  assert.equal(providerReads - readsBeforeStaleSession, 2);
  assert.equal(adapter.isDrawingFrameCurrent(frame), false);
});

test("drawing frame projection discards a batch when the provider advances mid-project", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }];
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time: unknown) => time === 100 ? 10 : time === 200 ? 20 : null,
    }),
  };
  const factory = createDrawingFrameSnapshotFactory();
  const input = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    heightCssPx: 600,
    projectionKey: "time:identity",
    seriesData: rows,
    surfaceToken: "surface-a",
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  };
  let currentSnapshot = factory.capture(input);
  const series = {
    priceToCoordinate: (price: number) => {
      currentSnapshot = factory.capture({ ...input, viewportKey: "viewport-b" });
      return price;
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => currentSnapshot,
    seriesRef: { current: series },
  });
  const frame = mustBeDefined(adapter.captureDrawingFrame());

  assert.equal(adapter.projectDrawingFrameDataPoints(frame, [{ price: 10, time: 100 }]), null);
  assert.equal(adapter.isDrawingFrameCurrent(frame), false);
});

test("drawing frame exposes a narrow source-lineage span projection", () => {
  const rows = [displayRow(0, 100, 0), displayRow(1, 100, 1), displayRow(2, 200, 0)];
  const lineageIndex = createDrawingLineageIndex(rows);
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time: unknown) => isOrdinalAxisTime(time) ? time.order * 10 : null,
    }),
  };
  const series = { priceToCoordinate: (price: number) => price };
  const snapshot = createDrawingFrameSnapshotFactory().capture({
    axisKind: "derived-ordinal",
    coordinateKey: "BTCUSDT:renko:10:0",
    dpr: 1,
    drawingProjectionConfig: "dataset-a:renko:10",
    heightCssPx: 600,
    ordinalSeriesIndex: lineageIndex,
    projectionKey: "dataset-a:renko:10",
    seriesData: rows,
    sourceTimeHorizon: 200,
    surfaceToken: series,
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  });
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => snapshot,
    seriesRef: { current: series },
  });
  const frame = mustBeDefined(adapter.captureDrawingFrame());
  const projected = adapter.projectDrawingFrameSourceLineageSpan(frame, {
    exact: {
      left: { time: 100, sourceOrdinal: 0 },
      right: { time: 100, sourceOrdinal: 1 },
    },
    fallback: {
      fromTime: 100,
      leftRatio: 0,
      rightRatio: 1,
      toTime: 100,
    },
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });

  assert.deepEqual(projected, { left: 0, right: 10 });
  assert.equal(Object.isFrozen(projected), true);
  assert.deepEqual(Object.keys(projected || {}), ["left", "right"]);
  assert.deepEqual(adapter.readDrawingFrameSourceLineageStats(), {
    exactProjectionCount: 1,
    fallbackProjectionCount: 0,
    unresolvedProjectionCount: 0,
  });
});

test("drawing frame session projects a shared lineage resolution once per atomic frame", () => {
  const rows = [displayRow(0, 100, 0), displayRow(1, 100, 1), displayRow(2, 200, 0)];
  const lineageIndex = createDrawingLineageIndex(rows);
  let timeProjectionCalls = 0;
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time: unknown) => {
        timeProjectionCalls += 1;
        return isOrdinalAxisTime(time) ? time.order * 10 : null;
      },
    }),
  };
  const series = { priceToCoordinate: (price: number) => price };
  const snapshot = createDrawingFrameSnapshotFactory().capture({
    axisKind: "derived-ordinal",
    coordinateKey: "BTCUSDT:renko:10:0",
    dpr: 1,
    drawingProjectionConfig: "dataset-a:renko:10",
    heightCssPx: 600,
    ordinalSeriesIndex: lineageIndex,
    projectionKey: "dataset-a:renko:10",
    seriesData: rows,
    sourceTimeHorizon: 200,
    surfaceToken: series,
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  });
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => snapshot,
    seriesRef: { current: series },
  });
  const frame = mustBeDefined(adapter.captureDrawingFrame());
  const span = Object.freeze({
    exact: Object.freeze({
      left: Object.freeze({ time: 100, sourceOrdinal: 0 }),
      right: Object.freeze({ time: 100, sourceOrdinal: 1 }),
    }),
    fallback: Object.freeze({
      fromTime: 100,
      leftRatio: 0,
      rightRatio: 1,
      toTime: 100,
    }),
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });

  const projected = adapter.runDrawingFrameProjectionSession(frame, () => {
    const first = adapter.projectDrawingFrameSourceLineageSpan(frame, span);
    const second = adapter.projectDrawingFrameSourceLineageSpan(frame, span);
    assert.ok(first);
    assert.strictEqual(second, first,
      "session cache should reuse the immutable public coordinate pair");
    return first;
  });

  assert.deepEqual(projected, { left: 0, right: 10 });
  assert.equal(timeProjectionCalls, 2,
    "the shared resolution should project only its two endpoints inside one frame session");
  assert.deepEqual(adapter.readDrawingFrameSourceLineageStats(), {
    exactProjectionCount: 2,
    fallbackProjectionCount: 0,
    unresolvedProjectionCount: 0,
  }, "evidence continues to count requested canonical spans, including cache hits");

  assert.deepEqual(adapter.projectDrawingFrameSourceLineageSpan(frame, span), {
    left: 0,
    right: 10,
  });
  assert.equal(timeProjectionCalls, 4,
    "the projection cache must not survive beyond its atomic frame session");
});

test("source-lineage span world resolution is reused across viewport-only frames", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }, { time: 300 }];
  const timeScale = {
    options: () => ({ barSpacing: 10 }),
    timeToCoordinate: (time: unknown) => typeof time === "number" ? time / 10 : null,
  };
  const chart = { timeScale: () => timeScale };
  const series = { priceToCoordinate: (price: number) => price };
  const factory = createDrawingFrameSnapshotFactory();
  const input = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    heightCssPx: 600,
    projectionKey: "time:identity",
    seriesData: rows,
    surfaceToken: series,
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  };
  let snapshot = factory.capture(input);
  const adapter = createLightweightChartAdapter({
    chartRef: { current: chart },
    drawingCoordinateSnapshotProvider: () => snapshot,
    seriesRef: { current: series },
  });
  const span = Object.freeze({
    exact: Object.freeze({
      left: Object.freeze({ time: 100, sourceOrdinal: 0 }),
      right: Object.freeze({ time: 300, sourceOrdinal: 0 }),
    }),
    fallback: Object.freeze({
      fromTime: 100,
      leftRatio: 0.2,
      rightRatio: 0.8,
      toTime: 300,
    }),
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });

  const firstFrame = mustBeDefined(adapter.captureDrawingFrame());
  assert.deepEqual(adapter.projectDrawingFrameSourceLineageSpan(firstFrame, span), {
    left: 11,
    right: 29,
  });
  assert.deepEqual(adapter.readDrawingFrameSourceLineageStats(), {
    exactProjectionCount: 0,
    fallbackProjectionCount: 1,
    unresolvedProjectionCount: 0,
  });
  const searchesAfterFirst = firstFrame.coordinateIndex.stats.numericBinarySearchCount;
  assert.equal(searchesAfterFirst, 2);

  snapshot = factory.capture({ ...input, viewportKey: "viewport-b" });
  const viewportFrame = mustBeDefined(adapter.captureDrawingFrame());
  assert.equal(viewportFrame.worldRevisionKey, firstFrame.worldRevisionKey);
  assert.deepEqual(adapter.projectDrawingFrameSourceLineageSpan(viewportFrame, span), {
    left: 11,
    right: 29,
  });
  assert.equal(
    viewportFrame.coordinateIndex.stats.numericBinarySearchCount,
    searchesAfterFirst,
    "viewport projection must reuse the immutable source-span resolution",
  );

  snapshot = factory.capture({
    ...input,
    projectionKey: "time:changed",
    viewportKey: "viewport-b",
  });
  const changedWorldFrame = mustBeDefined(adapter.captureDrawingFrame());
  assert.notEqual(changedWorldFrame.worldRevisionKey, viewportFrame.worldRevisionKey);
  assert.ok(adapter.projectDrawingFrameSourceLineageSpan(changedWorldFrame, span));
  assert.equal(changedWorldFrame.coordinateIndex.stats.numericBinarySearchCount, 4);
});

test("drawing frame invalidation subscription hides chart objects and releases listeners", () => {
  let visibleHandler: (() => void) | null = null;
  let sizeHandler: (() => void) | null = null;
  const calls: unknown[] = [];
  const timeScale = {
    setVisibleLogicalRange: () => {},
    subscribeSizeChange: (handler: () => void) => { sizeHandler = handler; },
    subscribeVisibleLogicalRangeChange: (handler: () => void) => { visibleHandler = handler; },
    unsubscribeSizeChange: (handler: () => void) => {
      if (sizeHandler === handler) sizeHandler = null;
    },
    unsubscribeVisibleLogicalRangeChange: (handler: () => void) => {
      if (visibleHandler === handler) visibleHandler = null;
    },
  };
  const adapter = createLightweightChartAdapter({
    chartRef: { current: { timeScale: () => timeScale } },
    seriesRef: { current: { applyOptions: () => undefined } },
  });
  const unsubscribe = adapter.subscribeDrawingFrameInvalidation((reason) => {
    calls.push(reason);
  });

  (visibleHandler as (() => void) | null)?.();
  (sizeHandler as (() => void) | null)?.();
  adapter.requestSeriesUpdate();
  adapter.notifyDrawingFrameInvalidation();
  assert.deepEqual(calls, ["viewport", "viewport", "manual", "manual"]);

  unsubscribe();
  assert.equal(visibleHandler, null);
  assert.equal(sizeHandler, null);
  adapter.notifyDrawingFrameInvalidation();
  assert.deepEqual(calls, ["viewport", "viewport", "manual", "manual"]);
});

test("pane adapters share one native range, size, and DPR subscription", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let visibleHandler: ((range: { from: number; to: number } | null) => void) | null = null;
  let sizeHandler: ((width: number, height: number) => void) | null = null;
  let visibleSubscribeCount = 0;
  let sizeSubscribeCount = 0;
  let visibleUnsubscribeCount = 0;
  let sizeUnsubscribeCount = 0;
  let intervalCount = 0;
  const clearedIntervals: number[] = [];
  const timeScale = {
    subscribeVisibleLogicalRangeChange: (
      handler: (range: { from: number; to: number } | null) => void,
    ) => {
      visibleSubscribeCount += 1;
      visibleHandler = handler;
    },
    subscribeSizeChange: (handler: (width: number, height: number) => void) => {
      sizeSubscribeCount += 1;
      sizeHandler = handler;
    },
    unsubscribeVisibleLogicalRangeChange: (
      handler: (range: { from: number; to: number } | null) => void,
    ) => {
      visibleUnsubscribeCount += 1;
      if (visibleHandler === handler) visibleHandler = null;
    },
    unsubscribeSizeChange: (handler: (width: number, height: number) => void) => {
      sizeUnsubscribeCount += 1;
      if (sizeHandler === handler) sizeHandler = null;
    },
  };
  const testWindow = {
    devicePixelRatio: 1,
    setInterval() {
      intervalCount += 1;
      return 41;
    },
    clearInterval(timer: number) {
      clearedIntervals.push(timer);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });

  try {
    const chart = { timeScale: () => timeScale };
    const adapterA = createLightweightChartAdapter({
      chartRef: { current: chart },
      seriesRef: { current: {} },
    });
    const adapterB = createLightweightChartAdapter({
      chartRef: { current: chart },
      seriesRef: { current: {} },
    });
    const reasonsA: unknown[] = [];
    const reasonsB: unknown[] = [];
    const unsubscribeA = adapterA.subscribeDrawingFrameInvalidation(
      (reason) => reasonsA.push(reason),
    );
    const unsubscribeB = adapterB.subscribeDrawingFrameInvalidation(
      (reason) => reasonsB.push(reason),
    );

    assert.equal(visibleSubscribeCount, 1);
    assert.equal(sizeSubscribeCount, 1);
    assert.equal(intervalCount, 1);
    mustBeDefined<(range: { from: number; to: number } | null) => void>(
      visibleHandler,
    )({ from: 1, to: 2 });
    assert.deepEqual(reasonsA, ["viewport"]);
    assert.deepEqual(reasonsB, ["viewport"]);

    unsubscribeA();
    assert.equal(visibleUnsubscribeCount, 0);
    assert.equal(sizeUnsubscribeCount, 0);
    mustBeDefined<(width: number, height: number) => void>(sizeHandler)(900, 600);
    assert.deepEqual(reasonsA, ["viewport"]);
    assert.deepEqual(reasonsB, ["viewport", "viewport"]);

    unsubscribeB();
    assert.equal(visibleUnsubscribeCount, 1);
    assert.equal(sizeUnsubscribeCount, 1);
    assert.deepEqual(clearedIntervals, [41]);
    assert.equal(visibleHandler, null);
    assert.equal(sizeHandler, null);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("drawing frame invalidation observes pure DPR changes and re-arms the resolution query", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const mediaListeners = new Map<string, Set<() => void>>();
  const removedQueries: string[] = [];
  let pollListener: (() => void) | null = null;
  const clearedPollTimers: number[] = [];
  const testWindow = {
    devicePixelRatio: 1,
    setInterval(listener: () => void, delayMs: number) {
      assert.equal(delayMs, 250);
      pollListener = listener;
      return 17;
    },
    clearInterval(timer: number) {
      clearedPollTimers.push(timer);
    },
    matchMedia(query: string) {
      const listeners = new Set<() => void>();
      mediaListeners.set(query, listeners);
      return {
        addEventListener(type: string, listener: () => void) {
          if (type === "change") listeners.add(listener);
        },
        removeEventListener(type: string, listener: () => void) {
          if (type === "change" && listeners.delete(listener)) removedQueries.push(query);
        },
      };
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });

  try {
    const adapter = createLightweightChartAdapter({
      chartRef: { current: { timeScale: () => ({}) } },
      seriesRef: { current: {} },
    });
    const reasons: unknown[] = [];
    const unsubscribe = adapter.subscribeDrawingFrameInvalidation((reason) => reasons.push(reason));
    assert.equal(mediaListeners.has("(resolution: 1dppx)"), true);

    testWindow.devicePixelRatio = 1.5;
    for (const listener of [...mustBeDefined(mediaListeners.get("(resolution: 1dppx)"))]) listener();
    assert.deepEqual(reasons, ["viewport"]);
    assert.equal(removedQueries.includes("(resolution: 1dppx)"), true);
    assert.equal(mediaListeners.has("(resolution: 1.5dppx)"), true);

    testWindow.devicePixelRatio = 2;
    mustBeDefined<() => void>(pollListener)();
    assert.deepEqual(reasons, ["viewport", "viewport"]);
    assert.equal(mediaListeners.has("(resolution: 2dppx)"), true);

    unsubscribe();
    assert.deepEqual(clearedPollTimers, [17]);
    assert.equal(removedQueries.includes("(resolution: 2dppx)"), true);
    testWindow.devicePixelRatio = 2.5;
    mustBeDefined<() => void>(pollListener)();
    for (const listener of mediaListeners.get("(resolution: 2dppx)") ?? []) listener();
    assert.deepEqual(reasons, ["viewport", "viewport"]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("scene text measurement uses exact detached-canvas font metrics", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let assignedFont = "";
  const context = {
    get font() { return assignedFont; },
    set font(value: string) { assignedFont = value; },
    measureText: (text: string) => ({ width: text.length * 7.25 }),
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, "canvas");
        return { getContext: (kind: string) => kind === "2d" ? context : null };
      },
    },
  });
  try {
    const adapter = createLightweightChartAdapter({ chartRef: null, seriesRef: null });
    assert.deepEqual(adapter.measureText({
      text: "42.0°",
      fontFamily: "sans-serif",
      fontSize: 11,
      bold: false,
      italic: true,
      fontWeight: 600,
    }), { width: 36.25 });
    assert.equal(assignedFont, "italic 600 11px sans-serif");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
