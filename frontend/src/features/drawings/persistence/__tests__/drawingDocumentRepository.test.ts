import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../../core/drawingCodec.js";
import {
  createDrawingDocument,
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type { DrawingDocument } from "../../core/drawingDocument.js";
import type { SavedDrawing } from "../../drawingTypes.js";
import {
  createDrawingDocumentRepository,
  decodeDrawingDocumentRecord,
  drawingDocumentManifestKey,
  encodeDrawingDocumentRecord,
} from "../drawingDocumentRepository.js";
import type {
  DrawingDocumentRecordV1,
  DrawingDocumentRepositoryBackend,
} from "../drawingDocumentRepository.js";
import {
  createLegacyDrawingImporter,
  legacyDrawingStorageKey,
} from "../legacyDrawingImporter.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryBackend implements DrawingDocumentRepositoryBackend {
  readonly records = new Map<string, unknown>();
  getCount = 0;
  putCount = 0;
  getError: Error | null = null;
  putError: Error | null = null;

  async get(scopeKey: string): Promise<unknown | undefined> {
    this.getCount += 1;
    if (this.getError) throw this.getError;
    const value = this.records.get(scopeKey);
    return value === undefined ? undefined : clone(value);
  }

  async put(record: DrawingDocumentRecordV1): Promise<void> {
    this.putCount += 1;
    if (this.putError) throw this.putError;
    this.records.set(record.scopeKey, clone(record));
  }
}

function memoryStorage(values: Map<string, string>, onSet?: () => void) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      onSet?.();
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

function document(scopeKey: string, drawings: readonly SavedDrawing[] = [line("line")]): DrawingDocument {
  const result = importSavedDrawings(scopeKey, drawings);
  if (!result) throw new Error("invalid test drawing document");
  return result;
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
    } as ReadonlyMap<string, ReturnType<typeof createDrawingEntity>>,
  };
}

test("strict v2 record codec preserves revision and ordered entities", () => {
  const source = document("codec", [line("back", 0), line("front", 10)]);
  const record = encodeDrawingDocumentRecord(source, 1234);
  assert.ok(record);
  assert.deepEqual(record.entities.map((entity) => entity.id), ["back", "front"]);
  const restored = decodeDrawingDocumentRecord(record, "codec");
  assert.ok(restored);
  assert.equal(restored.documentRevision, source.documentRevision);
  assert.deepEqual(restored.zOrder, source.zOrder);

  assert.equal(decodeDrawingDocumentRecord({ ...record, futureField: true }, "codec"), null);
  assert.equal(decodeDrawingDocumentRecord({ ...record, documentSchemaVersion: 99 }, "codec"), null);
  assert.equal(decodeDrawingDocumentRecord({ ...record, scopeKey: "other" }, "codec"), null);

  const tombstone = encodeDrawingDocumentRecord(document("empty", []), 9);
  assert.ok(tombstone);
  assert.equal(decodeDrawingDocumentRecord(tombstone, "empty")?.entities.size, 0);
});

