import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  MAX_SAVED_FREEHAND_SPANS,
  hasSavedDrawings,
  loadDrawings,
  saveDrawings,
  serializeDataPoint,
  serializeHorizontalAnchor,
} from "../drawingPersistence.js";
import {
  createFreehandPrimitive,
  createPrimitiveFromSavedDrawing,
} from "../drawingPrimitiveFactory.js";
import {
  MAX_FREEHAND_STROKE_POINTS,
  MAX_FREEHAND_STROKE_SPANS,
  MAX_LEGACY_FREEHAND_POINTS,
  normalizeFreehandStrokeV2,
} from "../freehandStrokeModel.js";
import { isRecord } from "../drawingContracts.js";
import type {
  FreehandKind,
  FreehandStrokeV2,
  FreehandStrokeV3,
  PersistableDrawingPrimitive,
  PersistableFreehandPrimitive,
  PersistableLinePrimitive,
  SavedDrawing,
  SavedFreehandDrawing,
  SavedHighlighterDrawing,
  SavedLineDrawing,
  SavedPositionDrawing,
} from "../drawingTypes.js";
import { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import {
  malformedFixture,
  mustBeDefined,
} from "../../../test/testHelpers.js";

function freehandStrokeV2(): FreehandStrokeV2 {
  return malformedFixture<FreehandStrokeV2>({
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [{
      exact: {
        left: { time: 200, sourceOrdinal: 0, order: 1 },
        right: { time: 200, sourceOrdinal: 1, logical: 2 },
      },
      fallback: {
        fromTime: 100,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 100, logical: 1 },
      { span: 0, ratio: 1, price: 101, order: 2 },
    ],
    logical: 99,
  });
}

function freehandStrokeV3(): FreehandStrokeV3 {
  const v2 = freehandStrokeV2();
  return malformedFixture<FreehandStrokeV3>({
    version: 3,
    sourceProjection: v2.sourceProjection,
    sourceProjectionConfig: v2.sourceProjectionConfig,
    spans: v2.spans.map((span) => ({
      ...span,
      order: 10,
      logical: 20,
      horizon: 300,
      interval: 60,
      offset: 2,
      sourceTimeHorizon: 300,
      sourceInterval: "1m",
      sourceIntervalSeconds: 60,
      barOffsetFromLast: 2,
      cellOffset: 2,
    })),
    points: [
      {
        span: 0,
        ratio: 0,
        price: 100,
        order: 1,
        logical: 2,
        horizon: 300,
        interval: 60,
        offset: 3,
        sourceTimeHorizon: 300,
        sourceInterval: "1m",
        barOffsetFromLast: 3,
      },
      {
        time: 1_700_000_180.5,
        price: 101,
        order: 4,
        logical: 5,
        horizon: 300,
        interval: 60,
        offset: 6,
        capturedHorizon: 300,
        capturedInterval: "1m",
        cellOffset: 6,
      },
      {
        anchor: { time: 1_700_000_000, sourceOrdinal: 2, order: 9 },
        price: 102,
        logical: 7,
      },
    ],
    order: 7,
    logical: 8,
    horizon: 300,
    interval: 60,
    offset: 9,
    sourceTimeHorizon: 300,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
  });
}

function recursiveKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    recursiveKeys(child, keys);
  }
  return keys;
}

