import assert from "node:assert/strict";
import test from "node:test";

import { createPointFigureSeriesPaneView } from "../pointFigureSeries.js";

function column({ color, direction, low, high, open, close }) {
  return {
    time: 1,
    open,
    high,
    low,
    close,
    ...(color ? { color } : {}),
    customValues: {
      pointAndFigure: { boxSize: 1, direction, reversalAmount: 3, source: "close" },
    },
  };
}

test("Point & Figure custom series exposes full column price coverage", () => {
  const paneView = createPointFigureSeriesPaneView();
  const data = column({ direction: "x", low: 101, high: 103, open: 101, close: 103 });
  assert.deepEqual(paneView.priceValueBuilder(data), [103, 101, 103]);
  assert.equal(paneView.isWhitespace(data), false);
  assert.equal(paneView.isWhitespace({ time: 2 }), true);
});

test("Point & Figure renderer draws one X or O for every box in a visible column", () => {
  const paneView = createPointFigureSeriesPaneView();
  const strokes = [];
  const moves = [];
  const ellipses = [];
  const context = {
    beginPath() {},
    ellipse: (...args) => ellipses.push(args),
    lineTo() {},
    moveTo: (...args) => moves.push(args),
    stroke() { strokes.push(this.strokeStyle); },
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    strokeStyle: "",
  };
  const columns = [
    column({ direction: "x", low: 101, high: 103, open: 101, close: 103 }),
    column({ direction: "o", low: 100, high: 102, open: 102, close: 100 }),
  ];
  paneView.update({
    barSpacing: 12,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 2 },
    bars: columns.map((originalData, index) => ({
      x: 10 + index * 12,
      originalData,
    })),
  }, { upColor: "green", downColor: "red", lineWidth: 2 });

  paneView.renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  }, (price) => 1200 - price * 10);

  assert.equal(moves.length, 6);
  assert.equal(ellipses.length, 3);
  assert.deepEqual(strokes, ["green", "green", "green", "red", "red", "red"]);
});

test("Point & Figure renderer applies per-column barcolor overrides", () => {
  const paneView = createPointFigureSeriesPaneView();
  const strokes = [];
  const context = {
    beginPath() {},
    ellipse() {},
    lineTo() {},
    moveTo() {},
    stroke() { strokes.push(this.strokeStyle); },
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    strokeStyle: "",
  };
  const columns = [
    column({ color: "orange", direction: "x", low: 101, high: 102, open: 101, close: 102 }),
    column({ direction: "o", low: 100, high: 101, open: 101, close: 100 }),
  ];
  paneView.update({
    barSpacing: 12,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 2 },
    bars: [
      { x: 10, originalData: columns[0], barColor: "cyan" },
      { x: 22, originalData: columns[1], barColor: "purple" },
    ],
  }, { upColor: "green", downColor: "red", lineWidth: 2 });

  paneView.renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  }, (price) => 1200 - price * 10);

  assert.deepEqual(strokes, ["orange", "orange", "purple", "purple"]);
});

test("dense Point & Figure columns remain autoscaled and use a bounded rendering fallback", () => {
  const paneView = createPointFigureSeriesPaneView();
  const dense = column({
    color: "orange",
    direction: "x",
    low: 1,
    high: 20_001,
    open: 1,
    close: 20_001,
  });
  assert.equal(paneView.isWhitespace(dense), false);

  const moves = [];
  const strokes = [];
  const context = {
    beginPath() {},
    ellipse() {},
    lineTo() {},
    moveTo: (...args) => moves.push(args),
    stroke() { strokes.push(this.strokeStyle); },
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    strokeStyle: "",
  };
  paneView.update({
    barSpacing: 12,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 1 },
    bars: [{ x: 10, originalData: dense }],
  }, { upColor: "green", downColor: "red", lineWidth: 2 });
  paneView.renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  }, (price) => 30_000 - price);

  assert.equal(moves.length, 1);
  assert.deepEqual(strokes, ["orange"]);
});
