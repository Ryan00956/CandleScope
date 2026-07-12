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
import {
  normalizedPositionScreenRange,
  PositionDrawingPrimitive,
} from "../primitives/PositionDrawingPrimitive.js";

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

function positionPrimitive() {
  return new PositionDrawingPrimitive({
    id: "position",
    direction: "long",
    entryPrice: 100,
    tpPrice: 110,
    slPrice: 95,
    timeRange: {
      start: derivedPoint(100, 0, 100),
      end: derivedPoint(200, 0, 100),
    },
  });
}

function dragPosition(primitive, dragging, {
  altKey = false,
  dataToScreen,
  snapEnabled = true,
  screenToDrawingData,
  pos = { x: 10, y: 10 },
} = {}) {
  return applyTextAndPositionDrag({
    dragging,
    pos,
    e: { ...eventStub(), altKey },
    primitivesRef: { current: [primitive] },
    screenToData: () => null,
    dataToScreen,
    screenToDrawingData,
    refreshSelectedTextUi() {},
    drawingSnapEnabledRef: { current: snapEnabled },
    chartContainerRef: { current: null },
  });
}

test("position whole drag commits both canonical endpoints and prices atomically", () => {
  const primitive = positionPrimitive();
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };
  const originalRange = primitive.timeRange;
  const nextStart = { ...derivedPoint(300, 0, 105), order: 30, logical: 3 };
  const nextEnd = { ...derivedPoint(400, 0, 105), order: 40, logical: 4 };
  const conversions = [];

  assert.equal(dragPosition(primitive, {
    id: primitive.id,
    type: "position-move",
    startMouse: { x: 0, y: 0 },
    origEntry: 100,
    origTp: 110,
    origSl: 95,
    origTimeRange: originalRange,
  }, {
    dataToScreen: (point) => {
      if (point.time === 100) return { x: 10, y: 100 };
      if (point.time === 200) return { x: 30, y: 100 };
      return { x: 22, y: 105 };
    },
    screenToDrawingData: (x, y, options) => {
      conversions.push({ options, x, y });
      return conversions.length === 1 ? nextStart : nextEnd;
    },
  }), true);

  assert.deepEqual(primitive.timeRange, {
    start: {
      time: 300,
      sourceOrdinal: 0,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset-a:renko:{}",
    },
    end: {
      time: 400,
      sourceOrdinal: 0,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset-a:renko:{}",
    },
  });
  assert.equal(primitive.entryPrice, 105);
  assert.equal(primitive.tpPrice, 115);
  assert.equal(primitive.slPrice, 100);
  assert.equal(updates, 1);
  assert.deepEqual(conversions, [{
    options: { snap: true },
    x: 20,
    y: 110,
  }, {
    options: { snap: false },
    x: 42,
    y: 105,
  }]);
});

test("position whole drag leaves every field unchanged when either endpoint is unresolved", () => {
  const primitive = positionPrimitive();
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };
  const before = {
    entry: primitive.entryPrice,
    tp: primitive.tpPrice,
    sl: primitive.slPrice,
    range: primitive.timeRange,
  };

  dragPosition(primitive, {
    id: primitive.id,
    type: "position-move",
    startMouse: { x: 0, y: 0 },
    origEntry: 100,
    origTp: 110,
    origSl: 95,
    origTimeRange: primitive.timeRange,
  }, {
    dataToScreen: (point) => ({ x: point.time === 100 ? 10 : 30, y: 100 }),
    screenToDrawingData: (x) => (x === 20 ? derivedPoint(300, 0, 105) : null),
  });

  assert.equal(primitive.entryPrice, before.entry);
  assert.equal(primitive.tpPrice, before.tp);
  assert.equal(primitive.slPrice, before.sl);
  assert.strictEqual(primitive.timeRange, before.range);
  assert.equal(updates, 0);
});

test("position whole drag preserves canonical span when both anchors fold to one display row", () => {
  const primitive = positionPrimitive();
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };
  const originalRange = primitive.timeRange;

  dragPosition(primitive, {
    id: primitive.id,
    type: "position-move",
    startMouse: { x: 0, y: 0 },
    origEntry: 100,
    origTp: 110,
    origSl: 95,
    origTimeRange: originalRange,
  }, {
    dataToScreen: () => ({ x: 20, y: 100 }),
    screenToDrawingData: () => derivedPoint(300, 0, 105),
  });

  assert.deepEqual(primitive.timeRange, originalRange);
  assert.equal(primitive.entryPrice, 105);
  assert.equal(primitive.tpPrice, 115);
  assert.equal(primitive.slPrice, 100);
  assert.equal(updates, 1);
});