function drawingStorageKey(symbol: string): string {
  return `candlescope-drawings-${symbol}`;
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

function mustSavedLine(value: SavedDrawing | undefined): SavedLineDrawing {
  if (value?.type !== "line") throw new Error("Expected a saved line drawing");
  return value;
}

function mustSavedPosition(value: SavedDrawing | undefined): SavedPositionDrawing {
  if (value?.type !== "position") throw new Error("Expected a saved position drawing");
  return value;
}

function mustSavedFreehand(
  value: SavedDrawing | undefined,
): SavedFreehandDrawing | SavedHighlighterDrawing {
  if (value?.type !== "freehand" && value?.type !== "highlighter") {
    throw new Error("Expected a saved freehand drawing");
  }
  return value;
}

function mustSavedHighlighter(value: SavedDrawing | undefined): SavedHighlighterDrawing {
  if (value?.type !== "highlighter") throw new Error("Expected a saved highlighter drawing");
  return value;
}

function mustFreehandPrimitive(value: unknown): FreehandDrawingPrimitive {
  if (!(value instanceof FreehandDrawingPrimitive)) {
    throw new Error("Expected a freehand primitive");
  }
  return value;
}

function withMemoryLocalStorage<T>(run: (values: Map<string, string>) => T): T {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  try {
    return run(values);
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
}

test("restoring a persisted drawing reserves its numeric id suffix", () => {
  const restored = createPrimitiveFromSavedDrawing({
    type: "freehand",
    id: "fh_1000000",
    stroke: freehandStrokeV2(),
  });
  assert.equal(mustBeDefined(restored).id, "fh_1000000");

  const created = createFreehandPrimitive({
    tool: "pen",
    dataPoint: { time: 100, price: 10 },
    color: "#fff",
    lineWidth: 2,
  });
  assert.ok(Number(created.id.split("_").at(-1)) > 1_000_000);
});

function linePrimitive(id = "line"): PersistableLinePrimitive {
  return {
    _id: id,
    _lineType: "line-segment",
    _dataPoints: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
    _color: "#fff",
    _lineWidth: 2,
  };
}

function strokePrimitive(
  stroke: unknown,
  id = "stroke",
  type: FreehandKind = "freehand",
): PersistableFreehandPrimitive {
  return {
    _id: id,
    _type: type,
    _stroke: stroke,
    _dataPoints: [],
    _color: "#fff",
    _lineWidth: 2,
    ...(type === "highlighter" ? {
      _opacity: 0.35,
      _compositeOperation: "multiply",
      _brushShape: "square",
    } : {}),
  };
}

test("serializeDataPoint persists canonical derived lineage but not order or logical", () => {
  assert.deepEqual(serializeDataPoint({
    time: 1_700_000_000,
    logical: 42,
    order: 9,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{\"reversalAmount\":3}",
    price: 100,
  }), {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{\"reversalAmount\":3}",
    price: 100,
  });
});

test("serializeDataPoint preserves legacy time-axis logical fallback", () => {
  assert.deepEqual(serializeDataPoint({
    time: 100,
    logical: 12.5,
    order: 99,
    price: 5,
  }), {
    time: 100,
    logical: 12.5,
    price: 5,
  });
});

test("absolute future source anchors round-trip without projection-local fields", () => {
  withMemoryLocalStorage((values) => {
    saveDrawings("derived-future", [{
      _id: "future-line",
      _lineType: "line-segment",
      _dataPoints: [
        { time: 1_700_000_180.5, price: 100 },
        { time: 1_700_000_360.25, price: 101 },
      ],
      _color: "#fff",
      _lineWidth: 2,
    }]);

    const raw = values.get(drawingStorageKey("derived-future"));
    assert.ok(raw);
    assert.equal(recursiveKeys(JSON.parse(raw)).has("order"), false);
    assert.equal(recursiveKeys(JSON.parse(raw)).has("logical"), false);
    assert.deepEqual(mustSavedLine(loadDrawings("derived-future")[0]).dataPoints, [
      { time: 1_700_000_180.5, price: 100 },
      { time: 1_700_000_360.25, price: 101 },
    ]);
  });
});

test("serializeHorizontalAnchor safely round-trips position source metadata", () => {
  assert.deepEqual(serializeHorizontalAnchor({
    time: 200,
    sourceOrdinal: 0,
    sourceProjection: "line-break",
    sourceProjectionConfig: "derived-ordinal:line-break:{\"numberOfLines\":3}",
    logical: 8,
    order: 3,
  }), {
    time: 200,
    sourceOrdinal: 0,
    sourceProjection: "line-break",
    sourceProjectionConfig: "derived-ordinal:line-break:{\"numberOfLines\":3}",
  });
});

test("persistence rejects unsafe source metadata", () => {
  assert.deepEqual(serializeDataPoint({
    time: 300,
    sourceOrdinal: -1,
    sourceProjection: "../renko",
    sourceProjectionConfig: "renko\nunsafe",
    price: 10,
  }), {
    time: 300,
    price: 10,
  });
});

test("save and load round-trip canonical source metadata without ordinal order", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = memoryStorage(values);

  try {
    saveDrawings("derived-roundtrip", [malformedFixture<PersistableLinePrimitive>({
      _id: "line-1",
      _lineType: "line-segment",
      _dataPoints: [{
        time: 1_700_000_000,
        sourceOrdinal: 4,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        order: 88,
        logical: 99,
        price: 100,
      }, {
        time: 1_700_000_060,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        price: 101,
      }],
      _color: "#fff",
      _lineWidth: 2,
    })]);

    assert.deepEqual(loadDrawings("derived-roundtrip"), [{
      type: "line",
      id: "line-1",
      lineType: "line-segment",
      dataPoints: [{
        time: 1_700_000_000,
        sourceOrdinal: 4,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        price: 100,
      }, {
        time: 1_700_000_060,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        price: 101,
      }],
      color: "#fff",
      lineWidth: 2,
    }]);
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});

test("position persistence keeps both canonical endpoints across projection switches", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = memoryStorage(values);

  try {
    saveDrawings("derived-position", [malformedFixture<PersistableDrawingPrimitive>({
      _id: "position-1",
      _type: "position",
      _direction: "long",
      _entryPrice: 100,
      _tpPrice: 110,
      _slPrice: 95,
      _timeRange: {
        start: {
          time: 100,
          sourceOrdinal: 1,
          sourceProjection: "renko",
          sourceProjectionConfig: "dataset-a:renko:10",
          order: 3,
          logical: 30,
        },
        end: {
          time: 200,
          sourceOrdinal: 0,
          sourceProjection: "renko",
          sourceProjectionConfig: "dataset-a:renko:10",
          order: 8,
          logical: 80,
        },
      },
      _positionSize: 1000,
    })]);

    const saved = mustSavedPosition(loadDrawings("derived-position")[0]);
    assert.deepEqual(saved.timeRange, {
      start: {
        time: 100,
        sourceOrdinal: 1,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:10",
      },
      end: {
        time: 200,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:10",
      },
    });
    assert.equal(JSON.stringify(saved.timeRange).includes("order"), false);
    assert.equal(JSON.stringify(saved.timeRange).includes("logical"), false);
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});

test("freehand v2 persistence round-trips an allowlisted stroke without local axis fields", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = memoryStorage(values);

  try {
    saveDrawings("derived-freehand-v2", [{
      _id: "freehand-v2",
      _type: "freehand",
      _stroke: freehandStrokeV2(),
      _dataPoints: [{ time: 999, logical: 999, price: 999 }],
      _color: "#fff",
      _lineWidth: 2,
    }]);

    const saved = mustSavedFreehand(loadDrawings("derived-freehand-v2")[0]);
    const savedStroke = mustBeDefined(saved.stroke);
    assert.equal(Object.hasOwn(saved, "stroke"), true);
    assert.equal(Object.hasOwn(saved, "dataPoints"), false);
    assert.deepEqual(savedStroke.points, [
      { span: 0, ratio: 0, price: 100 },
      { span: 0, ratio: 1, price: 101 },
    ]);
    const keys = recursiveKeys(savedStroke);
    assert.equal(keys.has("order"), false);
    assert.equal(keys.has("logical"), false);

    const restored = mustFreehandPrimitive(createPrimitiveFromSavedDrawing(saved));
    assert.deepEqual(restored.stroke, savedStroke);
    assert.deepEqual(restored.dataPoints, []);
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});

test("freehand v3 persistence and factory round-trip lineage plus absolute-time points", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "derived-freehand-v3";
    saveDrawings(symbol, [
      strokePrimitive(freehandStrokeV3(), "freehand-v3"),
      strokePrimitive(freehandStrokeV3(), "highlighter-v3", "highlighter"),
    ]);

    const raw = values.get(drawingStorageKey(symbol));
    assert.ok(raw);
    const rawDrawings: unknown = JSON.parse(raw);
    if (!Array.isArray(rawDrawings)) throw new Error("Expected serialized drawings array");
    assert.equal(rawDrawings.length, 2);
    for (const item of rawDrawings) {
      if (!isRecord(item) || !isRecord(item.stroke)) {
        throw new Error("Expected serialized freehand stroke object");
      }
      assert.equal(item.stroke.version, 3);
      assert.deepEqual(item.stroke.points, [
        { span: 0, ratio: 0, price: 100 },
        { time: 1_700_000_180.5, price: 101 },
        { anchor: { time: 1_700_000_000, sourceOrdinal: 2 }, price: 102 },
      ]);
      const keys = recursiveKeys(item.stroke);
      for (const forbidden of [
        "barOffsetFromLast",
        "capturedHorizon",
        "capturedInterval",
        "cellOffset",
        "horizon",
        "interval",
        "logical",
        "offset",
        "order",
        "sourceInterval",
        "sourceIntervalSeconds",
        "sourceTimeHorizon",
      ]) {
        assert.equal(keys.has(forbidden), false, forbidden);
      }
    }

    const loaded = loadDrawings(symbol);
    assert.equal(loaded.length, 2);
    assert.equal(mustBeDefined(loaded[0]).type, "freehand");
    assert.equal(mustBeDefined(loaded[1]).type, "highlighter");
    for (const item of loaded) {
      const freehandItem = mustSavedFreehand(item);
      const restored = mustFreehandPrimitive(createPrimitiveFromSavedDrawing(freehandItem));
      assert.deepEqual(restored.stroke, freehandItem.stroke);
      assert.deepEqual(restored.dataPoints, []);
    }
  });
});

test("freehand load fails closed for mixed, null, unknown, or malformed stroke payloads", () => {
  const valid = freehandStrokeV2();
  assert.equal(createPrimitiveFromSavedDrawing(malformedFixture<SavedDrawing>({
    type: "freehand",
    stroke: valid,
    dataPoints: [],
  })), null);
  assert.equal(createPrimitiveFromSavedDrawing(
    malformedFixture<SavedDrawing>({ type: "freehand", stroke: null }),
  ), null);
  assert.equal(createPrimitiveFromSavedDrawing(malformedFixture<SavedDrawing>({
    type: "freehand",
    stroke: { ...valid, version: 4 },
  })), null);
  const mixedV3 = malformedFixture<FreehandStrokeV3>({
    ...freehandStrokeV3(),
    points: freehandStrokeV3().points.map((point, index) => (
      index === 0 ? { ...point, time: 100 } : point
    )),
  });
  assert.equal(createPrimitiveFromSavedDrawing(malformedFixture<SavedDrawing>({
    type: "freehand",
    stroke: mixedV3,
  })), null);
  assert.equal(createPrimitiveFromSavedDrawing({
    type: "freehand",
    stroke: {
      ...valid,
      points: [{ span: 0, ratio: 0, price: 100 }],
    },
  }), null);
  assert.equal(createPrimitiveFromSavedDrawing(malformedFixture<SavedDrawing>({
    type: "line",
    stroke: valid,
    dataPoints: [],
  })), null);
  assert.equal(createPrimitiveFromSavedDrawing(malformedFixture<SavedDrawing>({
    type: "freehand",
    dataPoints: {},
  })), null);
  assert.equal(createPrimitiveFromSavedDrawing(malformedFixture<SavedDrawing>({
    type: "highlighter",
    dataPoints: [{ time: 100, price: null }],
  })), null);
  assert.equal(createPrimitiveFromSavedDrawing({
    type: "freehand",
    dataPoints: Array.from(
      { length: MAX_LEGACY_FREEHAND_POINTS + 1 },
      () => ({ time: 100, price: 1 }),
    ),
  }), null);

  const legacy = createPrimitiveFromSavedDrawing({
    type: "freehand",
    dataPoints: [
      { time: 100, logical: 1.5, order: 9, price: 1 },
      { time: 200, order: 10, price: 2 },
    ],
  });
  const legacyPrimitive = mustFreehandPrimitive(legacy);
  assert.equal(legacyPrimitive.stroke, null);
  assert.deepEqual(legacyPrimitive.dataPoints, [
    { time: 100, logical: 1.5, price: 1 },
    { time: 200, price: 2 },
  ]);
});

test("load and hasSavedDrawings fail closed for oversized or over-count payloads", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "bounded-load";
    const key = drawingStorageKey(symbol);

    const exactRaw = JSON.stringify([{ type: "line", id: "edge" }]);
    values.set(key, exactRaw.padEnd(MAX_DRAWING_STORAGE_CHARS, " "));
    assert.equal(loadDrawings(symbol).length, 1);
    assert.equal(hasSavedDrawings(symbol), true);

    values.set(key, "x".repeat(MAX_DRAWING_STORAGE_CHARS + 1));
    assert.deepEqual(loadDrawings(symbol), []);
    assert.equal(hasSavedDrawings(symbol), false);

    values.set(key, JSON.stringify(Array.from(
      { length: MAX_SAVED_DRAWINGS },
      (_, index) => ({ type: "line", id: `line-${index}` }),
    )));
    assert.equal(loadDrawings(symbol).length, MAX_SAVED_DRAWINGS);
    assert.equal(hasSavedDrawings(symbol), true);

    values.set(key, JSON.stringify(Array.from(
      { length: MAX_SAVED_DRAWINGS + 1 },
      (_, index) => ({ type: "line", id: `line-${index}` }),
    )));
    assert.deepEqual(loadDrawings(symbol), []);
    assert.equal(hasSavedDrawings(symbol), false);
  });
});

