import assert from "node:assert/strict";
import test from "node:test";

import {
  captureSourceLineageFreehandStrokeBatch,
  coordinateToFractionalLogical,
  createDrawingCoordinateTransactionContext,
  dataPointToCoordinate,
  drawingAnchorFromAxisTime,
  drawingAnchorFromCoordinate,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  logicalToInterpolatedSeriesTime,
  registerDrawingSeriesContext,
  resolveDrawingAnchorToDisplayRow,
  resolveSourceLineageSpanToCoordinates,
  timeToCoordinateInterpolated,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateSeriesBridge,
  DrawingCoordinateContext,
  InterpolatedCoordinateAdapter,
  SourceLineageSpanInput,
  TimeScaleBridge,
} from "../../../chart-adapter/coordinateBridge.js";
import { createDrawingLineageIndex } from "../../chart-representation/drawingLineageIndex.js";
import type {
  DisplayRow,
  OrdinalAxisTime,
  ProjectionMetadata,
} from "../../chart-representation/chartRepresentationTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

type TestDisplayRow = DisplayRow & {
  time: OrdinalAxisTime;
  customValues: {
    chartProjection: Readonly<ProjectionMetadata>;
  };
};

function assertAlmostEqual(
  actual: number | null | undefined,
  expected: number,
  epsilon = 1e-9,
): void {
  const resolvedActual = mustBeDefined(actual);
  assert.ok(
    Math.abs(resolvedActual - expected) <= epsilon,
    `expected ${resolvedActual} to be within ${epsilon} of ${expected}`,
  );
}

function ordinal(order: number, sourceTime: number, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

function displayRow(order: number, sourceTime: number, sourceOrdinal = 0, {
  from = sourceTime,
  projectorId = "renko",
  to = sourceTime,
}: { from?: number; projectorId?: string; to?: number } = {}): TestDisplayRow {
  return {
    time: ordinal(order, sourceTime, sourceOrdinal),
    customValues: {
      chartProjection: {
        projectorId,
        sourceFromTime: from,
        sourceOrdinal,
        sourceToTime: to,
        synthetic: true,
      },
    },
  };
}

test("drawing anchors discard projection-local order but preserve source identity", () => {
  const axisTime = ordinal(44, 1_700_000_000, 2);
  const rows = [displayRow(44, 1_700_000_000, 2)];
  const context = { drawingProjectionConfig: "dataset-a:renko:10" };

  assert.equal(isOrdinalAxisTime(axisTime), true);
  assert.equal(isOrdinalAxisTime({ order: 44, sourceTime: 1_700_000_000 }), false);
  assert.deepEqual(drawingAnchorFromAxisTime(1_700_000_000, rows), {
    time: 1_700_000_000,
  });
  assert.deepEqual(drawingAnchorFromAxisTime(axisTime, rows, context), {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });
  assert.equal(
    Object.hasOwn(mustBeDefined(drawingAnchorFromAxisTime(axisTime, rows, context)), "order"),
    false,
  );
});

test("drawing anchors resolve exact and clamped same-source ordinals", () => {
  const rows = [
    displayRow(10, 100, 0),
    displayRow(11, 100, 2),
    displayRow(12, 200, 0),
  ];
  const context = { drawingProjectionConfig: "dataset-a:renko:10" };

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, {
    time: 100,
    sourceOrdinal: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  }, context), rows[1]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, {
    time: 100,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  }, context), rows[0]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, {
    time: 100,
    sourceOrdinal: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  }, context), rows[1]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 100 }, context), rows[1]);

  // An ordinal captured from another projection is only a hint. The current
  // projection resolves the numeric source time to its last exact output.
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, {
    time: 100,
    sourceOrdinal: 0,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "dataset-a:renko:10",
  }, context), rows[1]);
});

function futureAnchorChart(
  rows: TestDisplayRow[],
  { cellWidth = 8, barSpacing = 50 }: { cellWidth?: number; barSpacing?: number } = {},
): CoordinateChartBridge {
  const tailOrder = rows[rows.length - 1]?.time?.order ?? 0;
  const tailX = tailOrder * 10;
  return {
    timeScale: () => ({
      coordinateToLogical: () => 100,
      coordinateToTime: (x) => {
        let closest = rows[0] || null;
        for (const candidate of rows) {
          if (Math.abs(candidate.time.order * 10 - x)
            < Math.abs((closest?.time?.order ?? 0) * 10 - x)) {
            closest = candidate;
          }
        }
        return closest?.time || null;
      },
      logicalToCoordinate: (logical) => tailX + (logical - 100) * cellWidth,
      options: () => ({ barSpacing }),
      timeToCoordinate: (time) => (
        isOrdinalAxisTime(time) ? time.order * 10 : null
      ),
    }),
  };
}

function futureAnchorRows(): TestDisplayRow[] {
  return [
    displayRow(0, 100, 0, { from: 100, to: 100 }),
    displayRow(1, 200, 0, { from: 101, to: 200 }),
    displayRow(2, 200, 1, { from: 200, to: 200 }),
  ];
}

