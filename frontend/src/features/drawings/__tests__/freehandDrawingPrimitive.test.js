import assert from "node:assert/strict";
import test from "node:test";

import { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";

function row(order, sourceTime, from, to) {
  return {
    time: { order, sourceTime, sourceOrdinal: 0 },
    customValues: {
      chartProjection: {
        projectorId: "renko",
        sourceFromTime: from,
        sourceOrdinal: 0,
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
