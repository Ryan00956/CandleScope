import assert from "node:assert/strict";
import test from "node:test";

import { registerDrawingSeriesContext } from "../../../chart-adapter/coordinateBridge.js";
import { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import { freehandStrokeToCoordinates } from "../primitives/coordinateUtils.js";

function row(order, sourceTime, from, to, sourceOrdinal = 0) {
  return {
    time: { order, sourceTime, sourceOrdinal },
    customValues: {
      chartProjection: {
        projectorId: "renko",
        sourceFromTime: from,
        sourceOrdinal,
        sourceToTime: to,
      },
    },
  };
}

function strokeWithUnresolvedMiddle() {
  return {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:old",
    spans: [{
      exact: {
        left: { time: 100, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 100,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }, {
      exact: {
        left: { time: 300, sourceOrdinal: 0 },
        right: { time: 400, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 300,
        toTime: 400,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 0 },
      { span: 0, ratio: 0.2, price: 0 },
      { span: 1, ratio: 0.5, price: 0 },
      { span: 0, ratio: 0.8, price: 0 },
      { span: 0, ratio: 1, price: 0 },
    ],
  };
}

function strokeV3WithAbsoluteMiddle() {
  const v2 = strokeWithUnresolvedMiddle();
  return {
    ...v2,
    version: 3,
    spans: [v2.spans[0]],
    points: [
      { span: 0, ratio: 0, price: 0 },
      { span: 0, ratio: 0.2, price: 0 },
      { time: 500, price: 0 },
      { span: 0, ratio: 0.8, price: 0 },
      { span: 0, ratio: 1, price: 0 },
    ],
  };
}

function attachedPrimitive() {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const primitive = new FreehandDrawingPrimitive({
    id: "v2-gap",
    stroke: strokeWithUnresolvedMiddle(),
    lineWidth: 2,
  });
  primitive.attached({ chart, series, requestUpdate: () => {} });
  return primitive;
}

function renderedPathMoves(primitive) {
  primitive.updateAllViews();
  const moves = [];
  const context = {
    beginPath() {},
    lineTo() {},
    moveTo: (x, y) => moves.push([x, y]),
    quadraticCurveTo() {},
    restore() {},
    save() {},
    stroke() {},
  };
  primitive.paneViews()[0].renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  });
  return moves;
}

test("freehand v2 renderer and hit testing never bridge an unresolved span", () => {
  const primitive = attachedPrimitive();

  assert.equal(primitive.hitTest(1, 0, 0.1), true);
  assert.equal(primitive.hitTest(5, 0, 0.1), false);
  assert.equal(primitive.hitTest(9, 0, 0.1), true);

  primitive.updateAllViews();
  const moves = [];
  const lines = [];
  let strokes = 0;
  const context = {
    beginPath() {},
    lineTo: (x, y) => lines.push([x, y]),
    moveTo: (x, y) => moves.push([x, y]),
    quadraticCurveTo() {},
    restore() {},
    save() {},
    stroke: () => { strokes += 1; },
  };
  primitive.paneViews()[0].renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  });

  assert.deepEqual(moves, [[0, 0], [8, 0]]);
  assert.deepEqual(lines, [[2, 0], [10, 0]]);
  assert.equal(strokes, 1);
});

test("freehand v2 hit testing skips unresolved singleton paths omitted by the renderer", () => {
  const value = strokeWithUnresolvedMiddle();
  value.points = [
    { span: 0, ratio: 0.5, price: 0 },
    { span: 1, ratio: 0.5, price: 0 },
    { span: 0, ratio: 0.5, price: 0 },
  ];
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const primitive = new FreehandDrawingPrimitive({ id: "v2-singleton", stroke: value });
  primitive.attached({ chart, series, requestUpdate: () => {} });

  assert.equal(primitive.hitTest(5, 0, 0.1), false);
});

test("freehand v3 renderer and hit testing split at unresolved absolute-time points", () => {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const primitive = new FreehandDrawingPrimitive({
    id: "v3-gap",
    stroke: strokeV3WithAbsoluteMiddle(),
    lineWidth: 2,
  });
  primitive.attached({ chart, series, requestUpdate: () => {} });

  assert.equal(primitive.hitTest(1, 0, 0.1), true);
  assert.equal(primitive.hitTest(5, 0, 0.1), false);
  assert.equal(primitive.hitTest(9, 0, 0.1), true);
  assert.deepEqual(renderedPathMoves(primitive), [[0, 0], [8, 0]]);
});

test("freehand v3 resolves lineage and future time points from one coordinate snapshot", () => {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  let snapshots = 0;
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = {
    data: () => {
      throw new Error("the atomic drawing snapshot owns series data");
    },
    priceToCoordinate: (price) => price,
  };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => {
      snapshots += 1;
      return {
        seriesData: rows,
        sourceTimeHorizon: 200,
        sourceInterval: "100s",
        sourceIntervalSeconds: 100,
      };
    },
  });
  const stroke = strokeV3WithAbsoluteMiddle();
  stroke.points = [
    { span: 0, ratio: 0, price: 0 },
    { span: 0, ratio: 0.2, price: 0 },
    { time: 500, price: 0 },
    { time: 600, price: 0 },
  ];
  const primitive = new FreehandDrawingPrimitive({ id: "v3-future", stroke, lineWidth: 2 });
  primitive.attached({ chart, series, requestUpdate: () => {} });

  primitive.updateAllViews();
  assert.equal(snapshots, 1);
  assert.equal(primitive.hitTest(45, 0, 0.1), true);
  assert.equal(snapshots, 2);
});