test("ordinal coordinate anchors round-trip fractional future source time", () => {
  const rows = futureAnchorRows();
  const chart = futureAnchorChart(rows);
  const series: CoordinateSeriesBridge = { data: () => rows };
  const context: DrawingCoordinateContext = {
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 200,
  };

  assert.deepEqual(drawingAnchorFromCoordinate(chart, series, 20, context), {
    time: 200,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  });
  const future = drawingAnchorFromCoordinate(chart, series, 22.8, context);
  assertAlmostEqual(mustBeDefined(future).time, 221);
  assert.deepEqual(Object.keys(mustBeDefined(future)), ["time"]);
  assert.equal(Object.hasOwn(mustBeDefined(future), "order"), false);
  assert.equal(Object.hasOwn(mustBeDefined(future), "logical"), false);
  assertAlmostEqual(mustBeDefined(dataPointToCoordinate(chart, series, future, context)), 22.8);

  assert.deepEqual(drawingAnchorFromCoordinate(chart, series, 32, context), { time: 290 });
  assertAlmostEqual(mustBeDefined(dataPointToCoordinate(chart, series, { time: 290 }, context)), 32);

  const fallbackChart: CoordinateChartBridge = {
    timeScale: () => ({
      coordinateToLogical: () => null,
      coordinateToTime: (x) => (x <= 20 ? rows[2].time : null),
      logicalToCoordinate: () => null,
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  assert.deepEqual(drawingAnchorFromCoordinate(
    fallbackChart,
    series,
    25,
    context,
  ), { time: 230 });
  assertAlmostEqual(dataPointToCoordinate(
    fallbackChart,
    series,
    { time: 230 },
    context,
  ), 25);
});

test("calendar-month future anchors use UTC month cells and round-trip fractional cells", () => {
  const december = Date.UTC(2023, 11, 1) / 1_000;
  const january = Date.UTC(2024, 0, 1) / 1_000;
  const february = Date.UTC(2024, 1, 1) / 1_000;
  const march = Date.UTC(2024, 2, 1) / 1_000;
  const may = Date.UTC(2024, 4, 1) / 1_000;
  const rows = [
    displayRow(0, december, 0, { from: december, to: december }),
    displayRow(1, january, 0, { from: december + 1, to: january }),
    displayRow(2, january, 1, { from: january, to: january }),
  ];
  const chart = futureAnchorChart(rows, { cellWidth: 10 });
  const series: CoordinateSeriesBridge = { data: () => rows };
  const context: DrawingCoordinateContext = {
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceInterval: "1M",
    sourceIntervalSeconds: 30 * 86_400,
    sourceTimeHorizon: january,
  };

  const oneMonth = drawingAnchorFromCoordinate(chart, series, 30, context);
  assert.deepEqual(oneMonth, { time: february });
  assertAlmostEqual(dataPointToCoordinate(chart, series, oneMonth, context), 30);

  const halfway = drawingAnchorFromCoordinate(chart, series, 35, context);
  assertAlmostEqual(mustBeDefined(halfway).time, february + (march - february) / 2);
  assertAlmostEqual(dataPointToCoordinate(chart, series, halfway, context), 35);

  const twoMonthContext = { ...context, sourceInterval: "2M" };
  assert.deepEqual(
    drawingAnchorFromCoordinate(chart, series, 30, twoMonthContext),
    { time: march },
  );
  const twoMonthHalfway = drawingAnchorFromCoordinate(chart, series, 35, twoMonthContext);
  assertAlmostEqual(mustBeDefined(twoMonthHalfway).time, march + (may - march) / 2);
  assertAlmostEqual(
    dataPointToCoordinate(chart, series, twoMonthHalfway, twoMonthContext),
    35,
  );

  const nextRows = rows.concat(
    displayRow(3, february, 0, { from: january + 1, to: february }),
    displayRow(4, february, 1, { from: february, to: february }),
  );
  assert.equal(dataPointToCoordinate(
    futureAnchorChart(nextRows, { cellWidth: 10 }),
    { data: () => nextRows },
    oneMonth,
    { ...context, seriesData: nextRows, sourceTimeHorizon: february },
  ), 40);
});

test("invalid calendar-month future anchors fail closed instead of using fixed 30-day seconds", () => {
  const rows = futureAnchorRows();
  const chart = futureAnchorChart(rows, { cellWidth: 10 });
  const series = { data: () => rows };
  const context = {
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceInterval: "0M",
    sourceIntervalSeconds: 30 * 86_400,
    sourceTimeHorizon: Date.UTC(2024, 0, 1) / 1_000,
  };

  assert.equal(drawingAnchorFromCoordinate(chart, series, 30, context), null);
  assert.equal(dataPointToCoordinate(chart, series, {
    time: Date.UTC(2024, 1, 1) / 1_000,
  }, context), null);
  assert.equal(drawingAnchorFromCoordinate(chart, series, 30, {
    ...context,
    sourceInterval: "1M",
    sourceTimeHorizon: 8_640_000_000_001,
  }), null);
});

test("future ordinal anchors automatically return to lineage after the horizon crosses", () => {
  const previousRows = futureAnchorRows();
  const previousChart = futureAnchorChart(previousRows);
  const previousContext = {
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: previousRows,
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 200,
  };
  assertAlmostEqual(dataPointToCoordinate(
    previousChart,
    { data: () => previousRows },
    { time: 260 },
    previousContext,
  ), 28);

  const nextRows = previousRows.concat(
    displayRow(3, 260, 0, { from: 201, to: 260 }),
    displayRow(4, 260, 1, { from: 260, to: 260 }),
  );
  const nextContext = {
    ...previousContext,
    seriesData: nextRows,
    sourceTimeHorizon: 260,
  };
  assert.equal(dataPointToCoordinate(
    futureAnchorChart(nextRows),
    { data: () => nextRows },
    { time: 260 },
    nextContext,
  ), 40);
});

test("future ordinal anchors fail closed for empty data, invalid steps, left space, and unsafe time", () => {
  const rows = futureAnchorRows();
  const chart = futureAnchorChart(rows);
  const series = { data: () => rows };
  const context = {
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceIntervalSeconds: 0,
    sourceTimeHorizon: 200,
  };

  assert.equal(drawingAnchorFromCoordinate(chart, series, 25, context), null);
  assert.equal(dataPointToCoordinate(chart, series, { time: 260 }, context), null);
  assert.equal(drawingAnchorFromCoordinate(chart, series, 25, {
    ...context,
    seriesData: [],
    sourceIntervalSeconds: 60,
  }), null);
  assert.equal(dataPointToCoordinate(chart, { data: () => [] }, { time: 260 }, {
    ...context,
    seriesData: [],
    sourceIntervalSeconds: 60,
  }), null);
  assert.equal(drawingAnchorFromCoordinate({
    timeScale: () => ({
      coordinateToTime: () => null,
      timeToCoordinate: (time: unknown) => (
        isOrdinalAxisTime(time) ? time.order * 10 : null
      ),
    }),
  }, series, 15, {
    ...context,
    sourceIntervalSeconds: 60,
  }), null);
  assert.equal(dataPointToCoordinate(chart, series, {
    time: Number.MAX_SAFE_INTEGER + 1,
  }, {
    ...context,
    sourceIntervalSeconds: 60,
  }), null);
});

test("explicit future-anchor context wins over registered providers", () => {
  const rows = futureAnchorRows();
  const index = createDrawingLineageIndex(rows);
  const chart = futureAnchorChart(rows);
  const calls = {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    snapshot: 0,
  };
  const series = { data: () => rows };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => {
      calls.snapshot += 1;
      return {
        indexRevision: index.revision,
        ordinalSeriesIndex: index,
        seriesData: rows,
      };
    },
    projectionConfigProvider: () => {
      calls.config += 1;
      return "provider:renko:10";
    },
    sourceIntervalProvider: () => {
      calls.interval += 1;
      return "2m";
    },
    sourceIntervalSecondsProvider: () => {
      calls.intervalSeconds += 1;
      return 120;
    },
    sourceTimeHorizonProvider: () => {
      calls.horizon += 1;
      return 300;
    },
  });
  const explicit = {
    drawingOrdinalSeriesIndex: index,
    drawingOrdinalSeriesIndexRevision: index.revision,
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 200,
  };

  assert.deepEqual(drawingAnchorFromCoordinate(chart, series, 28, explicit), { time: 260 });
  assert.deepEqual(calls, {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    snapshot: 0,
  });

  const hydrated = drawingAnchorFromCoordinate(chart, series, 28, {});
  assert.deepEqual(hydrated, { time: 420 });
  assert.deepEqual(calls, {
    config: 1,
    horizon: 1,
    interval: 1,
    intervalSeconds: 1,
    snapshot: 1,
  });
});

test("registered primitive contexts keep snapshot-owned future interval inputs atomic", () => {
  const january = Date.UTC(2024, 0, 1) / 1_000;
  const february = Date.UTC(2024, 1, 1) / 1_000;
  const rows = [
    displayRow(0, Date.UTC(2023, 11, 1) / 1_000),
    displayRow(1, january),
  ];
  const index = createDrawingLineageIndex(rows);
  const chart = futureAnchorChart(rows, { cellWidth: 10 });
  const calls = {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    snapshot: 0,
  };
  const series = { data: () => rows };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => {
      calls.snapshot += 1;
      return {
        indexRevision: index.revision,
        ordinalSeriesIndex: index,
        seriesData: rows,
        drawingProjectionConfig: "snapshot:renko:10",
        sourceInterval: "1M",
        sourceIntervalSeconds: 30 * 86_400,
        sourceTimeHorizon: january,
      };
    },
    projectionConfigProvider: () => {
      calls.config += 1;
      return "provider:renko:20";
    },
    sourceIntervalProvider: () => {
      calls.interval += 1;
      return "2M";
    },
    sourceIntervalSecondsProvider: () => {
      calls.intervalSeconds += 1;
      return 1;
    },
    sourceTimeHorizonProvider: () => {
      calls.horizon += 1;
      return january + 1;
    },
  });

  const context: DrawingCoordinateContext = {};
  const future = drawingAnchorFromCoordinate(chart, series, 20, context);
  assert.deepEqual(future, { time: february });
  assertAlmostEqual(dataPointToCoordinate(chart, series, future, context), 20);
  assert.equal(context.drawingProjectionConfig, "snapshot:renko:10");
  assert.deepEqual(calls, {
    config: 0,
    horizon: 0,
    interval: 0,
    intervalSeconds: 0,
    snapshot: 1,
  });
});