test("putDocument encodes 512 entities once in bounded async chunks and returns metrics", async () => {
  const scopeKey = "encode-512";
  const drawings = Array.from({ length: 512 }, (_, index) => line(`line-${index}`, index));
  const source = document(scopeKey, drawings);
  const backend = new MemoryBackend();
  let entityGets = 0;
  let getsAtLastYield = 0;
  const chunkSizes: number[] = [];
  let clock = 0;
  const repository = createDrawingDocumentRepository({
    backend,
    legacyImporter: createLegacyDrawingImporter({ storage: memoryStorage(new Map()) }),
    manifestStorage: memoryStorage(new Map()),
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

  const result = await repository.putDocument(countedDocument(source, () => { entityGets += 1; }), 42);
  chunkSizes.push(entityGets - getsAtLastYield);

  assert.equal(entityGets, 512, "putDocument must not repeat a synchronous export/canonical pass");
  assert.equal(backend.putCount, 1);
  assert.equal(result.record.updatedAt, 42);
  assert.equal(result.encodeMetrics.entityCount, 512);
  assert.equal(result.encodeMetrics.chunkCount, 64);
  assert.equal(result.encodeMetrics.serializedLength, JSON.stringify(drawings).length);
  assert.ok(result.encodeMetrics.maxChunkDurationMs < 8);
  assert.ok(chunkSizes.every((count) => count > 0 && count <= 8));
  assert.deepEqual(
    result.record.entities.map((entity) => entity.id),
    source.zOrder,
  );
});

test("async put rejects aggregate point and JSON budgets before touching IndexedDB", async () => {
  const backend = new MemoryBackend();
  const repository = createDrawingDocumentRepository({
    backend,
    legacyImporter: createLegacyDrawingImporter({ storage: memoryStorage(new Map()) }),
    manifestStorage: memoryStorage(new Map()),
    encodeYield: async () => {},
  });
  const densePoints = Array.from({ length: 17_000 }, (_, index) => ({ time: index, price: index }));
  const pointHeavy = createDrawingDocument({
    scopeKey: "point-budget",
    entities: ["one", "two"].map((id) => createDrawingEntity({
      id,
      kind: "freehand",
      geometry: { kind: "freehand", dataPoints: densePoints },
      style: { kind: "freehand" },
    })),
  });
  await assert.rejects(repository.putDocument(pointHeavy), /record encoding/);

  const hugeText = "x".repeat(1_100_000);
  const textHeavy = createDrawingDocument({
    scopeKey: "json-budget",
    entities: ["one", "two"].map((id) => createDrawingEntity({
      id,
      kind: "text",
      geometry: { kind: "text" },
      style: { kind: "text", text: hugeText },
    })),
  });
  await assert.rejects(repository.putDocument(textHeavy), /record encoding/);
  assert.equal(backend.putCount, 0);
});

test("putRecord keeps strict external validation and preserves old bytes", async () => {
  const backend = new MemoryBackend();
  const scopeKey = "strict-put-record";
  const oldRecord = encodeDrawingDocumentRecord(document(scopeKey, [line("old")]), 1);
  const nextRecord = encodeDrawingDocumentRecord(document(scopeKey, [line("next")]), 2);
  assert.ok(oldRecord);
  assert.ok(nextRecord);
  backend.records.set(scopeKey, clone(oldRecord));
  const manifestValues = new Map([[drawingDocumentManifestKey(scopeKey), "old-manifest"]]);
  const repository = createDrawingDocumentRepository({
    backend,
    manifestStorage: memoryStorage(manifestValues),
    legacyImporter: createLegacyDrawingImporter({ storage: memoryStorage(new Map()) }),
  });

  await assert.rejects(
    repository.putRecord({ ...nextRecord, futureField: true } as unknown as DrawingDocumentRecordV1),
    /final validation/,
  );
  assert.equal(backend.putCount, 0);
  assert.deepEqual(backend.records.get(scopeKey), oldRecord);
  assert.equal(manifestValues.get(drawingDocumentManifestKey(scopeKey)), "old-manifest");
});

test("repository prefers v2 and falls back to legacy only when v2 is missing", async () => {
  const backend = new MemoryBackend();
  const legacyValues = new Map<string, string>();
  const manifestValues = new Map<string, string>();
  const v2 = document("scope", [line("v2")]);
  const v2Record = encodeDrawingDocumentRecord(v2, 1);
  assert.ok(v2Record);
  backend.records.set("scope", v2Record);
  legacyValues.set(legacyDrawingStorageKey("scope"), JSON.stringify([line("legacy")]));
  legacyValues.set(legacyDrawingStorageKey("legacy-only"), JSON.stringify([line("legacy")]));
  let legacyReads = 0;
  let manifestWrites = 0;
  const importer = createLegacyDrawingImporter({
    storage: {
      getItem(key) {
        legacyReads += 1;
        return legacyValues.get(key) ?? null;
      },
      setItem(key, value) { legacyValues.set(key, value); },
    },
  });
  const repository = createDrawingDocumentRepository({
    backend,
    legacyImporter: importer,
    manifestStorage: memoryStorage(manifestValues, () => { manifestWrites += 1; }),
  });

  const primary = await repository.load("scope");
  assert.equal(primary.status, "found");
  assert.equal(primary.status === "found" && primary.source, "v2");
  assert.equal(legacyReads, 0, "a found v2 record must not consult legacy storage");

  const fallback = await repository.load("legacy-only");
  assert.equal(fallback.status, "found");
  assert.equal(fallback.status === "found" && fallback.source, "legacy");
  assert.equal(manifestWrites, 0, "ordinary load must never repair or migrate storage");

  backend.records.set("scope", { ...v2Record, documentSchemaVersion: 99 });
  const invalid = await repository.load("scope");
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.source, "v2");
  assert.equal(legacyReads, 1, "invalid v2 must not fall back to legacy");

  backend.getError = new Error("IDB denied");
  const unavailable = await repository.load("scope");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.source, "v2");
  assert.equal(legacyReads, 1, "unavailable v2 must not resurrect legacy bytes");
});

