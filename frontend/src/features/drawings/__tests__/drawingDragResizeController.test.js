import assert from "node:assert/strict";
import test from "node:test";

import { applyLineFibShapeDrag } from "../drawingDragResizeController.js";
import { AxisLineDrawingPrimitive } from "../primitives/AxisLineDrawingPrimitive.js";

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