function sourceLineageSpan(overrides: Partial<SourceLineageSpanInput> = {}): SourceLineageSpanInput {
  return {
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
    exact: {
      left: { time: 200, sourceOrdinal: 0 },
      right: { time: 200, sourceOrdinal: 1 },
    },
    fallback: {
      fromTime: 100,
      toTime: 200,
      leftRatio: 0.25,
      rightRatio: 0.75,
    },
    ...overrides,
  };
}

function spanChart(
  barSpacing = 10,
  seriesRows: TestDisplayRow[] | null = null,
): CoordinateChartBridge {
  return {
    timeScale: () => ({
      coordinateToTime: (x) => {
        const order = Math.round(x / barSpacing);
        return seriesRows?.find((row) => row?.time?.order === order)?.time || null;
      },
      options: () => ({ barSpacing }),
      timeToCoordinate: (time) => (
        isOrdinalAxisTime(time) ? time.order * barSpacing : null
      ),
    }),
  };
}

test("freehand capture batches persist adjacent source lineage without axis-local keys", () => {
  const rows = [
    displayRow(0, 200, 0, { from: 100, to: 200 }),
    displayRow(1, 200, 1, { from: 200, to: 200 }),
    displayRow(2, 300, 0, { from: 201, to: 300 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const result = mustBeDefined(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, rows),
    { data: () => rows, coordinateToPrice: (y) => 100 - y },
    [{ x: 5, y: 10 }, { x: 10, y: 20 }],
    {
      drawingOrdinalSeriesIndex: index,
      drawingOrdinalSeriesIndexRevision: index.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: rows,
      sourceTimeHorizon: 300,
    },
  ));

  assert.equal(result.sourceProjection, "renko");
  assert.equal(result.sourceProjectionConfig, "dataset-a:renko:10");
  assert.deepEqual(result.captures[0], {
    span: {
      exact: {
        left: { time: 200, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 1 },
      },
      fallback: { fromTime: 100, toTime: 200, leftRatio: 0.25, rightRatio: 0.75 },
    },
    ratio: 0.5,
    price: 90,
    screen: { x: 5, y: 10 },
  });
  assert.deepEqual(mustBeDefined(result.captures[1]?.span).exact, {
    left: { time: 200, sourceOrdinal: 1 },
    right: { time: 300, sourceOrdinal: 0 },
  });
  assert.equal(result.captures[1].ratio, 0);
  assert.equal(JSON.stringify(result).includes("order"), false);
  assert.equal(JSON.stringify(result).includes("logical"), false);
});

test("freehand capture atomically mixes materialized lineage with absolute future time", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 100, to: 100 }),
    displayRow(1, 200, 0, { from: 100, to: 200 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const result = mustBeDefined(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, rows),
    { data: () => rows, coordinateToPrice: (y) => 100 - y },
    [{ x: 5, y: 10 }, { x: 15, y: 20 }],
    {
      drawingOrdinalSeriesIndex: index,
      drawingOrdinalSeriesIndexRevision: index.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: rows,
      sourceInterval: "1m",
      sourceIntervalSeconds: 60,
      sourceTimeHorizon: 200,
    },
  ));

  assert.deepEqual(mustBeDefined(result.captures[0]?.span).exact, {
    left: { time: 100, sourceOrdinal: 0 },
    right: { time: 200, sourceOrdinal: 0 },
  });
  assert.equal(result.captures[0].ratio, 0.5);
  assert.deepEqual(result.captures[1], {
    time: 230,
    price: 80,
    screen: { x: 15, y: 20 },
  });
  assert.equal(JSON.stringify(result).includes("order"), false);
  assert.equal(JSON.stringify(result).includes("logical"), false);
  assert.equal(JSON.stringify(result).includes("sourceTimeHorizon"), false);
  assert.equal(JSON.stringify(result).includes("sourceInterval"), false);
});

