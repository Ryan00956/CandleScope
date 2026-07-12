import assert from "node:assert/strict";
import test from "node:test";

import {
  beginAxisLineDrawing,
  beginTwoPointDrawing,
  commitTwoPointDrawing,
  placePositionDrawing,
  placeTextDrawing,
  startFreehandStroke,
} from "../drawingCreationController.js";

function eventStub() {
  return {
    altKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

function trackedEventStub() {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    calls,
    event: {
      altKey: false,
      shiftKey: false,
      preventDefault() { calls.preventDefault += 1; },
      stopPropagation() { calls.stopPropagation += 1; },
    },
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

function sourceLineageCaptureBatch(identity = {}) {
  return {
    captureIdentity: identity,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
    captures: [{
      span: {
        exact: {
          left: { time: 100, sourceOrdinal: 0 },
          right: { time: 100, sourceOrdinal: 1 },
        },
        fallback: {
          fromTime: 100,
          toTime: 100,
          leftRatio: 0.25,
          rightRatio: 0.75,
        },
      },
      ratio: 0.4,
      price: 10,
      screen: { x: 20, y: 30 },
    }],
  };
}

test("source-lineage freehand creation starts a transient v2 draft preview", () => {
  const primitivesRef = { current: [] };
  const currentFreehandRef = { current: null };
  const freehandDraftRef = { current: null };
  const isDrawingFreehandRef = { current: false };
  const attached = [];

  assert.equal(startFreehandStroke({
    tool: "pen",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim: (primitive) => attached.push(primitive),
    screenToData: () => { throw new Error("source lineage must not fall back to v1"); },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    sourceLineage: true,
    captureBatch: sourceLineageCaptureBatch(),
  }), true);

  assert.equal(attached.length, 1);
  assert.strictEqual(primitivesRef.current[0], attached[0]);
  assert.strictEqual(currentFreehandRef.current, attached[0]);
  assert.ok(freehandDraftRef.current);
  assert.equal(isDrawingFreehandRef.current, true);
  assert.equal(attached[0].isPreview, true);
  assert.deepEqual(attached[0].previewPoints, [{ x: 20, y: 30 }]);
  assert.deepEqual(attached[0].dataPoints, []);
});

test("source-time freehand creation keeps the legacy model transient until pointerup", () => {
  const primitivesRef = { current: [] };
  const currentFreehandRef = { current: null };
  const freehandDraftRef = { current: "stale" };
  const isDrawingFreehandRef = { current: false };
  const point = { time: 100, logical: 1.5, price: 10 };

  assert.equal(startFreehandStroke({
    tool: "highlighter",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim() {},
    screenToData: () => point,
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 8 },
  }), true);

  assert.equal(freehandDraftRef.current, null);
  assert.equal(currentFreehandRef.current.isPreview, true);
  assert.deepEqual(currentFreehandRef.current.dataPoints, [point]);
});

test("source-lineage freehand creation fails closed without an atomic capture", () => {
  const primitivesRef = { current: [] };
  const currentFreehandRef = { current: null };
  const freehandDraftRef = { current: null };
  const isDrawingFreehandRef = { current: false };

  const tracked = trackedEventStub();
  assert.equal(startFreehandStroke({
    tool: "pen",
    pos: { x: 20, y: 30 },
    e: tracked.event,
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim() {},
    screenToData: () => derivedPoint(100, 0, 10),
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    sourceLineage: true,
    captureBatch: null,
  }), true);

  assert.deepEqual(primitivesRef.current, []);
  assert.equal(currentFreehandRef.current, null);
  assert.equal(freehandDraftRef.current, null);
  assert.equal(isDrawingFreehandRef.current, false);
  assert.deepEqual(tracked.calls, { preventDefault: 1, stopPropagation: 1 });
});

test("active text and position tools retain pointer ownership when first capture fails", () => {
  const textEvent = trackedEventStub();
  assert.equal(placeTextDrawing({
    pos: { x: 10, y: 20 },
    e: textEvent.event,
    primitivesRef: { current: [] },
    attachPrim() {},
    startTextEditing() {},
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    textFontSizeRef: { current: 14 },
    textBoldRef: { current: false },
    textItalicRef: { current: false },
  }), true);
  assert.deepEqual(textEvent.calls, { preventDefault: 1, stopPropagation: 1 });

  const positionEvent = trackedEventStub();
  assert.equal(placePositionDrawing({
    tool: "position-long",
    pos: { x: 10, y: 20 },
    e: positionEvent.event,
    primitivesRef: { current: [] },
    attachPrim() {},
    selectPrimitive() {},
    persistDrawings() {},
    screenToDrawingData: () => null,
    getChartAdapter: () => { throw new Error("adapter should not be read"); },
    chartContainerRef: { current: null },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1000 },
  }), true);
  assert.deepEqual(positionEvent.calls, { preventDefault: 1, stopPropagation: 1 });
});

test("position tool retains pointer ownership when its second row cannot resolve", () => {
  const tracked = trackedEventStub();
  const primitivesRef = { current: [] };
  let persisted = 0;
  assert.equal(placePositionDrawing({
    tool: "position-short",
    pos: { x: 100, y: 20 },
    e: tracked.event,
    primitivesRef,
    attachPrim() {},
    selectPrimitive() {},
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: (x) => (x === 100 ? derivedPoint(100, 0, 10) : null),
    getChartAdapter: () => ({ isReady: () => true }),
    chartContainerRef: { current: { clientHeight: 400, clientWidth: 800 } },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1000 },
  }), true);
  assert.deepEqual(tracked.calls, { preventDefault: 1, stopPropagation: 1 });
  assert.deepEqual(primitivesRef.current, []);
  assert.equal(persisted, 0);
});

