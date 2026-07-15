import {
  createDrawingDocument,
  createDrawingEntity,
  DRAWING_DOCUMENT_SCHEMA_VERSION,
  isCanonicalDrawingEntity,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "../core/drawingDocument.js";
import type {
  CanonicalBounds,
  CanonicalDrawingGeometry,
  DrawingDocument,
  DrawingEntity,
  DrawingStyle,
} from "../core/drawingDocument.js";
import {
  exportDrawingDocument,
  savedDrawingFromEntity,
} from "../core/drawingCodec.js";
import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  MAX_SAVED_FREEHAND_SPANS,
} from "../drawingPersistence.js";
import type { SavedDrawing } from "../drawingTypes.js";
import { legacyDrawingImporter } from "./legacyDrawingImporter.js";
import type {
  LegacyDrawingImporter,
  LegacyDrawingLoadResult,
} from "./legacyDrawingImporter.js";

export const DRAWING_DOCUMENT_DATABASE_NAME = "candlescope-drawings-v2";
export const DRAWING_DOCUMENT_DATABASE_VERSION = 1;
export const DRAWING_DOCUMENT_STORE_NAME = "documents";
export const DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION = 1 as const;
export const DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const DRAWING_DOCUMENT_MANIFEST_PREFIX = "candlescope-drawings-v2-manifest";

export interface DrawingDocumentEntityRecord {
  readonly id: string;
  readonly kind: DrawingEntity["kind"];
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly geometry: CanonicalDrawingGeometry;
  readonly style: DrawingStyle;
  readonly bounds: CanonicalBounds;
}

/** `entities` is stored in canonical z-order. */
export interface DrawingDocumentRecordV1 {
  readonly documentSchemaVersion: typeof DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION;
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly updatedAt: number;
  readonly entities: readonly DrawingDocumentEntityRecord[];
}

export interface DrawingDocumentManifestHint {
  readonly manifestSchemaVersion: typeof DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION;
  readonly scopeKey: string;
  readonly count: number;
  readonly revision: number;
}

export interface DrawingDocumentDecodeMetrics {
  readonly chunkCount: number;
  readonly entityCount: number;
  readonly maxChunkDurationMs: number;
}

export interface DrawingDocumentEncodeMetrics extends DrawingDocumentDecodeMetrics {
  /** Length of the equivalent legacy JSON-array payload used for the shared budget. */
  readonly serializedLength: number;
}

export interface EncodedDrawingDocumentRecord {
  readonly record: DrawingDocumentRecordV1;
  readonly metrics: DrawingDocumentEncodeMetrics;
}

export type DrawingDocumentManifestReadResult =
  | Readonly<{ status: "valid"; hint: DrawingDocumentManifestHint }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid"; error: Error }>
  | Readonly<{ status: "unavailable"; error: Error }>;

export type DrawingDocumentV2LoadResult =
  | Readonly<{
      status: "found";
      source: "v2";
      document: DrawingDocument;
      record: DrawingDocumentRecordV1;
      decodeMetrics: DrawingDocumentDecodeMetrics;
    }>
  | Readonly<{ status: "missing"; source: "v2" }>
  | Readonly<{ status: "invalid"; source: "v2"; error: Error }>
  | Readonly<{ status: "unavailable"; source: "v2"; error: Error }>;

export type DrawingDocumentLoadResult =
  | Extract<DrawingDocumentV2LoadResult, { status: "found" | "invalid" | "unavailable" }>
  | Extract<LegacyDrawingLoadResult, { status: "found" | "invalid" | "unavailable" }>
  | Readonly<{ status: "missing"; source: "none" }>;

export type DrawingDocumentPresenceProbeResult =
  | Readonly<{
      status: "found";
      source: "v2" | "legacy";
      count: number;
      revision: number;
      manifestUpdated: boolean;
    }>
  | Readonly<{
      status: "missing";
      source: "none";
      count: 0;
      revision: 0;
      manifestUpdated: boolean;
    }>
  | Readonly<{
      status: "invalid" | "unavailable";
      source: "v2" | "legacy";
      error: Error;
      manifestUpdated: false;
    }>;

export interface DrawingDocumentRepositoryBackend {
  get(scopeKey: string): Promise<unknown | undefined>;
  put(record: DrawingDocumentRecordV1): Promise<void>;
}

