import assert from "node:assert/strict";
import test from "node:test";

import {
  exportDrawingDocument,
  importSavedDrawings,
} from "../drawingCodec.js";
import type { DrawingDocument } from "../drawingDocument.js";
import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  loadDrawings,
  normalizeSavedDrawingItem,
  saveSavedDrawings,
} from "../../drawingPersistence.js";
import type {
  FreehandStrokeV2,
  FreehandStrokeV3,
  SavedDrawing,
} from "../../drawingTypes.js";

function strokeSpan() {
  return {
    exact: {
      left: { time: 100, sourceOrdinal: 0 },
      right: { time: 100, sourceOrdinal: 1 },
    },
    fallback: {
      fromTime: 100,
      toTime: 200,
      leftRatio: 0.25,
      rightRatio: 0.75,
    },
  };
}

function strokeV2(): FreehandStrokeV2 {
  return {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [strokeSpan()],
    points: [
      { span: 0, ratio: 0, price: 100 },
      { span: 0, ratio: 1, price: 101 },
    ],
  };
}

function strokeV3(): FreehandStrokeV3 {
  return {
    version: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [strokeSpan()],
    points: [
      { span: 0, ratio: 0.5, price: 100 },
      { time: 1_700_000_180.5, price: 101 },
      { anchor: { time: 1_700_000_000, sourceOrdinal: 2 }, price: 102 },
    ],
  };
}

function allDrawingKinds(): SavedDrawing[] {
  const first = {
    time: 100.25,
    sourceOrdinal: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:10",
    price: 10.5,
  };
  const second = { time: 200.75, price: 20.25 };
  return [
    {
      type: "line",
      id: "line-1",
      lineType: "line-ray",
      dataPoints: [first, second],
      color: "#111",
      lineWidth: 2,
    },
    {
      type: "axis-line",
      id: "axis-1",
      axisLineType: "cross",
      dataPoint: first,
      color: "#222",
      lineWidth: 3,
    },
    {
      type: "angle-measure",
      id: "angle-1",
      dataPoints: [first, second],
      color: "#333",
      lineWidth: 4,
    },
    {
      type: "text",
      id: "text-1",
      dataPoint: first,
      text: "codec",
      color: "#444",
      fontSize: 16,
      fontFamily: "sans-serif",
      bold: true,
      italic: false,
      underline: true,
      align: "center",
      bgColor: null,
      borderColor: "#aaa",
      borderWidth: 1,
      widthPx: null,
      padding: 6,
    },
    {
      type: "fibonacci",
      id: "fib-1",
      dataPoints: [first, second],
      color: "#555",
      lineWidth: 2,
      levels: [{ level: 0.618, color: "#abcdef", enabled: true }],
      inverted: true,
    },
    {
      type: "position",
      id: "position-1",
      direction: "long",
      entryPrice: 10.5,
      tpPrice: 20.25,
      slPrice: null,
      timeRange: {
        start: {
          time: 100.25,
          sourceOrdinal: 3,
          sourceProjection: "renko",
          sourceProjectionConfig: "dataset-a:renko:10",
        },
        end: 200.75,
      },
      positionSize: 1_000,
      infoPanelOffset: { anchor: "left", x: 3.5, y: -2.25 },
    },
    {
      type: "shape",
      id: "shape-1",
      shapeType: "ellipse",
      dataPoints: [first, second],
      color: "#666",
      lineWidth: 5,
      fillColor: "#777",
      fillOpacity: 0.25,
      lineStyle: "dashed",
    },
    {
      type: "freehand",
      id: "freehand-1",
      stroke: strokeV3(),
      color: "#888",
      lineWidth: 6,
    },
    {
      type: "highlighter",
      id: "highlighter-1",
      dataPoints: [first, second],
      color: "#ff0",
      lineWidth: 12,
      opacity: 0.35,
      compositeOperation: "multiply",
      brushShape: "square",
    },
  ];
}

function normalized(drawings: readonly SavedDrawing[]): SavedDrawing[] {
  return drawings.map((drawing) => {
    const item = normalizeSavedDrawingItem(drawing);
    if (!item) throw new Error(`Invalid test fixture: ${drawing.type}`);
    return item;
  });
}