test("load filters invalid entries and restores canonical v1 and v2 highlighter payloads", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "mixed-load";
    const key = drawingStorageKey(symbol);
    values.set(key, JSON.stringify([
      { type: "freehand", stroke: null },
      { type: "unknown" },
      {
        type: "freehand",
        id: "legacy",
        dataPoints: [
          { time: 100, logical: 1.5, order: 9, price: 1 },
          { time: 200, order: 10, price: 2 },
        ],
      },
      {
        type: "highlighter",
        id: "highlighter-v2",
        stroke: freehandStrokeV2(),
        opacity: 0.35,
        compositeOperation: "multiply",
        brushShape: "square",
      },
    ]));

    const drawings = loadDrawings(symbol);
    assert.equal(drawings.length, 2);
    const legacyDrawing = mustSavedFreehand(drawings[0]);
    const highlighterDrawing = mustSavedFreehand(drawings[1]);
    assert.deepEqual(legacyDrawing.dataPoints, [
      { time: 100, logical: 1.5, price: 1 },
      { time: 200, price: 2 },
    ]);
    assert.equal(Object.hasOwn(legacyDrawing, "stroke"), false);
    assert.equal(highlighterDrawing.type, "highlighter");
    assert.equal(Object.hasOwn(highlighterDrawing, "dataPoints"), false);
    assert.equal(recursiveKeys(highlighterDrawing.stroke).has("order"), false);
    assert.equal(recursiveKeys(highlighterDrawing.stroke).has("logical"), false);
    assert.equal(hasSavedDrawings(symbol), true);

    values.set(key, JSON.stringify([
      { type: "freehand", stroke: null },
      { type: "highlighter", dataPoints: {} },
      { type: "unknown" },
    ]));
    assert.deepEqual(loadDrawings(symbol), []);
    assert.equal(hasSavedDrawings(symbol), false);
  });
});

