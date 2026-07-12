import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinateToFractionalLogical,
  dataPointToCoordinate,
  drawingAnchorFromAxisTime,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  logicalToInterpolatedSeriesTime,
  registerDrawingSeriesContext,
  resolveDrawingAnchorToDisplayRow,
  timeToCoordinateInterpolated,
} from "../../../chart-adapter/coordinateBridge.js";

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