test("manifest is hint-only and explicit probe repairs missing or corrupt hints", async () => {
  const backend = new MemoryBackend();
  const manifestValues = new Map<string, string>();
  const scopeKey = "manifest";
  const record = encodeDrawingDocumentRecord(document(scopeKey, [line("one"), line("two", 10)]), 5);
  assert.ok(record);
  backend.records.set(scopeKey, record);
  manifestValues.set(drawingDocumentManifestKey(scopeKey), "{broken");
  const repository = createDrawingDocumentRepository({
    backend,
    legacyImporter: createLegacyDrawingImporter({ storage: memoryStorage(new Map()) }),
    manifestStorage: memoryStorage(manifestValues),
  });

  assert.equal(repository.readManifestHint(scopeKey).status, "invalid");
  const probe = await repository.probeAndRepairManifest(scopeKey);
  assert.equal(probe.status, "found");
  assert.equal(probe.status === "found" && probe.count, 2);
  assert.equal(probe.manifestUpdated, true);
  const repaired = repository.readManifestHint(scopeKey);
  assert.equal(repaired.status, "valid");
  assert.equal(repaired.status === "valid" && repaired.hint.revision, 0);
  assert.equal(repaired.status === "valid" && repaired.hint.count, 2);
});

test("IDB failure preserves the previous record and manifest bytes", async () => {
  const backend = new MemoryBackend();
  const scopeKey = "atomic";
  const oldRecord = encodeDrawingDocumentRecord(document(scopeKey, [line("old")]), 1);
  assert.ok(oldRecord);
  backend.records.set(scopeKey, clone(oldRecord));
  backend.putError = new Error("quota exceeded");
  const manifestValues = new Map([[drawingDocumentManifestKey(scopeKey), "old-manifest"]]);
  const repository = createDrawingDocumentRepository({
    backend,
    manifestStorage: memoryStorage(manifestValues),
    legacyImporter: createLegacyDrawingImporter({ storage: memoryStorage(new Map()) }),
  });
  const next = document(scopeKey, [line("new")]);

  await assert.rejects(repository.putDocument(next, 2), /quota exceeded/);
  assert.deepEqual(backend.records.get(scopeKey), oldRecord);
  assert.equal(manifestValues.get(drawingDocumentManifestKey(scopeKey)), "old-manifest");
});

test("v2 restore yields fairly and exposes maximum decode chunk duration", async () => {
  const scopeKey = "restore-512";
  const drawings = Array.from({ length: 512 }, (_, index) => line(`line-${index}`, index));
  const record = encodeDrawingDocumentRecord(document(scopeKey, drawings), 10);
  assert.ok(record);
  const backend = new MemoryBackend();
  backend.records.set(scopeKey, record);
  let yields = 0;
  let clock = 0;
  const repository = createDrawingDocumentRepository({
    backend,
    legacyImporter: createLegacyDrawingImporter({ storage: memoryStorage(new Map()) }),
    manifestStorage: memoryStorage(new Map()),
    monotonicNow: () => {
      clock += 0.25;
      return clock;
    },
    decodeYield: async () => { yields += 1; },
    decodeChunkBudgetMs: 8,
    decodeMaxEntitiesPerChunk: 8,
  });

  const restored = await repository.loadV2(scopeKey);
  assert.equal(restored.status, "found");
  assert.equal(restored.status === "found" && restored.document.entities.size, 512);
  assert.ok(yields >= 64);
  assert.equal(restored.status === "found" && restored.decodeMetrics.entityCount, 512);
  assert.ok(restored.status === "found" && restored.decodeMetrics.maxChunkDurationMs < 16);
});