test("freehand v3 exact anchors do not drift to a later same-time synthetic ordinal", () => {
  const rows = [
    row(0, 100, 100, 100, 0),
    row(1, 100, 100, 100, 1),
  ];
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => time.order * 10,
    }),
  };
  const series = { data: () => rows };
  const context = {
    drawingProjectionConfig: "dataset-a:renko:old",
    seriesData: rows,
    sourceTimeHorizon: 100,
  };
  const exactStroke = {
    version: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:old",
    spans: [],
    points: [
      { anchor: { time: 100, sourceOrdinal: 0 }, price: 0 },
      { anchor: { time: 100, sourceOrdinal: 0 }, price: 1 },
    ],
  };
  const bareTimeStroke = {
    ...exactStroke,
    points: [
      { time: 100, price: 0 },
      { time: 100, price: 1 },
    ],
  };

  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, exactStroke, context).map((point) => point.x),
    [0, 0],
  );
  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, bareTimeStroke, context).map((point) => point.x),
    [10, 10],
  );
});

test("freehand primitive accepts known stroke versions and rejects unknown or mixed v3", () => {
  const v2 = strokeWithUnresolvedMiddle();
  const v3 = strokeV3WithAbsoluteMiddle();
  const primitive = new FreehandDrawingPrimitive({ id: "known-v3", stroke: v3 });
  assert.equal(primitive.stroke.version, 3);

  const preview = new FreehandDrawingPrimitive({
    id: "known-v2",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  });
  assert.equal(preview.commitStroke(v2), true);
  assert.equal(preview.stroke.version, 2);

  const rejected = new FreehandDrawingPrimitive({
    id: "unknown",
    stroke: { ...v3, version: 4 },
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  });
  assert.equal(rejected.stroke, null);
  assert.equal(rejected.commitStroke({
    ...v3,
    points: [
      { span: 0, ratio: 0, time: 100, price: 0 },
      { time: 500, price: 0 },
    ],
  }), false);
  assert.equal(rejected.isPreview, true);
});

test("legacy freehand and highlighter split unresolved points on ordinal axes", () => {
  const rows = [
    row(0, 100, 100, 100),
    row(1, 200, 101, 200),
    row(2, 300, 201, 300),
    row(3, 400, 301, 400),
  ];
  const chart = {
    timeScale: () => ({ timeToCoordinate: (time) => time.order * 10 }),
  };
  const series = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };

  for (const type of ["freehand", "highlighter"]) {
    const primitive = new FreehandDrawingPrimitive({
      id: `legacy-ordinal-${type}`,
      type,
      dataPoints: [
        { time: 100, price: 0 },
        { time: 200, price: 0 },
        { time: 500, price: 0 },
        { time: 300, price: 0 },
        { time: 400, price: 0 },
      ],
      lineWidth: 2,
    });
    primitive.attached({ chart, series, requestUpdate: () => {} });

    assert.equal(primitive.hitTest(5, 0, 0.1), true, type);
    assert.equal(primitive.hitTest(15, 0, 0.1), false, type);
    assert.equal(primitive.hitTest(25, 0, 0.1), true, type);
    assert.deepEqual(renderedPathMoves(primitive), [[0, 0], [20, 0]], type);
  }
});