test("position edge drag uses resolved candidate coordinates and rejects crossing", () => {
  const primitive = positionPrimitive();
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };

  dragPosition(primitive, {
    id: primitive.id,
    type: "position-left",
    startMouse: { x: 0, y: 0 },
    origTimeRange: primitive.timeRange,
  }, {
    pos: { x: 15, y: 100 },
    dataToScreen: (point) => ({ x: point.time === 200 ? 20 : 25, y: 100 }),
    screenToDrawingData: () => ({ ...derivedPoint(150, 0, 100), order: 5, logical: 5 }),
  });

  assert.equal(primitive.timeRange.start.time, 100);
  assert.equal(updates, 0);
});

test("position edge drag is a no-op when either endpoint cannot resolve", () => {
  const primitive = positionPrimitive();
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };

  dragPosition(primitive, {
    id: primitive.id,
    type: "position-right",
    startMouse: { x: 0, y: 0 },
    origTimeRange: primitive.timeRange,
  }, {
    pos: { x: 40, y: 100 },
    dataToScreen: (point) => (point.time === 300 ? { x: 40, y: 100 } : null),
    screenToDrawingData: () => derivedPoint(300, 0, 100),
  });

  assert.equal(primitive.timeRange.end.time, 200);
  assert.equal(updates, 0);
});

test("position edge drag replaces one endpoint with canonical lineage", () => {
  const primitive = positionPrimitive();
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };

  dragPosition(primitive, {
    id: primitive.id,
    type: "position-right",
    startMouse: { x: 0, y: 0 },
    origTimeRange: primitive.timeRange,
  }, {
    pos: { x: 40, y: 100 },
    dataToScreen: (point) => ({ x: point.time === 100 ? 10 : 40, y: 100 }),
    screenToDrawingData: () => ({ ...derivedPoint(300, 1, 100), order: 8, logical: 8 }),
  });

  assert.deepEqual(primitive.timeRange.end, {
    time: 300,
    sourceOrdinal: 1,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:{}",
  });
  assert.equal(updates, 1);
});

test("position edge drag maps visual sides to legacy reversed anchors", () => {
  const primitive = new PositionDrawingPrimitive({
    id: "reversed-position",
    direction: "long",
    entryPrice: 100,
    tpPrice: 110,
    slPrice: 95,
    timeRange: {
      start: derivedPoint(200, 0, 100),
      end: derivedPoint(100, 0, 100),
    },
  });
  let updates = 0;
  primitive._requestUpdate = () => { updates += 1; };

  dragPosition(primitive, {
    id: primitive.id,
    type: "position-left",
    startMouse: { x: 0, y: 0 },
    origTimeRange: primitive.timeRange,
  }, {
    pos: { x: 5, y: 100 },
    dataToScreen: (point) => {
      if (point.time === 200) return { x: 40, y: 100 };
      if (point.time === 100) return { x: 10, y: 100 };
      return { x: 5, y: 100 };
    },
    screenToDrawingData: () => derivedPoint(50, 0, 100),
  });

  assert.equal(primitive.timeRange.start.time, 200);
  assert.equal(primitive.timeRange.end.time, 50);
  assert.equal(updates, 1);
});

test("folded position visual range expands symmetrically without changing anchors", () => {
  assert.deepEqual(normalizedPositionScreenRange(50, 50, 12), {
    collapsed: true,
    leftX: 38,
    rightX: 62,
  });
  assert.deepEqual(normalizedPositionScreenRange(70, 40, 12), {
    collapsed: false,
    leftX: 40,
    rightX: 70,
  });
  assert.deepEqual(normalizedPositionScreenRange(50, 58, 24), {
    collapsed: false,
    leftX: 42,
    rightX: 66,
  });
});

test("compact position hit testing keeps price lines, body, and both edges reachable", () => {
  const primitive = new PositionDrawingPrimitive({
    id: "folded-position",
    direction: "long",
    entryPrice: 100,
    tpPrice: 60,
    slPrice: 140,
    timeRange: {
      start: { time: 100 },
      end: { time: 200 },
    },
  });
  const timeScale = {
    options: () => ({ barSpacing: 8 }),
    timeToCoordinate: (time) => (time === 100 ? 50 : 58),
  };
  primitive.attached({
    chart: { timeScale: () => timeScale },
    series: {
      data: () => [{ time: 100 }, { time: 200 }],
      priceToCoordinate: (price) => price,
    },
    requestUpdate() {},
  });
  primitive.setSelected(true);

  assert.deepEqual(primitive.hitTest(43, 80), { zone: "left", pointIndex: -1 });
  assert.deepEqual(primitive.hitTest(65, 80), { zone: "right", pointIndex: -1 });
  assert.deepEqual(primitive.hitTest(54, 80), { zone: "body", pointIndex: -1 });
  assert.deepEqual(primitive.hitTest(42, 60), { zone: "tp", pointIndex: -1 });
  assert.deepEqual(primitive.hitTest(66, 140), { zone: "sl", pointIndex: -1 });
  assert.deepEqual(primitive.hitTest(54, 100), { zone: "entry", pointIndex: -1 });
});