test("future-only freehand capture works with one synthetic row and calendar months", () => {
  const horizon = Date.UTC(2024, 0, 1) / 1_000;
  const rows = [displayRow(0, horizon, 0, { from: horizon, to: horizon })];
  const index = createDrawingLineageIndex(rows);
  const chart = spanChart(10, rows);
  const fixed = mustBeDefined(captureSourceLineageFreehandStrokeBatch(
    chart,
    { data: () => rows, coordinateToPrice: (y) => y },
    [{ x: 5, y: 10 }, { x: 10, y: 20 }],
    {
      drawingOrdinalSeriesIndex: index,
      drawingOrdinalSeriesIndexRevision: index.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: rows,
      sourceInterval: "1m",
      sourceIntervalSeconds: 60,
      sourceTimeHorizon: horizon,
    },
  ));
  assert.deepEqual(fixed.captures.map(({ time }) => time), [
    horizon + 30,
    horizon + 60,
  ]);

  const futureToTail = mustBeDefined(captureSourceLineageFreehandStrokeBatch(
    chart,
    { data: () => rows, coordinateToPrice: (y) => y },
    [{ x: 5, y: 10 }, { x: 0, y: 20 }],
    {
      drawingOrdinalSeriesIndex: index,
      drawingOrdinalSeriesIndexRevision: index.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: rows,
      sourceInterval: "1m",
      sourceIntervalSeconds: 60,
      sourceTimeHorizon: horizon,
    },
  ));
  assert.deepEqual(futureToTail.captures, [
    { time: horizon + 30, price: 10, screen: { x: 5, y: 10 } },
    {
      anchor: { time: horizon, sourceOrdinal: 0 },
      price: 20,
      screen: { x: 0, y: 20 },
    },
  ]);

  const calendar = mustBeDefined(captureSourceLineageFreehandStrokeBatch(
    chart,
    { data: () => rows, coordinateToPrice: (y) => y },
    [{ x: 5, y: 10 }, { x: 15, y: 20 }],
    {
      drawingOrdinalSeriesIndex: index,
      drawingOrdinalSeriesIndexRevision: index.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: rows,
      sourceInterval: "1M",
      sourceIntervalSeconds: null,
      sourceTimeHorizon: horizon,
    },
  ));
  assert.deepEqual(calendar.captures.map(({ time }) => time), [
    Date.UTC(2024, 0, 16, 12) / 1_000,
    Date.UTC(2024, 1, 15, 12) / 1_000,
  ]);
});

test("future freehand capture rejects the price scale and invalid interval basis", () => {
  const rows = [displayRow(0, 100, 0, { from: 100, to: 100 })];
  const index = createDrawingLineageIndex(rows);
  const context = {
    drawingOrdinalSeriesIndex: index,
    drawingOrdinalSeriesIndexRevision: index.revision,
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 100,
  };
  const chart = {
    timeScale: () => ({
      coordinateToTime: () => null,
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: () => 0,
      width: () => 20,
    }),
  };
  const series = { coordinateToPrice: (y: number) => y, data: () => rows };

  assert.equal(captureSourceLineageFreehandStrokeBatch(
    chart, series, [{ x: 20, y: 1 }], context,
  ), null);
  assert.equal(captureSourceLineageFreehandStrokeBatch(
    chart, series, [{ x: 5, y: 1 }], {
      ...context,
      sourceInterval: "bad",
      sourceIntervalSeconds: null,
    },
  ), null);
});

