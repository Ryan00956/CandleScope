import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../../core/drawingCodec.js";
import type { DrawingDocument, DrawingEntity } from "../../core/drawingDocument.js";
import type {
  FreehandStrokeV2,
  FreehandStrokeV3,
  SavedDrawing,
} from "../../drawingTypes.js";
import {
  createLegacyDrawingImporter,
  legacyDrawingStorageKey,
} from "../legacyDrawingImporter.js";

function memoryStorage(
  values: Map<string, string>,
  hooks: Readonly<{ onGet?: () => void; onSet?: () => void }> = {},
) {
  return {
    getItem(key: string) {
      hooks.onGet?.();
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      hooks.onSet?.();
      values.set(key, value);
    },
  };
}

function line(id: string, offset = 0): SavedDrawing {
  return {
    type: "line",
    id,
    lineType: "line-segment",
    dataPoints: [
      { time: 100 + offset, price: 1 + offset },
      { time: 200 + offset, price: 2 + offset },
    ],
    color: "#fff",
    lineWidth: 2,
  };
}

function countedDocument(source: DrawingDocument, onGet: () => void): DrawingDocument {
  return {
    ...source,
    entities: {
      size: source.entities.size,
      get(id: string) {
        onGet();
        return source.entities.get(id);
      },
    } as ReadonlyMap<string, DrawingEntity>,
  };
}

function span() {
  return {
    exact: {
      left: { time: 100, sourceOrdinal: 0 },
      right: { time: 100, sourceOrdinal: 1 },
    },
    fallback: { fromTime: 100, toTime: 200, leftRatio: 0.25, rightRatio: 0.75 },
  };
}

function strokeV2(): FreehandStrokeV2 {
  return {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [span()],
    points: [{ span: 0, ratio: 0, price: 1 }, { span: 0, ratio: 1, price: 2 }],
  };
}

function strokeV3(): FreehandStrokeV3 {
  return {
    version: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [span()],
    points: [
      { span: 0, ratio: 0.5, price: 1 },
      { time: 300, price: 2 },
      { anchor: { time: 400, sourceOrdinal: 2 }, price: 3 },
    ],
  };
}

test("legacy importer reads v1/v2/v3 strictly without rewriting source bytes", () => {
  const scopeKey = "legacy-versions";
  const payload: SavedDrawing[] = [
    {
      type: "freehand",
      id: "v1",
      dataPoints: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
    },
    { type: "freehand", id: "v2", stroke: strokeV2() },
    { type: "freehand", id: "v3", stroke: strokeV3() },
  ];
  const raw = JSON.stringify(payload);
  const values = new Map([[legacyDrawingStorageKey(scopeKey), raw]]);
  let writes = 0;
  const importer = createLegacyDrawingImporter({
    storage: memoryStorage(values, { onSet: () => { writes += 1; } }),
  });

  const result = importer.load(scopeKey);
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" && result.document.entities.size, 3);
  assert.equal(values.get(legacyDrawingStorageKey(scopeKey)), raw);
  assert.equal(writes, 0, "a pure load must not migrate or normalize legacy bytes");
});

test("legacy importer distinguishes missing, invalid, and unavailable", () => {
  const values = new Map<string, string>();
  const importer = createLegacyDrawingImporter({ storage: memoryStorage(values) });
  assert.equal(importer.load("missing").status, "missing");

  values.set(legacyDrawingStorageKey("invalid"), JSON.stringify([
    { type: "line", id: "ok", dataPoints: [{ time: 1, price: 1 }, { time: 2, price: 2 }] },
    { type: "future-kind", id: "bad" },
  ]));
  assert.equal(importer.load("invalid").status, "invalid");

  const unavailable = createLegacyDrawingImporter({
    storage: {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
    },
  });
  assert.equal(unavailable.load("scope").status, "unavailable");
});

test("legacy async encode builds a 512-entity snapshot in bounded chunks", async () => {
  const scopeKey = "legacy-encode-512";
  const drawings = Array.from({ length: 512 }, (_, index) => line(`line-${index}`, index));
  const source = importSavedDrawings(scopeKey, drawings);
  assert.ok(source);
  const values = new Map<string, string>();
  let entityGets = 0;
  let getsAtLastYield = 0;
  const chunkSizes: number[] = [];
  let clock = 0;
  const importer = createLegacyDrawingImporter({
    storage: memoryStorage(values),
    monotonicNow: () => {
      clock += 0.25;
      return clock;
    },
    encodeYield: async () => {
      chunkSizes.push(entityGets - getsAtLastYield);
      getsAtLastYield = entityGets;
    },
    encodeChunkBudgetMs: 8,
    encodeMaxEntitiesPerChunk: 8,
  });

  const encoded = await importer.encodeAsync(countedDocument(source, () => { entityGets += 1; }));
  assert.ok(encoded);
  chunkSizes.push(entityGets - getsAtLastYield);

  assert.equal(entityGets, 512);
  assert.equal(encoded.encodeMetrics.entityCount, 512);
  assert.equal(encoded.encodeMetrics.chunkCount, 64);
  assert.equal(encoded.encodeMetrics.serializedLength, encoded.raw.length);
  assert.ok(encoded.encodeMetrics.maxChunkDurationMs < 8);
  assert.ok(chunkSizes.every((count) => count > 0 && count <= 8));
  assert.equal(encoded.raw, JSON.stringify(encoded.savedDrawings));
  assert.deepEqual(JSON.parse(encoded.raw), encoded.savedDrawings);

  const written = importer.write(encoded);
  assert.equal(written.ok, true);
  assert.equal(values.get(legacyDrawingStorageKey(scopeKey)), encoded.raw);
});

test("legacy compatibility write is single-shot and preserves old bytes on quota failure", () => {
  const scopeKey = "legacy-atomic";
  const oldBytes = "old-valid-bytes";
  const values = new Map([[legacyDrawingStorageKey(scopeKey), oldBytes]]);
  const document = importSavedDrawings(scopeKey, [{
    type: "line",
    id: "line",
    lineType: "line-segment",
    dataPoints: [{ time: 1, price: 1 }, { time: 2, price: 2 }],
  }]);
  assert.ok(document);

  const encoder = createLegacyDrawingImporter({ storage: memoryStorage(values) });
  const encoded = encoder.encode(document);
  assert.ok(encoded);
  const failing = createLegacyDrawingImporter({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem() { throw new Error("quota exceeded"); },
    },
  });
  const result = failing.write(encoded);
  assert.equal(result.ok, false);
  assert.equal(values.get(legacyDrawingStorageKey(scopeKey)), oldBytes);
});