test("drawing schema fixtures reject corrupt anchors and preserve compatible anchor forms", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "anchor-schema-fixtures";
    values.set(drawingStorageKey(symbol), JSON.stringify([
      {
        type: "line",
        id: "corrupt-anchor",
        dataPoints: [{ time: "not-a-time", price: 1 }, { time: 200, price: 2 }],
      },
      { type: "future-drawing-kind", id: "unknown-kind" },
      {
        type: "line",
        id: "legacy-logical",
        dataPoints: [
          { time: 100, logical: 1.5, order: 7, price: 1 },
          { time: 200, logical: 2.5, order: 8, price: 2 },
        ],
      },
      {
        type: "line",
        id: "synthetic-lineage",
        dataPoints: [
          {
            time: 300,
            sourceOrdinal: 4,
            sourceProjection: "renko",
            sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
            logical: 9,
            order: 11,
            price: 3,
          },
          { time: 400, price: 4 },
        ],
      },
    ]));

    const drawings = loadDrawings(symbol);
    assert.deepEqual(drawings.map((drawing) => drawing.id), [
      "legacy-logical",
      "synthetic-lineage",
    ]);
    assert.deepEqual(mustSavedLine(drawings[0]).dataPoints?.[0], {
      time: 100,
      logical: 1.5,
      price: 1,
    });
    assert.deepEqual(mustSavedLine(drawings[1]).dataPoints?.[0], {
      time: 300,
      sourceOrdinal: 4,
      sourceProjection: "renko",
      sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
      price: 3,
    });
    assert.equal(recursiveKeys(drawings).has("order"), false);
  });
});