test("future freehand coordinates reuse one basis per shared render context", () => {
  const rows = [displayRow(0, 100, 0, { from: 100, to: 100 })];
  let tailCoordinateReads = 0;
  let spacingReads = 0;
  const timeScale = {
    coordinateToLogical: () => null,
    options: () => {
      spacingReads += 1;
      return { barSpacing: 10 };
    },
    timeToCoordinate: () => {
      tailCoordinateReads += 1;
      return 0;
    },
  };
  const chart = { timeScale: () => timeScale };
  const series = { data: () => rows };
  const context = createDrawingCoordinateTransactionContext({
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 100,
  });

  assert.equal(dataPointToCoordinate(chart, series, { time: 130 }, context), 5);
  assert.equal(dataPointToCoordinate(chart, series, { time: 160 }, context), 10);
  assert.equal(tailCoordinateReads, 1);
  assert.equal(spacingReads, 1);
});

test("ordinary coordinate contexts recompute future basis after viewport spacing changes", () => {
  const rows = [displayRow(0, 100, 0, { from: 100, to: 100 })];
  let barSpacing = 10;
  const timeScale = {
    coordinateToLogical: () => null,
    options: () => ({ barSpacing }),
    timeToCoordinate: () => 0,
  };
  const chart = { timeScale: () => timeScale };
  const series = { data: () => rows };
  const context = {
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 100,
  };

  assert.equal(dataPointToCoordinate(chart, series, { time: 160 }, context), 10);
  barSpacing = 20;
  assert.equal(dataPointToCoordinate(chart, series, { time: 160 }, context), 20);
});

test("freehand capture only requires the visible adjacent pair when history is offscreen", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 100, to: 100 }),
    displayRow(1, 200, 0, { from: 100, to: 200 }),
    displayRow(2, 300, 0, { from: 200, to: 300 }),
    displayRow(3, 400, 0, { from: 300, to: 400 }),
    displayRow(4, 500, 0, { from: 400, to: 500 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      coordinateToTime: () => rows[3].time,
      timeToCoordinate: (time) => (
        isOrdinalAxisTime(time) && (time.order === 2 || time.order === 3)
          ? time.order * 10
          : null
      ),
    }),
  };

  const result = mustBeDefined(captureSourceLineageFreehandStrokeBatch(
    chart,
    { coordinateToPrice: (y) => 100 - y },
    [{ x: 25, y: 10 }],
    {
      drawingOrdinalSeriesIndex: index,
      drawingOrdinalSeriesIndexRevision: index.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: rows,
      sourceTimeHorizon: 500,
    },
  ));

  assert.deepEqual(result.captures[0], {
    span: {
      exact: {
        left: { time: 300, sourceOrdinal: 0 },
        right: { time: 400, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 200,
        toTime: 400,
        leftRatio: 0.375,
        rightRatio: 0.625,
      },
    },
    ratio: 0.5,
    price: 90,
    screen: { x: 25, y: 10 },
  });
});

test("freehand capture batches fail closed on bounds, gaps, stale indexes, and invalid prices", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 100, to: 100 }),
    displayRow(1, 300, 0, { from: 300, to: 300 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const context = {
    drawingOrdinalSeriesIndex: index,
    drawingOrdinalSeriesIndexRevision: index.revision,
    drawingProjectionConfig: "dataset-a:renko:10",
    seriesData: rows,
    sourceTimeHorizon: 300,
  };
  const series = { data: () => rows, coordinateToPrice: (y: number) => y };

  assert.equal(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, rows), series, [{ x: 5, y: 1 }], context,
  ), null);
  assert.equal(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, rows), series, [{ x: -1, y: 1 }], context,
  ), null);
  assert.equal(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, rows), series, [{ x: 5, y: 1 }], {
      ...context,
      drawingOrdinalSeriesIndexRevision: index.revision - 1,
    },
  ), null);
  assert.equal(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, rows), { ...series, coordinateToPrice: () => Number.NaN }, [{ x: 5, y: 1 }], {
      ...context,
      seriesData: rows,
    },
  ), null);

  const oneRow = [displayRow(0, 100)];
  assert.equal(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, oneRow),
    { data: () => oneRow, coordinateToPrice: (y) => y },
    [{ x: -6, y: 1 }],
    {
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: oneRow,
      sourceTimeHorizon: 100,
    },
  ), null);

  const nonmonotonicRows = [
    displayRow(0, 200, 0, { from: 150, to: 200 }),
    displayRow(1, 100, 0, { from: 100, to: 100 }),
  ];
  const nonmonotonicIndex = createDrawingLineageIndex(nonmonotonicRows);
  assert.equal(captureSourceLineageFreehandStrokeBatch(
    spanChart(10, nonmonotonicRows),
    { data: () => nonmonotonicRows, coordinateToPrice: (y) => y },
    [{ x: 5, y: 1 }],
    {
      drawingOrdinalSeriesIndex: nonmonotonicIndex,
      drawingOrdinalSeriesIndexRevision: nonmonotonicIndex.revision,
      drawingProjectionConfig: "dataset-a:renko:10",
      seriesData: nonmonotonicRows,
      sourceTimeHorizon: 200,
    },
  ), null);
});

test("freehand source spans keep same-time ordinals distinct in exact mode", () => {
  const rows = [
    displayRow(0, 200, 0, { from: 100, to: 200 }),
    displayRow(1, 200, 1, { from: 200, to: 200 }),
  ];

  assert.deepEqual(resolveSourceLineageSpanToCoordinates(
    spanChart(),
    { data: () => rows },
    sourceLineageSpan(),
    {
      drawingProjectionConfig: "dataset-a:renko:10",
      sourceTimeHorizon: 200,
    },
  ), { left: 0, right: 10 });
});