function memoryStorage(values: Map<string, string>): Storage {
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test("all nine SavedDrawing kinds round-trip through one canonical document", () => {
  const saved = allDrawingKinds();
  const document = importSavedDrawings("spot:BTCUSDT", saved);
  assert.ok(document);
  assert.equal(document.entities.size, 9);
  assert.deepEqual(document.zOrder, saved.map((drawing) => drawing.id));
  assert.deepEqual(exportDrawingDocument(document), normalized(saved));
});

test("legacy v1, stroke v2, and mixed-anchor v3 freehand payloads round-trip", () => {
  const payloads: SavedDrawing[] = [
    {
      type: "freehand",
      id: "v1",
      dataPoints: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
    },
    { type: "freehand", id: "v2", stroke: strokeV2() },
    { type: "freehand", id: "v3", stroke: strokeV3() },
  ];
  const document = importSavedDrawings("freehand-versions", payloads);
  assert.ok(document);
  const restored = exportDrawingDocument(document);
  assert.deepEqual(restored, normalized(payloads));
  assert.equal(restored?.[0]?.type, "freehand");
  assert.equal(restored?.[1]?.type === "freehand" && restored[1].stroke?.version, 2);
  assert.equal(restored?.[2]?.type === "freehand" && restored[2].stroke?.version, 3);
});

test("codec canonicalizes source anchors and discards projection-local order/logical", () => {
  const document = importSavedDrawings("canonical-anchor", [{
    type: "line",
    id: "canonical",
    dataPoints: [{
      time: 100,
      sourceOrdinal: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset-a:renko:10",
      order: 99,
      logical: 42,
      price: 10,
    }, { time: 200, price: 20 }],
  }]);
  assert.ok(document);
  const restored = exportDrawingDocument(document);
  assert.deepEqual(restored, [{
    type: "line",
    id: "canonical",
    dataPoints: [{
      time: 100,
      sourceOrdinal: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset-a:renko:10",
      price: 10,
    }, { time: 200, price: 20 }],
  }]);
});

test("codec rejects duplicate ids, corrupt entries, and count/freehand budgets as a unit", () => {
  assert.equal(importSavedDrawings("duplicates", [
    { type: "line", id: "same" },
    { type: "text", id: "same" },
  ]), null);
  assert.equal(importSavedDrawings("corrupt", [
    { type: "line", id: "good" },
    { type: "future-kind", id: "bad" },
  ]), null);
  assert.equal(importSavedDrawings("malformed-explicit-field", [{
    type: "text",
    id: "bad-text",
    dataPoint: { time: 1, price: 2 },
    text: 123,
  }]), null);
  assert.equal(importSavedDrawings("text-budget", [{
    type: "text",
    id: "huge-text",
    dataPoint: { time: 1, price: 2 },
    text: "x".repeat(MAX_DRAWING_STORAGE_CHARS + 1),
  }]), null);
  assert.equal(importSavedDrawings("count-budget", Array.from(
    { length: MAX_SAVED_DRAWINGS + 1 },
    (_, index) => ({ type: "line", id: `line-${index}` }),
  )), null);
  assert.equal(importSavedDrawings("point-budget", [{
    type: "freehand",
    id: "too-many-points",
    dataPoints: Array.from(
      { length: MAX_SAVED_FREEHAND_POINTS + 1 },
      () => ({ time: 100, price: 1 }),
    ),
  }]), null);

  const valid = importSavedDrawings("corrupt-export", [
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ]);
  assert.ok(valid);
  assert.equal(exportDrawingDocument({
    ...valid,
    zOrder: ["first", "first"],
  } as DrawingDocument), null);
});

test("missing legacy ids receive deterministic collision-free ids", () => {
  const document = importSavedDrawings("generated-ids", [
    { type: "line", id: "ln_1" },
    { type: "line" },
    { type: "freehand", dataPoints: [{ time: 1, price: 1 }, { time: 2, price: 2 }] },
  ]);
  assert.ok(document);
  assert.deepEqual(document.zOrder, ["ln_1", "ln_2", "fh_1"]);
});

test("persistence directly saves codec exports in the legacy storage format", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = memoryStorage(values);
  try {
    const document = importSavedDrawings("spot:BTCUSDT", allDrawingKinds());
    assert.ok(document);
    const exported = exportDrawingDocument(document);
    assert.ok(exported);
    assert.equal(saveSavedDrawings("spot:BTCUSDT", exported), true);
    assert.deepEqual(loadDrawings("spot:BTCUSDT"), exported);
    assert.deepEqual(JSON.parse(values.get("candlescope-drawings-spot:BTCUSDT") ?? "null"), exported);
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});
