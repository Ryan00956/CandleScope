import assert from "node:assert/strict";
import test from "node:test";

import {
  commitTwoPointDrawing,
  placePositionDrawing,
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

test("derived position candidates stay inside materialized display-row coordinates", () => {
  const rows = [
    { time: { order: 0, sourceTime: 50, sourceOrdinal: 0 } },
    { time: { order: 5, sourceTime: 200, sourceOrdinal: 0 } },
  ];
  const result = placeDerivedPosition("position-long", {
    pointerX: 800,
    adapterOverrides: {
      usesOrdinalTime: () => true,
      getSeriesData: () => rows,
      timeToCoordinate: (time) => (time.order === 0 ? 100 : 850),
    },
    candidateForX: (x) => (x < 750
      ? derivedPoint(50, 0, 100)
      : derivedPoint(200, 0, 100)),
  });

  assert.equal(result.attached.length, 1);
  assert.ok(result.convertedXs.slice(1).every((x) => x >= 100 && x <= 850));
  assert.ok(Math.abs(result.convertedXs[1] - 687.5) < 1);
  assert.equal(result.attached[0].timeRange.start.time, 50);
  assert.equal(result.attached[0].timeRange.end.time, 100);
});