test("freehand source spans use monotonic cell envelopes across synthetic projectors", () => {
  for (const projectorId of ["renko", "point-and-figure", "kagi", "line-break"]) {
    const rows = [
      displayRow(0, 120, 0, { from: 80, projectorId, to: 120 }),
      displayRow(1, 180, 0, { from: 121, projectorId, to: 180 }),
      displayRow(2, 220, 0, { from: 181, projectorId, to: 220 }),
    ];
    const result = resolveSourceLineageSpanToCoordinates(
      spanChart(),
      { data: () => rows },
      sourceLineageSpan(),
      {
        drawingProjectionConfig: `dataset-b:${projectorId}:changed`,
        sourceTimeHorizon: 220,
      },
    );

    assert.deepEqual(result, { left: 2.5, right: 17.5 }, projectorId);
    assert.ok(result.left < result.right, projectorId);
  }
});

test("freehand fallback ratios retain width inside one target display cell", () => {
  const rows = [displayRow(0, 200, 0, {
    from: 200,
    projectorId: "point-and-figure",
    to: 200,
  })];

  assert.deepEqual(resolveSourceLineageSpanToCoordinates(
    spanChart(),
    { data: () => rows },
    sourceLineageSpan({
      fallback: {
        fromTime: 200,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }),
    {
      drawingProjectionConfig: "dataset-b:point-and-figure:changed",
      sourceTimeHorizon: 200,
    },
  ), { left: -2.5, right: 2.5 });
});

test("freehand source spans fall back on config mismatch or missing exact ordinals", () => {
  const rows = [
    displayRow(0, 200, 0, { from: 100, to: 200 }),
    displayRow(1, 200, 1, { from: 200, to: 200 }),
  ];
  const series = { data: () => rows };
  const expectedFallback = { left: 0, right: 10 };

  assert.deepEqual(resolveSourceLineageSpanToCoordinates(
    spanChart(),
    series,
    sourceLineageSpan(),
    {
      drawingProjectionConfig: "dataset-a:renko:20",
      sourceTimeHorizon: 200,
    },
  ), expectedFallback);
  assert.deepEqual(resolveSourceLineageSpanToCoordinates(
    spanChart(),
    series,
    sourceLineageSpan({
      exact: {
        left: { time: 200, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 9 },
      },
    }),
    {
      drawingProjectionConfig: "dataset-a:renko:10",
      sourceTimeHorizon: 200,
    },
  ), expectedFallback);
});

test("freehand source spans stay unresolved outside the raw source horizon", () => {
  const rows = [displayRow(0, 200, 0, { from: 100, to: 200 })];

  assert.equal(resolveSourceLineageSpanToCoordinates(
    spanChart(),
    { data: () => rows },
    sourceLineageSpan({
      fallback: {
        fromTime: 200,
        toTime: 300,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }),
    {
      drawingProjectionConfig: "dataset-a:renko:20",
      sourceTimeHorizon: 250,
    },
  ), null);
});

test("freehand source spans fall back to a continuous source-time cell envelope", () => {
  const rows = [{ time: 100 }, { time: 200 }];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => {
        if (time === 100) return 0;
        if (time === 200) return 10;
        return null;
      },
    }),
  };

  assert.deepEqual(resolveSourceLineageSpanToCoordinates(
    chart,
    { data: () => rows },
    sourceLineageSpan(),
  ), { left: 0, right: 10 });
});

test("freehand source-time spans scan numeric coverage once per coordinate context", () => {
  let timeReads = 0;
  let dataCalls = 0;
  const rows = Array.from({ length: 1_000 }, (_, index) => {
    const row = {};
    Object.defineProperty(row, "time", {
      enumerable: true,
      get() {
        timeReads += 1;
        return 100 + index;
      },
    });
    return row;
  });
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (typeof time === "number" ? time : null),
    }),
  };
  const series = {
    data: () => {
      dataCalls += 1;
      return rows;
    },
  };
  const context = {};

  for (let index = 0; index < 100; index += 1) {
    const fromTime = 200 + index;
    assert.ok(resolveSourceLineageSpanToCoordinates(
      chart,
      series,
      sourceLineageSpan({
        fallback: {
          fromTime,
          toTime: fromTime + 10,
          leftRatio: 0.25,
          rightRatio: 0.75,
        },
      }),
      context,
    ));
  }

  assert.equal(dataCalls, 1);
  assert.ok(timeReads < 5_000, `unexpected numeric coverage rescans: ${timeReads}`);
});

test("same projector ignores source ordinal when projection config identity changes", () => {
  const rows = [
    displayRow(10, 100, 0),
    displayRow(11, 100, 2),
  ];
  const anchor = {
    time: 100,
    sourceOrdinal: 0,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  };

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, anchor, {
    drawingProjectionConfig: "dataset-a:renko:10",
  }), rows[0]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, anchor, {
    drawingProjectionConfig: "dataset-a:renko:20",
  }), rows[1]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, {
    ...anchor,
    sourceProjectionConfig: undefined,
  }, {
    drawingProjectionConfig: "dataset-a:renko:10",
  }), rows[1]);
});