export interface DrawingDocumentManifestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DrawingDocumentPutResult {
  readonly record: DrawingDocumentRecordV1;
  readonly manifestUpdated: boolean;
}

export interface EncodedDrawingDocumentPutResult extends DrawingDocumentPutResult {
  readonly encodeMetrics: DrawingDocumentEncodeMetrics;
}

export interface DrawingDocumentRepository {
  load(scopeKey: string): Promise<DrawingDocumentLoadResult>;
  loadV2(scopeKey: string): Promise<DrawingDocumentV2LoadResult>;
  putDocument(document: DrawingDocument, updatedAt?: number): Promise<EncodedDrawingDocumentPutResult>;
  putRecord(record: DrawingDocumentRecordV1): Promise<DrawingDocumentPutResult>;
  probeAndRepairManifest(scopeKey: string): Promise<DrawingDocumentPresenceProbeResult>;
  readManifestHint(scopeKey: string): DrawingDocumentManifestReadResult;
}

export interface DrawingDocumentRepositoryOptions {
  readonly backend?: DrawingDocumentRepositoryBackend;
  readonly legacyImporter?: LegacyDrawingImporter;
  readonly manifestStorage?: DrawingDocumentManifestStorage | null;
  readonly getManifestStorage?: (() => DrawingDocumentManifestStorage | null | undefined) | null;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly decodeYield?: () => Promise<void>;
  readonly decodeChunkBudgetMs?: number;
  readonly decodeMaxEntitiesPerChunk?: number;
  readonly encodeYield?: () => Promise<void>;
  readonly encodeChunkBudgetMs?: number;
  readonly encodeMaxEntitiesPerChunk?: number;
}

export interface DrawingDocumentAsyncDecodeOptions {
  readonly expectedScopeKey?: string;
  readonly monotonicNow?: () => number;
  readonly yieldToHost?: () => Promise<void>;
  readonly chunkBudgetMs?: number;
  readonly maxEntitiesPerChunk?: number;
}

export interface DrawingDocumentAsyncEncodeOptions {
  readonly monotonicNow?: () => number;
  readonly yieldToHost?: () => Promise<void>;
  readonly chunkBudgetMs?: number;
  readonly maxEntitiesPerChunk?: number;
}

export interface IndexedDbDrawingDocumentBackendOptions {
  readonly factory?: IDBFactory | null;
  readonly databaseName?: string;
  readonly databaseVersion?: number;
  readonly storeName?: string;
}

const RECORD_KEYS = Object.freeze([
  "documentSchemaVersion",
  "scopeKey",
  "documentRevision",
  "updatedAt",
  "entities",
]);
const ENTITY_KEYS = Object.freeze([
  "id",
  "kind",
  "geometryRevision",
  "styleRevision",
  "geometry",
  "style",
  "bounds",
]);
const MANIFEST_KEYS = Object.freeze([
  "manifestSchemaVersion",
  "scopeKey",
  "count",
  "revision",
]);

function errorFromUnknown(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCanonicalBounds(value: unknown): value is CanonicalBounds {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "deferred") return hasExactKeys(value, ["kind"]);
  if (value.kind === "unbounded") {
    return hasExactKeys(value, ["kind", "axis"])
      && (value.axis === "horizontal" || value.axis === "vertical" || value.axis === "both");
  }
  if (value.kind !== "bounded"
    || !hasExactKeys(value, ["kind", "minTime", "maxTime", "minPrice", "maxPrice"])
    || !isFiniteNumber(value.minTime)
    || !isFiniteNumber(value.maxTime)
    || !isFiniteNumber(value.minPrice)
    || !isFiniteNumber(value.maxPrice)) return false;
  return value.minTime <= value.maxTime && value.minPrice <= value.maxPrice;
}

function decodeEntityRecord(value: unknown): DrawingEntity | null {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ENTITY_KEYS)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.kind !== "string"
    || !isRevision(value.geometryRevision)
    || !isRevision(value.styleRevision)
    || !isPlainRecord(value.geometry)
    || !isPlainRecord(value.style)
    || !isCanonicalBounds(value.bounds)) return null;
  try {
    return createDrawingEntity({
      id: value.id,
      kind: value.kind as DrawingEntity["kind"],
      geometryRevision: value.geometryRevision,
      styleRevision: value.styleRevision,
      geometry: value.geometry as unknown as CanonicalDrawingGeometry,
      style: value.style as unknown as DrawingStyle,
      bounds: value.bounds,
    });
  } catch {
    return null;
  }
}

