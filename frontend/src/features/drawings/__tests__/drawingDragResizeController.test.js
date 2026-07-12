import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLineFibShapeDrag,
  applyTextAndPositionDrag,
} from "../drawingDragResizeController.js";
import { AxisLineDrawingPrimitive } from "../primitives/AxisLineDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "../primitives/AngleMeasurementPrimitive.js";
import { ShapeDrawingPrimitive } from "../primitives/ShapeDrawingPrimitive.js";
import { TextDrawingPrimitive } from "../primitives/TextDrawingPrimitive.js";

function eventStub() {
  return {
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

function dragAxisLine(axisLineType, original, next) {
  const primitive = new AxisLineDrawingPrimitive({
    id: `axis-${axisLineType}`,
    axisLineType,
    dataPoint: original,
  });
  applyLineFibShapeDrag({
    dragging: {
      id: primitive.id,
      type: "axis-line",
      startMouse: { x: 0, y: 0 },
      origDataPoint: original,
    },
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: { current: [primitive] },
    screenToData: () => next,
    dataToScreen: () => null,
    screenToDrawingData: () => next,
    drawingSnapEnabledRef: { current: true },
  });
  return primitive.dataPoint;
}

test("vertical axis drag replaces the complete canonical horizontal anchor", () => {
  const point = dragAxisLine("vertical", {
    time: 100,
    logical: 5,
    order: 1,
    sourceOrdinal: 0,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{}",
    price: 10,
  }, {
    time: 200,
    logical: 8,
    order: 6,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{}",
    price: 99,
  });

  assert.deepEqual(point, {
    time: 200,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{}",
    price: 10,
  });
});

test("cross axis drag replaces horizontal metadata and price together", () => {
  const point = dragAxisLine("cross", {
    time: 100,
    sourceOrdinal: 0,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{}",
    price: 10,
  }, {
    time: 200,
    sourceOrdinal: 1,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
    order: 4,
    price: 99,
  });

  assert.deepEqual(point, {
    time: 200,
    sourceOrdinal: 1,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
    price: 99,
  });
});

test("horizontal axis drag preserves its complete original horizontal anchor", () => {
  const point = dragAxisLine("horizontal", {
    time: 100,
    sourceOrdinal: 3,
    sourceProjection: "line-break",
    sourceProjectionConfig: "derived-ordinal:line-break:{}",
    price: 10,
  }, {
    time: 200,
    sourceOrdinal: 1,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
    price: 99,
  });

  assert.deepEqual(point, {
    time: 100,
    sourceOrdinal: 3,
    sourceProjection: "line-break",
    sourceProjectionConfig: "derived-ordinal:line-break:{}",
    price: 99,
  });
});

function derivedPoint(time, sourceOrdinal, price) {
  return {
    time,
    sourceOrdinal,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:{}",
    price,
  };
}

test("angle endpoint drag accepts a complete canonical source-lineage anchor", () => {
  const first = derivedPoint(100, 0, 10);
  const second = derivedPoint(200, 1, 20);
  const next = derivedPoint(300, 2, 30);
  const primitive = new AngleMeasurementPrimitive({
    id: "angle",
    dataPoints: [first, second],
  });

  applyLineFibShapeDrag({
    dragging: {
      id: primitive.id,
      type: "angle",
      pointIndex: 1,
      startMouse: { x: 0, y: 0 },
      origPoints: [first, second],
    },
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: { current: [primitive] },
    screenToData: () => next,
    dataToScreen: () => null,
    screenToDrawingData: () => next,
    drawingSnapEnabledRef: { current: true },
  });

  assert.deepEqual(primitive.dataPoints, [first, next]);
});

test("shape resize replaces both corners with canonical source-lineage anchors", () => {
  const first = derivedPoint(100, 0, 10);
  const second = derivedPoint(200, 1, 20);
  const nextFirst = derivedPoint(300, 2, 30);
  const nextSecond = derivedPoint(400, 3, 40);
  const primitive = new ShapeDrawingPrimitive({
    id: "shape",
    shapeType: "rectangle",
    dataPoints: [first, second],
  });
  let conversion = 0;

  applyLineFibShapeDrag({
    dragging: {
      id: primitive.id,
      type: "shape",
      zone: "br",
      startMouse: { x: 0, y: 0 },
      origPoints: [first, second],
      origBox: { x: 0, y: 0, width: 10, height: 10 },
    },
    pos: { x: 20, y: 20 },
    e: eventStub(),
    primitivesRef: { current: [primitive] },
    screenToData: () => (conversion++ === 0 ? nextFirst : nextSecond),
    dataToScreen: () => null,
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
  });

  assert.deepEqual(primitive.dataPoints, [nextFirst, nextSecond]);
});

test("text body drag replaces its anchor with canonical source lineage", () => {
  const original = derivedPoint(100, 0, 10);
  const next = derivedPoint(200, 1, 20);
  const primitive = new TextDrawingPrimitive({
    id: "text",
    dataPoint: original,
    text: "note",
  });

  assert.equal(applyTextAndPositionDrag({
    dragging: {
      id: primitive.id,
      type: "text",
      startMouse: { x: 0, y: 0 },
      origDataPoint: original,
    },
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: { current: [primitive] },
    screenToData: () => next,
    dataToScreen: () => ({ x: 0, y: 0 }),
    screenToDrawingData: () => next,
    refreshSelectedTextUi() {},
    drawingSnapEnabledRef: { current: true },
    chartContainerRef: { current: null },
  }), true);

  assert.deepEqual(primitive.dataPoint, next);
});
