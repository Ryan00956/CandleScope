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