test("pending two-point placement owns a failed second capture, but an inapplicable commit does not", () => {
  const pendingEvent = trackedEventStub();
  const anchor = derivedPoint(100, 0, 10);
  const preview = { id: "__preview__" };
  const anchorDataRef = { current: anchor };
  const previewRef = { current: preview };
  assert.equal(commitTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: pendingEvent.event,
    primitivesRef: { current: [] },
    anchorDataRef,
    previewRef,
    attachPrim() {},
    detachPrim() {},
    selectPrimitive() {},
    persistDrawings() {},
    screenToDrawingData: () => null,
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);
  assert.deepEqual(pendingEvent.calls, { preventDefault: 1, stopPropagation: 1 });
  assert.strictEqual(anchorDataRef.current, anchor);
  assert.strictEqual(previewRef.current, preview);

  const inactiveEvent = trackedEventStub();
  assert.equal(commitTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: inactiveEvent.event,
    anchorDataRef: { current: null },
    previewRef: { current: null },
  }), false);
  assert.deepEqual(inactiveEvent.calls, { preventDefault: 0, stopPropagation: 0 });
});

test("axis-line and first two-point capture failures retain active-tool pointer ownership", () => {
  const axisEvent = trackedEventStub();
  assert.equal(beginAxisLineDrawing({
    tool: "line-vertical",
    pos: { x: 10, y: 20 },
    e: axisEvent.event,
    primitivesRef: { current: [] },
    anchorDataRef: { current: null },
    previewRef: { current: null },
    draggingRef: { current: null },
    attachPrim() {},
    selectPrimitive() {},
    removePreview() {},
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
  }), true);
  assert.deepEqual(axisEvent.calls, { preventDefault: 1, stopPropagation: 1 });

  const twoPointEvent = trackedEventStub();
  assert.equal(beginTwoPointDrawing({
    tool: "shape-rectangle",
    pos: { x: 10, y: 20 },
    e: twoPointEvent.event,
    anchorDataRef: { current: null },
    previewRef: { current: null },
    attachPrim() {},
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);
  assert.deepEqual(twoPointEvent.calls, { preventDefault: 1, stopPropagation: 1 });
});

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

function placeDerivedPosition(tool, {
  pointerX = 100,
  width = 1000,
  adapterOverrides = {},
  candidateForX = (x) => (x >= 200
    ? { ...derivedPoint(200, 2, 100), order: 9, logical: 91 }
    : null),
} = {}) {
  const pointerData = {
    ...derivedPoint(100, 1, 100),
    order: 7,
    logical: 71,
  };
  const primitivesRef = { current: [] };
  const attached = [];
  const convertedXs = [];
  let persisted = 0;

  const consumed = placePositionDrawing({
    tool,
    pos: { x: pointerX, y: 120 },
    e: eventStub(),
    primitivesRef,
    attachPrim: (primitive) => attached.push(primitive),
    selectPrimitive() {},
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: (x) => {
      convertedXs.push(x);
      if (Math.abs(x - pointerX) < 0.5) return pointerData;
      return candidateForX(x);
    },
    getChartAdapter: () => ({
      isReady: () => true,
      getVisibleTimeRange() {
        throw new Error("position creation must not subtract ordinal visible-range objects");
      },
      getVisiblePriceRange: () => 100,
      ...adapterOverrides,
    }),
    chartContainerRef: { current: { clientHeight: 400, clientWidth: width } },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 2500 },
  });

  return { attached, consumed, convertedXs, persisted, primitivesRef };
}

test("derived long and short positions use two canonical screen-row anchors", () => {
  for (const [tool, direction] of [["position-long", "long"], ["position-short", "short"]]) {
    const result = placeDerivedPosition(tool);
    assert.equal(result.consumed, true);
    assert.equal(result.attached.length, 1);
    assert.strictEqual(result.primitivesRef.current[0], result.attached[0]);
    assert.equal(result.persisted, 1);
    assert.equal(result.attached[0].direction, direction);
    assert.deepEqual(result.attached[0].timeRange, {
      start: {
        time: 100,
        sourceOrdinal: 1,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
      },
      end: {
        time: 200,
        sourceOrdinal: 2,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
      },
    });
    assert.equal(result.convertedXs[0], 100);
    assert.ok(Math.abs(result.convertedXs[1] - 250) < 1);
    assert.equal(JSON.stringify(result.attached[0].timeRange).includes("logical"), false);
    assert.equal(JSON.stringify(result.attached[0].timeRange).includes("order"), false);
  }
});

test("position creation tries the opposite screen direction near the right edge", () => {
  const result = placeDerivedPosition("position-long", {
    pointerX: 980,
    candidateForX: (x) => (x < 900
      ? { ...derivedPoint(50, 0, 100), order: 1, logical: 2 }
      : { ...derivedPoint(300, 0, 100), order: 3, logical: 4 }),
  });

  assert.equal(result.attached.length, 1);
  assert.equal(result.convertedXs[0], 980);
  assert.ok(Math.abs(result.convertedXs[1] - 830) < 1);
  assert.equal(result.convertedXs.length, 2);
  assert.equal(result.attached[0].timeRange.start.time, 50);
  assert.equal(result.attached[0].timeRange.end.time, 100);
});

test("position creation refuses a duplicate or unresolved second display row", () => {
  const result = placeDerivedPosition("position-long", {
    candidateForX: () => ({
      ...derivedPoint(100, 1, 100),
      order: 999,
      logical: 999,
    }),
  });

  assert.equal(result.consumed, true);
  assert.equal(result.attached.length, 0);
  assert.equal(result.primitivesRef.current.length, 0);
  assert.equal(result.persisted, 0);
});

test("derived positions may extend from materialized lineage into absolute future time", () => {
  const result = placeDerivedPosition("position-long", {
    pointerX: 700,
    adapterOverrides: { getTimeScaleWidth: () => 900 },
    candidateForX: (x) => (x > 800 && x < 900
      ? { time: 300.5, price: 100 }
      : null),
  });

  assert.equal(result.attached.length, 1);
  assert.ok(Math.abs(result.convertedXs[1] - 834.85) < 1);
  assert.ok(result.convertedXs[1] < 900);
  assert.equal(result.attached[0].timeRange.start.time, 100);
  assert.deepEqual(result.attached[0].timeRange.end, { time: 300.5 });
  assert.equal(JSON.stringify(result.attached[0].timeRange).includes("logical"), false);
  assert.equal(JSON.stringify(result.attached[0].timeRange).includes("order"), false);
});