test("position endpoint lineage recovers across all derived projections and may conservatively fold", () => {
  const anchors = [{
    time: 120,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  }, {
    time: 180,
    sourceOrdinal: 0,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
  }];

  for (const projectorId of ["renko", "point-and-figure", "kagi", "line-break"]) {
    const rows = projectorId === "point-and-figure"
      ? [displayRow(0, 200, 0, { from: 80, projectorId, to: 220 })]
      : [
          displayRow(0, 140, 0, { from: 80, projectorId, to: 140 }),
          displayRow(1, 220, 0, { from: 141, projectorId, to: 220 }),
        ];
    const context = {
      drawingProjectionConfig: `dataset-a:${projectorId}:current`,
      sourceTimeHorizon: 220,
    };
    const resolved = anchors.map((anchor) => (
      resolveDrawingAnchorToDisplayRow(rows, anchor, context)
    ));

    assert.ok(resolved.every(Boolean), projectorId);
    if (projectorId === "point-and-figure") {
      assert.strictEqual(resolved[0], resolved[1]);
    } else {
      assert.notStrictEqual(resolved[0], resolved[1]);
    }
    // Resolution is read-only: the durable Renko endpoints remain recoverable
    // after a target projection temporarily folds them onto one display row.
    assert.equal(anchors[0].sourceProjection, "renko");
    assert.equal(anchors[1].sourceProjection, "renko");
  }
});

test("drawing anchors use current lineage and reject unmaterialized future time", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 280, 0, { from: 150, to: 280 }),
    displayRow(2, 280, 1, { from: 150, to: 280 }),
    displayRow(3, 300, 0, { from: 101, to: 300 }),
    displayRow(4, 500, 0, { from: 401, to: 500 }),
  ];

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 200 }), rows[2]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 350 }), rows[3]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 50 }), null);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 501 }), null);
});

test("raw source horizon distinguishes delayed projection output from true future", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 200, 0, { from: 150, to: 200 }),
  ];
  const context = { sourceTimeHorizon: 400 };

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 300 }, context), rows[1]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 500 }, context), null);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 300 }), null);
});

test("monotonic lineage lookup preserves containing and tie-break semantics", () => {
  const rows = [
    displayRow(0, 10, 0, { from: 0, to: 100 }),
    displayRow(1, 20, 0, { from: 50, to: 200 }),
    displayRow(2, 30, 0, { from: 80, to: 200 }),
    displayRow(3, 40, 0, { from: 80, to: 200 }),
    displayRow(4, 50, 0, { from: 201, to: 300 }),
  ];
  const context = { sourceTimeHorizon: 400 };

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 90 }, context), rows[0]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 150 }, context), rows[3]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 350 }, context), rows[4]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: -10 }, context), null);
});

test("trimmed historical anchors stay unresolved before current derived lineage", () => {
  const rows = [
    displayRow(20, 300, 0, { from: 250, to: 300 }),
    displayRow(21, 400, 0, { from: 301, to: 400 }),
  ];
  const context = { sourceTimeHorizon: 500 };

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 100 }, context), null);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 275 }, context), rows[0]);
});

test("derived drawing resolution reuses one series index across primitives", () => {
  let iteratorReads = 0;
  const target = [
    displayRow(0, 100, 0),
    displayRow(1, 200, 0),
  ];
  const rows = new Proxy(target, {
    get(array, property, receiver) {
      if (property === Symbol.iterator) iteratorReads += 1;
      return Reflect.get(array, property, receiver);
    },
  });

  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 100 }), target[0]);
  assert.equal(resolveDrawingAnchorToDisplayRow(rows, { time: 200 }), target[1]);

  // Each call probes the first valid time once; only the first builds the
  // shared O(N) lineage index, so the second primitive does not rescan it.
  assert.equal(iteratorReads, 3);
});

test("registered drawing series context uses stable display data across primitives", () => {
  let dataCalls = 0;
  let projectionMetadataReads = 0;
  const rows = [displayRow(0, 100, 0), displayRow(1, 200, 0)];
  for (const row of rows) {
    const customValues = row.customValues;
    Object.defineProperty(row, "customValues", {
      configurable: true,
      get() {
        projectionMetadataReads += 1;
        return customValues;
      },
    });
  }
  const series = {
    data: () => {
      dataCalls += 1;
      return rows.map((row) => ({ ...row }));
    },
  };
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };

  registerDrawingSeriesContext(series, {
    projectionConfigProvider: () => "dataset-a:renko:10",
    seriesDataProvider: () => rows,
    sourceTimeHorizonProvider: () => 400,
  });
  const firstReadsBeforeResolve = projectionMetadataReads;
  assert.equal(dataPointToCoordinate(chart, series, { time: 300 }), 10);
  const readsAfterFirstResolve = projectionMetadataReads;
  assert.equal(dataPointToCoordinate(chart, series, { time: 300 }), 10);

  assert.equal(dataCalls, 0);
  assert.ok(readsAfterFirstResolve > firstReadsBeforeResolve);
  assert.equal(projectionMetadataReads, readsAfterFirstResolve);
});

test("registered coordinate snapshots avoid rescanning a replaced derived tail", () => {
  const prefix = displayRow(0, 100, 0, { from: 80, to: 100 });
  const oldTail = displayRow(1, 200, 0, { from: 101, to: 200 });
  const nextTail = displayRow(1, 220, 0, { from: 101, to: 220 });
  const previousRows = [prefix, oldTail];
  const nextRows = [prefix, nextTail];
  const index = createDrawingLineageIndex(previousRows);
  assert.equal(index.replaceTail({
    previousSeriesData: previousRows,
    fromOutputIndex: 1,
    insert: [nextTail],
    nextSeriesData: nextRows,
  }), true);

  Object.defineProperty(prefix, "customValues", {
    configurable: true,
    get() {
      throw new Error("stable prefix metadata was rescanned");
    },
  });

  let fallbackDataCalls = 0;
  let snapshotCalls = 0;
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series = {
    data: () => {
      fallbackDataCalls += 1;
      return previousRows;
    },
  };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => {
      snapshotCalls += 1;
      return {
        indexRevision: index.revision,
        ordinalSeriesIndex: index,
        seriesData: nextRows,
      };
    },
    sourceTimeHorizonProvider: () => 220,
  });

  assert.equal(dataPointToCoordinate(chart, series, { time: 90 }), 0);
  assert.equal(dataPointToCoordinate(chart, series, { time: 150 }), 10);
  assert.equal(snapshotCalls, 2);
  assert.equal(fallbackDataCalls, 0);
});

