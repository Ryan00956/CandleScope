import assert from "node:assert/strict";
import test from "node:test";

import {
  captureSourceLineageFreehandStrokeBatch,
  coordinateToFractionalLogical,
  dataPointToCoordinate,
  drawingAnchorFromAxisTime,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  logicalToInterpolatedSeriesTime,
  registerDrawingSeriesContext,
  resolveDrawingAnchorToDisplayRow,
  resolveSourceLineageSpanToCoordinates,
  timeToCoordinateInterpolated,
} from "../../../chart-adapter/coordinateBridge.js";
import { createDrawingLineageIndex } from "../../chart-representation/drawingLineageIndex.js";

function assertAlmostEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function ordinal(order, sourceTime, sourceOrdinal = 0) {
  return { order, sourceTime, sourceOrdinal };
}

function displayRow(order, sourceTime, sourceOrdinal = 0, {
  from = sourceTime,
  projectorId = "renko",
  to = sourceTime,
} = {}) {
  return {
    time: ordinal(order, sourceTime, sourceOrdinal),
    customValues: {
      chartProjection: {
        projectorId,
        sourceFromTime: from,
        sourceOrdinal,
        sourceToTime: to,
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
  assert.equal(Object.hasOwn(drawingAnchorFromAxisTime(axisTime, rows, context), "order"), false);
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

function sourceLineageSpan(overrides = {}) {
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

function spanChart(barSpacing = 10, seriesRows = null) {
  return {
    timeScale: () => ({
      coordinateToTime: (x) => {
        const order = Math.round(x / barSpacing);
        return seriesRows?.find((row) => row?.time?.order === order)?.time || null;
      },
      options: () => ({ barSpacing }),
      timeToCoordinate: (time) => time.order * barSpacing,
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
  const result = captureSourceLineageFreehandStrokeBatch(
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
  );

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
  assert.deepEqual(result.captures[1].span.exact, {
    left: { time: 200, sourceOrdinal: 1 },
    right: { time: 300, sourceOrdinal: 0 },
  });
  assert.equal(result.captures[1].ratio, 0);
  assert.equal(JSON.stringify(result).includes("order"), false);
  assert.equal(JSON.stringify(result).includes("logical"), false);
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
  const chart = {
    timeScale: () => ({
      coordinateToTime: () => rows[3].time,
      timeToCoordinate: (time) => (
        time.order === 2 || time.order === 3 ? time.order * 10 : null
      ),
    }),
  };

  const result = captureSourceLineageFreehandStrokeBatch(
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
  );

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
  const series = { data: () => rows, coordinateToPrice: (y) => y };

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
    [{ x: 0, y: 1 }],
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
  const chart = {
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
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time,
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
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time) => time.order * 10,
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
  const chart = {
    timeScale: () => ({ timeToCoordinate: (time) => time.order * 10 }),
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
  const chart = {
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
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time) => time.order * 10,
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