function entityRecord(entity: DrawingEntity): DrawingDocumentEntityRecord {
  return Object.freeze({
    id: entity.id,
    kind: entity.kind,
    geometryRevision: entity.geometryRevision,
    styleRevision: entity.styleRevision,
    geometry: entity.geometry,
    style: entity.style,
    bounds: entity.bounds,
  });
}

function assembleDrawingDocumentRecord(
  document: DrawingDocument,
  updatedAt: number,
): DrawingDocumentRecordV1 | null {
  try {
    const entities = document.zOrder.map((id) => {
      const entity = document.entities.get(id);
      if (!entity || entity.id !== id) throw new TypeError("drawing document z-order is corrupt");
      return entityRecord(entity);
    });
    return Object.freeze({
      documentSchemaVersion: DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION,
      scopeKey: document.scopeKey,
      documentRevision: document.documentRevision,
      updatedAt,
      entities: Object.freeze(entities),
    });
  } catch {
    return null;
  }
}

/** Encode only canonical, budget-valid documents into the structured-clone record. */
export function encodeDrawingDocumentRecord(
  document: DrawingDocument,
  updatedAt: number = Date.now(),
): DrawingDocumentRecordV1 | null {
  if (!isTimestamp(updatedAt) || !exportDrawingDocument(document)) return null;
  return assembleDrawingDocumentRecord(document, updatedAt);
}

/**
 * Fair-yield write-side encoder. Every entity is canonicalized and checked
 * against the same aggregate legacy budgets without a synchronous whole-
 * document export or a second record canonicalization pass.
 */
export async function encodeDrawingDocumentRecordAsync(
  document: DrawingDocument,
  updatedAt: number = Date.now(),
  {
    monotonicNow = defaultMonotonicNow,
    yieldToHost = defaultDecodeYield,
    chunkBudgetMs = 8,
    maxEntitiesPerChunk = 8,
  }: DrawingDocumentAsyncEncodeOptions = {},
): Promise<EncodedDrawingDocumentRecord | null> {
  if (!Number.isFinite(chunkBudgetMs)
    || chunkBudgetMs <= 0
    || !Number.isSafeInteger(maxEntitiesPerChunk)
    || maxEntitiesPerChunk <= 0
    || !isTimestamp(updatedAt)) return null;

  try {
    if (!isPlainRecord(document)
      || document.schemaVersion !== DRAWING_DOCUMENT_SCHEMA_VERSION
      || typeof document.scopeKey !== "string"
      || document.scopeKey.length === 0
      || !isRevision(document.documentRevision)
      || !Array.isArray(document.zOrder)
      || document.entities === null
      || typeof document.entities !== "object"
      || typeof document.entities.get !== "function"
      || !Number.isSafeInteger(document.entities.size)
      || document.entities.size < 0
      || document.entities.size > MAX_SAVED_DRAWINGS
      || document.entities.size > MAX_DRAWING_DOCUMENT_ENTITIES
      || document.zOrder.length !== document.entities.size) return null;

    const records: DrawingDocumentEntityRecord[] = [];
    const seenIds = new Set<string>();
    let totalPoints = 0;
    let totalSpans = 0;
    let serializedLength = 2;
    let chunkCount = 1;
    let maxChunkDurationMs = 0;
    let chunkEntityCount = 0;
    let chunkStartedAt = monotonicNow();

    const finishChunk = (): number => {
      const duration = Math.max(0, monotonicNow() - chunkStartedAt);
      maxChunkDurationMs = Math.max(maxChunkDurationMs, duration);
      return duration;
    };

    for (let index = 0; index < document.zOrder.length; index += 1) {
      const id: unknown = document.zOrder[index];
      if (typeof id !== "string" || id.length === 0 || seenIds.has(id)) return null;
      seenIds.add(id);
      const source = document.entities.get(id);
      if (!source || source.id !== id) return null;
      const entity = isCanonicalDrawingEntity(source) ? source : createDrawingEntity(source);
      if (entity.id !== id || !isCanonicalBounds(entity.bounds)) return null;
      const saved = savedDrawingFromEntity(entity);
      if (!saved) return null;
      const counts = freehandCounts(saved);
      totalPoints += counts.points;
      totalSpans += counts.spans;
      if (totalPoints > MAX_SAVED_FREEHAND_POINTS || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
        return null;
      }
      const itemRaw = JSON.stringify(saved);
      if (typeof itemRaw !== "string") return null;
      serializedLength += itemRaw.length + (index === 0 ? 0 : 1);
      if (serializedLength > MAX_DRAWING_STORAGE_CHARS) return null;
      records.push(entityRecord(entity));
      chunkEntityCount += 1;

      const duration = Math.max(0, monotonicNow() - chunkStartedAt);
      if (index + 1 < document.zOrder.length
        && (chunkEntityCount >= maxEntitiesPerChunk || duration >= chunkBudgetMs)) {
        finishChunk();
        await yieldToHost();
        chunkCount += 1;
        chunkEntityCount = 0;
        chunkStartedAt = monotonicNow();
      }
    }

    finishChunk();
    const record = Object.freeze({
      documentSchemaVersion: DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION,
      scopeKey: document.scopeKey,
      documentRevision: document.documentRevision,
      updatedAt,
      entities: Object.freeze(records),
    });
    return Object.freeze({
      record,
      metrics: Object.freeze({
        chunkCount,
        entityCount: records.length,
        maxChunkDurationMs,
        serializedLength,
      }),
    });
  } catch {
    return null;
  }
}