test("legacy freehand keeps filtering invalid points into one path on time axes", () => {
  const coordinates = new Map([
    [100, 0],
    [200, 10],
    [250, 15],
    [300, 20],
    [400, 30],
  ]);
  const chart = {
    timeScale: () => ({ timeToCoordinate: (time) => coordinates.get(time) ?? null }),
  };
  const series = {
    data: () => [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }],
    priceToCoordinate: (price) => (price === 999 ? null : price),
  };
  const primitive = new FreehandDrawingPrimitive({
    id: "legacy-time-axis",
    dataPoints: [
      { time: 100, price: 0 },
      { time: 200, price: 0 },
      { time: 250, price: 999 },
      { time: 300, price: 0 },
      { time: 400, price: 0 },
    ],
    lineWidth: 2,
  });
  primitive.attached({ chart, series, requestUpdate: () => {} });

  assert.equal(primitive.hitTest(15, 0, 0.1), true);
  assert.deepEqual(renderedPathMoves(primitive), [[0, 0]]);
});

test("freehand preview renders screen-space paths and commit clears transient state", () => {
  let updates = 0;
  const primitive = new FreehandDrawingPrimitive({
    id: "v2-preview",
    isPreview: true,
    previewPoints: [],
    lineWidth: 2,
  });
  primitive.attached({
    chart: {},
    series: {},
    requestUpdate: () => { updates += 1; },
  });
  assert.equal(primitive.setPreviewPoints([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    null,
    { x: 8, y: 0 },
    { x: 10, y: 0 },
  ]), true);
  primitive.updateAllViews();
  const moves = [];
  const lines = [];
  const context = {
    beginPath() {},
    lineTo: (x, y) => lines.push([x, y]),
    moveTo: (x, y) => moves.push([x, y]),
    quadraticCurveTo() {},
    restore() {},
    save() {},
    stroke() {},
  };
  primitive.paneViews()[0].renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  });
  assert.deepEqual(moves, [[0, 0], [8, 0]]);
  assert.deepEqual(lines, [[2, 0], [10, 0]]);
  assert.equal(primitive.hitTest(1, 0), false);

  assert.equal(primitive.commitStroke(strokeWithUnresolvedMiddle()), true);
  assert.equal(primitive.isPreview, false);
  assert.deepEqual(primitive.previewPoints, []);
  assert.equal(Object.isFrozen(primitive.stroke), true);
  assert.equal(updates, 2);
});

test("freehand preview appends frame deltas without replacing prior geometry", () => {
  let updates = 0;
  const delta = [{ x: 2, y: 0 }, null, { x: 8, y: 0 }];
  const primitive = new FreehandDrawingPrimitive({
    id: "incremental-preview",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }],
  });
  primitive.attached({
    chart: {},
    series: {},
    requestUpdate: () => { updates += 1; },
  });

  assert.equal(primitive.appendPreviewPoints(delta), true);
  assert.deepEqual(primitive.previewPoints, [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    null,
    { x: 8, y: 0 },
  ]);
  delta[0].x = 99;
  assert.equal(primitive.previewPoints[1].x, 2);
  assert.equal(primitive.appendPreviewPoints([]), true);
  assert.equal(updates, 1);
});

test("freehand preview cancel is terminal and remains persistence-filtered", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "v2-cancel",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  });
  assert.equal(primitive.cancelPreview(), true);
  assert.equal(primitive.isPreview, true);
  assert.deepEqual(primitive.previewPoints, []);
  assert.equal(primitive.commitStroke(strokeWithUnresolvedMiddle()), false);
  assert.equal(primitive.cancelPreview(), false);
});

test("legacy freehand preview commits canonical data points on pointerup", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "legacy-preview",
    isPreview: true,
    dataPoints: [
      { time: 100, logical: 1.5, order: 7, price: 10 },
      { time: 200, logical: 2.5, order: 8, price: 11 },
    ],
  });

  assert.equal(primitive.commitDataPoints(), true);
  assert.equal(primitive.isPreview, false);
  assert.deepEqual(primitive.dataPoints, [
    { time: 100, logical: 1.5, price: 10 },
    { time: 200, logical: 2.5, price: 11 },
  ]);
});