test("load rejects aggregate legacy point budgets above the symbol limit", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "aggregate-points";
    const point = { time: 100, price: 1 };
    const drawings = Array.from({ length: 8 }, (_, index) => ({
      type: "freehand",
      id: `legacy-${index}`,
      dataPoints: Array(MAX_FREEHAND_STROKE_POINTS - 1).fill(point),
    }));
    drawings.push({
      type: "freehand",
      id: "legacy-edge",
      dataPoints: Array(8).fill(point),
    });
    assert.equal(
      8 * (MAX_FREEHAND_STROKE_POINTS - 1) + 8,
      MAX_SAVED_FREEHAND_POINTS,
    );
    const exactRaw = JSON.stringify(drawings);
    assert.ok(exactRaw.length < MAX_DRAWING_STORAGE_CHARS);
    values.set(drawingStorageKey(symbol), exactRaw);
    assert.equal(loadDrawings(symbol).length, drawings.length);
    assert.equal(hasSavedDrawings(symbol), true);

    mustBeDefined(drawings.at(-1)).dataPoints.push(point);
    const raw = JSON.stringify(drawings);
    assert.ok(raw.length < MAX_DRAWING_STORAGE_CHARS);
    values.set(drawingStorageKey(symbol), raw);

    assert.deepEqual(loadDrawings(symbol), []);
    assert.equal(hasSavedDrawings(symbol), false);
  });
});

