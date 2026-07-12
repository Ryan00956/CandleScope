import assert from "node:assert/strict";
import test from "node:test";

import {
  commitTwoPointDrawing,
  placeTextDrawing,
} from "../drawingCreationController.js";

function eventStub() {
  return {
    altKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

function derivedPoint(time, sourceOrdinal, price) {
  return {
    time,
    sourceOrdinal,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
    price,
  };
}

function commitDerivedTwoPointTool(tool) {
  const first = derivedPoint(100, 1, 10);
  const second = derivedPoint(200, 2, 20);
  const primitivesRef = { current: [] };
  const anchorDataRef = { current: first };
  const preview = { id: "__preview__" };
  const previewRef = { current: preview };
  const attached = [];
  const detached = [];
  let persisted = 0;

  const consumed = commitTwoPointDrawing({
    tool,
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    anchorDataRef,
    previewRef,
    attachPrim: (primitive) => attached.push(primitive),
    detachPrim: (primitive) => detached.push(primitive),
    selectPrimitive() {},
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: () => second,
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  });

  assert.equal(consumed, true);
  assert.deepEqual(detached, [preview]);
  assert.equal(attached.length, 1);
  assert.strictEqual(primitivesRef.current[0], attached[0]);
  assert.deepEqual(attached[0].dataPoints, [first, second]);
  assert.equal(anchorDataRef.current, null);
  assert.equal(previewRef.current, null);
  assert.equal(persisted, 1);
  return attached[0];
}

test("angle measurement commits canonical source-lineage endpoints", () => {
  const primitive = commitDerivedTwoPointTool("angle-measure");
  assert.equal(primitive.type, "angle-measure");
});

test("shape drawing commits canonical source-lineage corners", () => {
  const primitive = commitDerivedTwoPointTool("shape-rectangle");
  assert.equal(primitive._type, "shape");
  assert.equal(primitive._shapeType, "rectangle");
});

test("text drawing keeps its canonical source-lineage anchor", () => {
  const dataPoint = derivedPoint(300, 3, 30);
  const primitivesRef = { current: [] };
  let editingPrimitive = null;
  const attached = [];

  assert.equal(placeTextDrawing({
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef,
    attachPrim: (primitive) => attached.push(primitive),
    startTextEditing: (primitive) => { editingPrimitive = primitive; },
    screenToDrawingData: () => dataPoint,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    textFontSizeRef: { current: 14 },
    textBoldRef: { current: false },
    textItalicRef: { current: false },
  }), true);

  assert.equal(attached.length, 1);
  assert.strictEqual(primitivesRef.current[0], attached[0]);
  assert.strictEqual(editingPrimitive, attached[0]);
  assert.deepEqual(attached[0].dataPoint, dataPoint);
});
