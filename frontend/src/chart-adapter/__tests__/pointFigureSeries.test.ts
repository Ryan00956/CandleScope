import assert from "node:assert/strict";
import test from "node:test";

import { createPointFigureSeriesPaneView } from "../pointFigureSeries.js";
import type { PointFigureCustomData } from "../chartAdapterTypes.js";
import { structuralMock } from "../../test/testHelpers.js";
import { chartCoordinate } from "./chartAdapterTestHelpers.js";

interface ColumnOptions {
  close: number;
  color?: string;
  direction: "o" | "x";
  high: number;
  low: number;
  open: number;
}

function column({ color, direction, low, high, open, close }: ColumnOptions): PointFigureCustomData {
  return structuralMock<PointFigureCustomData>({
    time: 1,
    open,
    high,
    low,
    close,
    ...(color ? { color } : {}),
    customValues: {
      pointAndFigure: { boxSize: 1, direction, reversalAmount: 3, source: "close" },
    },
  });
}

type PointFigurePaneView = ReturnType<typeof createPointFigureSeriesPaneView>;

function updatePane(paneView: PointFigurePaneView, data: object): void {
  paneView.update(
    structuralMock<Parameters<PointFigurePaneView["update"]>[0]>(data),
    { ...paneView.defaultOptions(), upColor: "green", downColor: "red", lineWidth: 2 },
  );
}

function drawPane(
  paneView: PointFigurePaneView,
  context: CanvasRenderingContext2D,
  converter: (price: number) => number,
): void {
  paneView.renderer().draw(
    structuralMock<Parameters<ReturnType<PointFigurePaneView["renderer"]>["draw"]>[0]>({
      useBitmapCoordinateSpace: (draw: (scope: {
        context: CanvasRenderingContext2D;
        horizontalPixelRatio: number;
        verticalPixelRatio: number;
      }) => void) => draw({ context, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
    }),
    (price: number) => chartCoordinate(converter(price)),
    false,
  );
}

interface CanvasRecorderOptions {
  onEllipse?: (args: number[]) => void;
  onMove?: (args: number[]) => void;
  onStroke?: (color: CanvasRenderingContext2D["strokeStyle"]) => void;
}

function recordingCanvas({
  onEllipse = () => {},
  onMove = () => {},
  onStroke = () => {},
}: CanvasRecorderOptions = {}): CanvasRenderingContext2D {
  const context = structuralMock<CanvasRenderingContext2D>({
    beginPath() {},
    ellipse: (...args: number[]) => { onEllipse(args); },
    lineTo() {},
    moveTo: (...args: number[]) => { onMove(args); },
    stroke() { onStroke(context.strokeStyle); },
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    strokeStyle: "",
  });
  return context;
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
  const strokes: Array<CanvasRenderingContext2D["strokeStyle"]> = [];
  const moves: number[][] = [];
  const ellipses: number[][] = [];
  const context = recordingCanvas({
    onEllipse: (args) => { ellipses.push(args); },
    onMove: (args) => { moves.push(args); },
    onStroke: (color) => { strokes.push(color); },
  });
  const columns = [
    column({ direction: "x", low: 101, high: 103, open: 101, close: 103 }),
    column({ direction: "o", low: 100, high: 102, open: 102, close: 100 }),
  ];
  updatePane(paneView, {
    barSpacing: 12,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 2 },
    bars: columns.map((originalData, index) => ({
      x: 10 + index * 12,
      originalData,
    })),
  });

  drawPane(paneView, context, (price) => 1200 - price * 10);

  assert.equal(moves.length, 6);
  assert.equal(ellipses.length, 3);
  assert.deepEqual(strokes, ["green", "green", "green", "red", "red", "red"]);
});

test("Point & Figure renderer applies per-column barcolor overrides", () => {
  const paneView = createPointFigureSeriesPaneView();
  const strokes: Array<CanvasRenderingContext2D["strokeStyle"]> = [];
  const context = recordingCanvas({ onStroke: (color) => { strokes.push(color); } });
  const columns = [
    column({ color: "orange", direction: "x", low: 101, high: 102, open: 101, close: 102 }),
    column({ direction: "o", low: 100, high: 101, open: 101, close: 100 }),
  ];
  updatePane(paneView, {
    barSpacing: 12,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 2 },
    bars: [
      { x: 10, originalData: columns[0], barColor: "cyan" },
      { x: 22, originalData: columns[1], barColor: "purple" },
    ],
  });

  drawPane(paneView, context, (price) => 1200 - price * 10);

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

  const moves: number[][] = [];
  const strokes: Array<CanvasRenderingContext2D["strokeStyle"]> = [];
  const context = recordingCanvas({
    onMove: (args) => { moves.push(args); },
    onStroke: (color) => { strokes.push(color); },
  });
  updatePane(paneView, {
    barSpacing: 12,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 1 },
    bars: [{ x: 10, originalData: dense }],
  });
  drawPane(paneView, context, (price) => 30_000 - price);

  assert.equal(moves.length, 1);
  assert.deepEqual(strokes, ["orange"]);
});