test("stale coordinate snapshot revisions fall back when array identity is unchanged", () => {
  const oldTail = displayRow(1, 200);
  const rows = [displayRow(0, 100), oldTail];
  const index = createDrawingLineageIndex(rows);
  const staleRevision = index.revision;
  index.reset(rows);
  const replacementTail = displayRow(1, 200);
  rows[1] = replacementTail;

  assert.strictEqual(resolveDrawingAnchorToDisplayRow(rows, { time: 200 }, {
    drawingOrdinalSeriesIndex: index,
    drawingOrdinalSeriesIndexRevision: staleRevision,
  }), replacementTail);
});

test("projection-owned lineage indexes preserve fallback anchor semantics", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 280, 0, { from: 150, to: 280 }),
    displayRow(2, 280, 1, { from: 150, to: 280 }),
    displayRow(3, 300, 0, { from: 101, to: 300 }),
    displayRow(4, 500, 0, { from: 401, to: 500 }),
  ];
  const previousRows = rows.slice(0, 3);
  const index = createDrawingLineageIndex(previousRows);
  assert.equal(index.replaceTail({
    previousSeriesData: previousRows,
    fromOutputIndex: previousRows.length,
    insert: rows.slice(previousRows.length),
    nextSeriesData: rows,
  }), true);
  const fallbackContext = {
    drawingProjectionConfig: "dataset-a:renko:10",
    sourceTimeHorizon: 500,
  };
  const indexedContext = {
    ...fallbackContext,
    drawingOrdinalSeriesIndex: index,
    drawingOrdinalSeriesIndexRevision: index.revision,
  };
  const cases = [
    {
      anchor: {
        time: 280,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:10",
      },
      expected: rows[1],
    },
    {
      anchor: {
        time: 280,
        sourceOrdinal: 1,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:10",
      },
      expected: rows[2],
    },
    {
      anchor: {
        time: 280,
        sourceOrdinal: 5,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:10",
      },
      expected: rows[2],
    },
    { anchor: { time: 280 }, expected: rows[2] },
    {
      anchor: {
        time: 280,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:20",
      },
      expected: rows[2],
    },
    { anchor: { time: 200 }, expected: rows[2] },
    { anchor: { time: 350 }, expected: rows[3] },
    { anchor: { time: 50 }, expected: null },
    { anchor: { time: 501 }, expected: null },
  ];

  for (const { anchor, expected } of cases) {
    assert.strictEqual(
      resolveDrawingAnchorToDisplayRow(rows, anchor, indexedContext),
      expected,
    );
    assert.strictEqual(
      resolveDrawingAnchorToDisplayRow(rows, anchor, fallbackContext),
      expected,
    );
  }
});

test("derived data points resolve through source anchors and never fall back to logical future", () => {
  const rows = [
    displayRow(0, 100, 0),
    displayRow(1, 100, 1),
    displayRow(2, 200, 0),
  ];
  let logicalCalls = 0;
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => {
        if (!isOrdinalAxisTime(time)) throw new TypeError("ordinal time required");
        return time.order * 10;
      },
      logicalToCoordinate: () => {
        logicalCalls += 1;
        return 999;
      },
    }),
  };
  const series = { data: () => rows };

  assert.equal(dataPointToCoordinate(chart, series, {
    time: 100,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    logical: 99,
  }), 10);
  assert.equal(dataPointToCoordinate(chart, series, {
    time: 300,
    logical: 99,
  }), null);
  assert.equal(logicalCalls, 0);
});

test("ordinal interpolation resolves source lineage before a stale order fast path", () => {
  const rows = [
    displayRow(0, 100, 0),
    displayRow(1, 200, 0),
  ];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series = { data: () => rows };

  // This captured order has been reassigned to source 200. Source lineage must
  // retain the anchor on the current source-100 row at order 0.
  assert.equal(timeToCoordinateInterpolated(
    chart,
    series,
    ordinal(1, 100, 0),
  ), 0);
});

test("coordinateToFractionalLogical reverses Lightweight Charts ceil snapping", () => {
  const barSpacing = 8;
  const adapter: InterpolatedCoordinateAdapter = {
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

  const adapter: InterpolatedCoordinateAdapter = {
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
  const timeScale: Pick<TimeScaleBridge, "logicalToCoordinate"> = {
    logicalToCoordinate: (logical) => (Number.isInteger(logical) ? logical * barSpacing : 0),
  };

  assertAlmostEqual(logicalToCoordinateInterpolated(timeScale, 10.5), 10.5 * barSpacing);
});

test("logicalToInterpolatedSeriesTime stores right-side drawing anchors as absolute future time", () => {
  const seriesData = Array.from({ length: 10 }, (_, index) => ({ time: 1000 + index * 60 }));
  const adapter: InterpolatedCoordinateAdapter = {
    isReady: () => true,
    getSeriesData: () => seriesData,
    timeToCoordinate: (time) => ((time - 1000) / 60) * 8,
    coordinateToLogical: (x) => x / 8,
  };

  assertAlmostEqual(logicalToInterpolatedSeriesTime(adapter, 12.2), 1000 + 12.2 * 60);
  assertAlmostEqual(logicalToInterpolatedSeriesTime(adapter, 9), 1000 + 9 * 60);
});

test("dataPointToCoordinate extrapolates absolute future time from the last two bars", () => {
  const chart: CoordinateChartBridge = {
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
  const chart: CoordinateChartBridge = {
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
  const chart: CoordinateChartBridge = {
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