test("declared aggregate budgets reject malformed freehand arrays before item filtering", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "malformed-aggregate";
    const malformed = Array.from({ length: 9 }, (_, index) => ({
      type: index % 2 === 0 ? "freehand" : "highlighter",
      dataPoints: Array(MAX_FREEHAND_STROKE_POINTS - 1).fill(0),
    }));
    malformed.push({
      type: "freehand",
      dataPoints: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
    });
    const raw = JSON.stringify(malformed);
    assert.ok(raw.length < MAX_DRAWING_STORAGE_CHARS);
    values.set(drawingStorageKey(symbol), raw);

    assert.deepEqual(loadDrawings(symbol), []);
    assert.equal(hasSavedDrawings(symbol), false);
  });
});

test("save is atomic for unknown primitives, invalid strokes, and drawing-count overflow", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "atomic-save";
    const key = drawingStorageKey(symbol);
    const previous = "previous-valid-snapshot";

    values.set(key, previous);
    saveDrawings(symbol, [
      linePrimitive(),
      malformedFixture<PersistableDrawingPrimitive>({ _id: "unknown", _type: "future" }),
    ]);
    assert.equal(values.get(key), previous);

    saveDrawings(symbol, [linePrimitive(), malformedFixture<PersistableDrawingPrimitive>({
      _id: "invalid-stroke",
      _type: "freehand",
      _stroke: { version: 3 },
      _dataPoints: [{ time: 100, price: 1 }],
    })]);
    assert.equal(values.get(key), previous);

    saveDrawings(symbol, [linePrimitive(), {
      ...strokePrimitive({ version: 3 }, "invalid-highlighter", "highlighter"),
      _dataPoints: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
    }]);
    assert.equal(values.get(key), previous);

    saveDrawings(symbol, Array.from(
      { length: MAX_SAVED_DRAWINGS + 1 },
      (_, index) => linePrimitive(`line-${index}`),
    ));
    assert.equal(values.get(key), previous);
  });
});

test("save preserves the old snapshot when aggregate span or raw-size caps are exceeded", () => {
  withMemoryLocalStorage((values) => {
    const symbol = "atomic-budgets";
    const key = drawingStorageKey(symbol);
    const previous = "previous-valid-snapshot";
    values.set(key, previous);

    const base = freehandStrokeV2();
    const maxSpanStroke = normalizeFreehandStrokeV2({
      ...base,
      spans: Array(MAX_FREEHAND_STROKE_SPANS).fill(base.spans[0]),
    });
    const singleSpanStroke = normalizeFreehandStrokeV2(base);
    assert.ok(maxSpanStroke);
    assert.ok(singleSpanStroke);
    assert.equal(8 * MAX_FREEHAND_STROKE_SPANS, MAX_SAVED_FREEHAND_SPANS);
    saveDrawings(symbol, [
      ...Array.from(
        { length: 8 },
        (_, index) => strokePrimitive(maxSpanStroke, `stroke-${index}`),
      ),
      strokePrimitive(singleSpanStroke, "stroke-overflow"),
    ]);
    assert.equal(values.get(key), previous);

    saveDrawings(symbol, [malformedFixture<PersistableDrawingPrimitive>({
      _id: "huge-text",
      _text: "x".repeat(MAX_DRAWING_STORAGE_CHARS),
      _dataPoint: { time: 100, price: 1 },
      _color: "#fff",
      _fontSize: 14,
    })]);
    assert.equal(values.get(key), previous);
  });
});

test("highlighter v2 save and load keeps stroke mode and style fields", () => {
  withMemoryLocalStorage(() => {
    const symbol = "highlighter-v2";
    saveDrawings(symbol, [strokePrimitive(
      freehandStrokeV2(),
      "highlighter-v2",
      "highlighter",
    )]);

    const drawings = loadDrawings(symbol);
    assert.equal(drawings.length, 1);
    const highlighter = mustSavedHighlighter(drawings[0]);
    assert.equal(Object.hasOwn(highlighter, "stroke"), true);
    assert.equal(Object.hasOwn(highlighter, "dataPoints"), false);
    assert.equal(highlighter.opacity, 0.35);
    assert.equal(highlighter.compositeOperation, "multiply");
    assert.equal(highlighter.brushShape, "square");
  });
});