/** Decode fail-closed; no entity, unknown field, or budget failure is skipped. */
export function decodeDrawingDocumentRecord(
  value: unknown,
  expectedScopeKey?: string,
): DrawingDocument | null {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, RECORD_KEYS)
    || value.documentSchemaVersion !== DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION
    || typeof value.scopeKey !== "string"
    || value.scopeKey.length === 0
    || (expectedScopeKey !== undefined && value.scopeKey !== expectedScopeKey)
    || !isRevision(value.documentRevision)
    || !isTimestamp(value.updatedAt)
    || !Array.isArray(value.entities)) return null;
  const entities: DrawingEntity[] = [];
  for (const candidate of value.entities) {
    const entity = decodeEntityRecord(candidate);
    if (!entity) return null;
    entities.push(entity);
  }
  try {
    const document = createDrawingDocument({
      scopeKey: value.scopeKey,
      documentRevision: value.documentRevision,
      entities,
      zOrder: entities.map((entity) => entity.id),
    });
    return exportDrawingDocument(document) ? document : null;
  } catch {
    return null;
  }
}

function canonicalRecord(value: unknown, expectedScopeKey?: string): DrawingDocumentRecordV1 | null {
  if (!isPlainRecord(value) || !isTimestamp(value.updatedAt)) return null;
  const document = decodeDrawingDocumentRecord(value, expectedScopeKey);
  return document ? encodeDrawingDocumentRecord(document, value.updatedAt) : null;
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultDecodeYield(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function freehandCounts(item: SavedDrawing): Readonly<{ points: number; spans: number }> {
  if (item.type !== "freehand" && item.type !== "highlighter") {
    return Object.freeze({ points: 0, spans: 0 });
  }
  return item.stroke === undefined
    ? Object.freeze({ points: item.dataPoints.length, spans: 0 })
    : Object.freeze({ points: item.stroke.points.length, spans: item.stroke.spans.length });
}

/**
 * Fair-yield restore decoder. It validates every entity and every aggregate
 * legacy budget without one final full-document stringify on the load path.
 */
export async function decodeDrawingDocumentRecordAsync(
  value: unknown,
  {
    expectedScopeKey,
    monotonicNow = defaultMonotonicNow,
    yieldToHost = defaultDecodeYield,
    chunkBudgetMs = 8,
    maxEntitiesPerChunk = 8,
  }: DrawingDocumentAsyncDecodeOptions = {},
): Promise<Readonly<{
  document: DrawingDocument;
  metrics: DrawingDocumentDecodeMetrics;
}> | null> {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, RECORD_KEYS)
    || value.documentSchemaVersion !== DRAWING_DOCUMENT_RECORD_SCHEMA_VERSION
    || typeof value.scopeKey !== "string"
    || value.scopeKey.length === 0
    || (expectedScopeKey !== undefined && value.scopeKey !== expectedScopeKey)
    || !isRevision(value.documentRevision)
    || !isTimestamp(value.updatedAt)
    || !Array.isArray(value.entities)
    || value.entities.length > MAX_SAVED_DRAWINGS
    || !Number.isFinite(chunkBudgetMs)
    || chunkBudgetMs <= 0
    || !Number.isSafeInteger(maxEntitiesPerChunk)
    || maxEntitiesPerChunk <= 0) return null;

  const entities: DrawingEntity[] = [];
  let totalPoints = 0;
  let totalSpans = 0;
  let serializedLength = 2;
  let chunkCount = 1;
  let maxChunkDurationMs = 0;
  let chunkEntityCount = 0;
  let chunkStartedAt = monotonicNow();

  const finishChunk = (): number => {
    const duration = Math.max(0, monotonicNow() - chunkStartedAt);
    maxChunkDurationMs = Math.max(maxChunkDurationMs, duration);
    return duration;
  };

  for (const candidate of value.entities) {
    const entity = decodeEntityRecord(candidate);
    if (!entity) return null;
    const saved = savedDrawingFromEntity(entity);
    if (!saved) return null;
    const counts = freehandCounts(saved);
    totalPoints += counts.points;
    totalSpans += counts.spans;
    if (totalPoints > MAX_SAVED_FREEHAND_POINTS || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
      return null;
    }
    let itemRaw: string;
    try {
      itemRaw = JSON.stringify(saved);
    } catch {
      return null;
    }
    serializedLength += itemRaw.length + (entities.length === 0 ? 0 : 1);
    if (serializedLength > MAX_DRAWING_STORAGE_CHARS) return null;
    entities.push(entity);
    chunkEntityCount += 1;
    const duration = Math.max(0, monotonicNow() - chunkStartedAt);
    if (chunkEntityCount >= maxEntitiesPerChunk || duration >= chunkBudgetMs) {
      finishChunk();
      await yieldToHost();
      chunkCount += 1;
      chunkEntityCount = 0;
      chunkStartedAt = monotonicNow();
    }
  }

  let document: DrawingDocument;
  try {
    document = createDrawingDocument({
      scopeKey: value.scopeKey,
      documentRevision: value.documentRevision,
      entities,
      zOrder: entities.map((entity) => entity.id),
    });
  } catch {
    return null;
  }
  finishChunk();
  return Object.freeze({
    document,
    metrics: Object.freeze({
      chunkCount,
      entityCount: entities.length,
      maxChunkDurationMs,
    }),
  });
}

function defaultIndexedDbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

/** Native IDB backend. It opens lazily and performs one atomic put transaction. */
export function createIndexedDbDrawingDocumentBackend({
  factory,
  databaseName = DRAWING_DOCUMENT_DATABASE_NAME,
  databaseVersion = DRAWING_DOCUMENT_DATABASE_VERSION,
  storeName = DRAWING_DOCUMENT_STORE_NAME,
}: IndexedDbDrawingDocumentBackendOptions = {}): DrawingDocumentRepositoryBackend {
  let databasePromise: Promise<IDBDatabase> | null = null;

  const openDatabase = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const targetFactory = factory === undefined ? defaultIndexedDbFactory() : factory;
      if (!targetFactory) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = targetFactory.open(databaseName, databaseVersion);
      } catch (error) {
        reject(errorFromUnknown(error, "drawing IndexedDB open failed"));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: "scopeKey" });
        }
      };
      request.onerror = () => reject(request.error ?? new Error("drawing IndexedDB open failed"));
      request.onblocked = () => reject(new Error("drawing IndexedDB upgrade is blocked"));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  };

  const transactionComplete = (transaction: IDBTransaction): Promise<void> => (
    new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("drawing IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("drawing IndexedDB transaction aborted"));
    })
  );

  return Object.freeze({
    async get(scopeKey: string) {
      const database = await openDatabase();
      const transaction = database.transaction(storeName, "readonly");
      const complete = transactionComplete(transaction);
      const request = transaction.objectStore(storeName).get(scopeKey);
      const value = await new Promise<unknown | undefined>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as unknown | undefined);
        request.onerror = () => reject(request.error ?? new Error("drawing IndexedDB read failed"));
      });
      await complete;
      return value;
    },

    async put(record: DrawingDocumentRecordV1) {
      const database = await openDatabase();
      const transaction = database.transaction(storeName, "readwrite");
      const complete = transactionComplete(transaction);
      const request = transaction.objectStore(storeName).put(record);
      const written = new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("drawing IndexedDB write failed"));
      });
      await Promise.all([written, complete]);
    },
  });
}

function defaultManifestStorage(): DrawingDocumentManifestStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function drawingDocumentManifestKey(scopeKey: string): string {
  return `${DRAWING_DOCUMENT_MANIFEST_PREFIX}-${encodeURIComponent(scopeKey)}`;
}

function decodeManifestHint(value: unknown, expectedScopeKey: string): DrawingDocumentManifestHint | null {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, MANIFEST_KEYS)
    || value.manifestSchemaVersion !== DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION
    || value.scopeKey !== expectedScopeKey
    || !isRevision(value.count)
    || !isRevision(value.revision)) return null;
  return Object.freeze({
    manifestSchemaVersion: DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION,
    scopeKey: expectedScopeKey,
    count: value.count,
    revision: value.revision,
  });
}

export function createDrawingDocumentRepository({
  backend = createIndexedDbDrawingDocumentBackend(),
  legacyImporter: importer = legacyDrawingImporter,
  manifestStorage,
  getManifestStorage,
  now = Date.now,
  monotonicNow = defaultMonotonicNow,
  decodeYield = defaultDecodeYield,
  decodeChunkBudgetMs = 8,
  decodeMaxEntitiesPerChunk = 8,
  encodeYield = defaultDecodeYield,
  encodeChunkBudgetMs = 8,
  encodeMaxEntitiesPerChunk = 8,
}: DrawingDocumentRepositoryOptions = {}): DrawingDocumentRepository {
  const resolveManifestStorage = (): DrawingDocumentManifestStorage | null => {
    if (manifestStorage !== undefined) return manifestStorage;
    try {
      return getManifestStorage?.() ?? defaultManifestStorage();
    } catch {
      return null;
    }
  };

  const readManifestHint = (scopeKey: string): DrawingDocumentManifestReadResult => {
    if (!scopeKey) {
      return Object.freeze({ status: "invalid" as const, error: new TypeError("drawing scope key is empty") });
    }
    const storage = resolveManifestStorage();
    if (!storage) {
      return Object.freeze({ status: "unavailable" as const, error: new Error("drawing manifest storage is unavailable") });
    }
    let raw: string | null;
    try {
      raw = storage.getItem(drawingDocumentManifestKey(scopeKey));
    } catch (error) {
      return Object.freeze({
        status: "unavailable" as const,
        error: errorFromUnknown(error, "drawing manifest read failed"),
      });
    }
    if (raw === null) return Object.freeze({ status: "missing" as const });
    try {
      const hint = decodeManifestHint(JSON.parse(raw) as unknown, scopeKey);
      return hint
        ? Object.freeze({ status: "valid" as const, hint })
        : Object.freeze({ status: "invalid" as const, error: new TypeError("drawing manifest is invalid") });
    } catch (error) {
      return Object.freeze({
        status: "invalid" as const,
        error: errorFromUnknown(error, "drawing manifest is invalid"),
      });
    }
  };

  const writeManifest = (hint: DrawingDocumentManifestHint): boolean => {
    const storage = resolveManifestStorage();
    if (!storage) return false;
    try {
      storage.setItem(drawingDocumentManifestKey(hint.scopeKey), JSON.stringify(hint));
      return true;
    } catch {
      return false;
    }
  };

  const loadV2 = async (scopeKey: string): Promise<DrawingDocumentV2LoadResult> => {
    if (!scopeKey) {
      return Object.freeze({
        status: "invalid" as const,
        source: "v2" as const,
        error: new TypeError("drawing scope key is empty"),
      });
    }
    let value: unknown | undefined;
    try {
      value = await backend.get(scopeKey);
    } catch (error) {
      return Object.freeze({
        status: "unavailable" as const,
        source: "v2" as const,
        error: errorFromUnknown(error, "drawing document read failed"),
      });
    }
    if (value === undefined) {
      return Object.freeze({ status: "missing" as const, source: "v2" as const });
    }
    const decoded = await decodeDrawingDocumentRecordAsync(value, {
      expectedScopeKey: scopeKey,
      monotonicNow,
      yieldToHost: decodeYield,
      chunkBudgetMs: decodeChunkBudgetMs,
      maxEntitiesPerChunk: decodeMaxEntitiesPerChunk,
    });
    const updatedAt = isPlainRecord(value) && isTimestamp(value.updatedAt)
      ? value.updatedAt
      : null;
    const record = decoded && updatedAt !== null
      ? assembleDrawingDocumentRecord(decoded.document, updatedAt)
      : null;
    if (!record || !decoded) {
      return Object.freeze({
        status: "invalid" as const,
        source: "v2" as const,
        error: new TypeError("drawing document record failed strict validation"),
      });
    }
    return Object.freeze({
      status: "found" as const,
      source: "v2" as const,
      document: decoded.document,
      record,
      decodeMetrics: decoded.metrics,
    });
  };

  const load = async (scopeKey: string): Promise<DrawingDocumentLoadResult> => {
    const primary = await loadV2(scopeKey);
    if (primary.status !== "missing") return primary;
    const legacy = importer.load(scopeKey);
    if (legacy.status === "missing") {
      return Object.freeze({ status: "missing" as const, source: "none" as const });
    }
    return legacy;
  };

  const putRecord = async (record: DrawingDocumentRecordV1): Promise<DrawingDocumentPutResult> => {
    const expectedScopeKey = isPlainRecord(record) && typeof record.scopeKey === "string"
      ? record.scopeKey
      : undefined;
    const canonical = canonicalRecord(record, expectedScopeKey);
    if (!canonical) throw new TypeError("drawing document record failed final validation");
    await backend.put(canonical);
    const manifestUpdated = writeManifest(Object.freeze({
      manifestSchemaVersion: DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION,
      scopeKey: canonical.scopeKey,
      count: canonical.entities.length,
      revision: canonical.documentRevision,
    }));
    return Object.freeze({ record: canonical, manifestUpdated });
  };

  const repository: DrawingDocumentRepository = {
    load,
    loadV2,
    async putDocument(document, updatedAt = now()) {
      const encoded = await encodeDrawingDocumentRecordAsync(document, updatedAt, {
        monotonicNow,
        yieldToHost: encodeYield,
        chunkBudgetMs: encodeChunkBudgetMs,
        maxEntitiesPerChunk: encodeMaxEntitiesPerChunk,
      });
      if (!encoded) throw new TypeError("drawing document failed record encoding");
      await backend.put(encoded.record);
      const manifestUpdated = writeManifest(Object.freeze({
        manifestSchemaVersion: DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION,
        scopeKey: encoded.record.scopeKey,
        count: encoded.record.entities.length,
        revision: encoded.record.documentRevision,
      }));
      return Object.freeze({
        record: encoded.record,
        manifestUpdated,
        encodeMetrics: encoded.metrics,
      });
    },
    putRecord,
    async probeAndRepairManifest(scopeKey) {
      const result = await load(scopeKey);
      if (result.status === "invalid" || result.status === "unavailable") {
        return Object.freeze({
          status: result.status,
          source: result.source,
          error: result.error,
          manifestUpdated: false as const,
        });
      }
      const count = result.status === "found" ? result.document.entities.size : 0;
      const revision = result.status === "found" ? result.document.documentRevision : 0;
      const manifestUpdated = writeManifest(Object.freeze({
        manifestSchemaVersion: DRAWING_DOCUMENT_MANIFEST_SCHEMA_VERSION,
        scopeKey,
        count,
        revision,
      }));
      return result.status === "found"
        ? Object.freeze({
            status: "found" as const,
            source: result.source,
            count,
            revision,
            manifestUpdated,
          })
        : Object.freeze({
            status: "missing" as const,
            source: "none" as const,
            count: 0 as const,
            revision: 0 as const,
            manifestUpdated,
          });
    },
    readManifestHint,
  };
  return Object.freeze(repository);
}

export const drawingDocumentRepository = createDrawingDocumentRepository();
