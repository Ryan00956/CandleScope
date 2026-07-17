import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  MAX_SAVED_FREEHAND_SPANS,
} from "../drawingPersistence.js";
import {
  exportDrawingDocument,
  importSavedDrawings,
  savedDrawingFromEntity,
} from "../core/drawingCodec.js";
import {
  createDrawingEntity,
  DRAWING_DOCUMENT_SCHEMA_VERSION,
  isCanonicalDrawingEntity,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "../core/drawingDocument.js";
import type { DrawingDocument } from "../core/drawingDocument.js";
import type { SavedDrawing } from "../drawingTypes.js";

export const LEGACY_DRAWING_STORAGE_PREFIX = "candlescope-drawings";

export interface LegacyDrawingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EncodedLegacyDrawingSnapshot {
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly raw: string;
  readonly savedDrawings: readonly SavedDrawing[];
}

export interface LegacyDrawingEncodeMetrics {
  readonly chunkCount: number;
  readonly entityCount: number;
  readonly maxChunkDurationMs: number;
  readonly serializedLength: number;
}

export interface AsyncEncodedLegacyDrawingSnapshot extends EncodedLegacyDrawingSnapshot {
  readonly encodeMetrics: LegacyDrawingEncodeMetrics;
}

export type LegacyDrawingLoadResult =
  | Readonly<{
      status: "found";
      source: "legacy";
      document: DrawingDocument;
      raw: string;
      savedDrawings: readonly SavedDrawing[];
    }>
  | Readonly<{ status: "missing"; source: "legacy" }>
  | Readonly<{ status: "invalid"; source: "legacy"; error: Error }>
  | Readonly<{ status: "unavailable"; source: "legacy"; error: Error }>;

export type LegacyDrawingWriteResult =
  | Readonly<{ ok: true; documentRevision: number }>
  | Readonly<{ ok: false; documentRevision: number; error: Error }>;

export interface LegacyDrawingImporter {
  encode(document: DrawingDocument): EncodedLegacyDrawingSnapshot | null;
  encodeAsync(document: DrawingDocument): Promise<AsyncEncodedLegacyDrawingSnapshot | null>;
  load(scopeKey: string): LegacyDrawingLoadResult;
  write(encoded: EncodedLegacyDrawingSnapshot): LegacyDrawingWriteResult;
}

export interface LegacyDrawingImporterOptions {
  readonly storage?: LegacyDrawingStorage | null;
  readonly getStorage?: (() => LegacyDrawingStorage | null | undefined) | null;
  readonly monotonicNow?: () => number;
  readonly encodeYield?: () => Promise<void>;
  readonly encodeChunkBudgetMs?: number;
  readonly encodeMaxEntitiesPerChunk?: number;
}

function errorFromUnknown(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function defaultStorage(): LegacyDrawingStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultEncodeYield(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function freehandCounts(item: SavedDrawing): Readonly<{ points: number; spans: number }> {
  if (item.type !== "freehand" && item.type !== "highlighter") {
    return Object.freeze({ points: 0, spans: 0 });
  }
  return item.stroke === undefined
    ? Object.freeze({ points: item.dataPoints.length, spans: 0 })
    : Object.freeze({ points: item.stroke.points.length, spans: item.stroke.spans.length });
}

export function legacyDrawingStorageKey(scopeKey: string): string {
  return `${LEGACY_DRAWING_STORAGE_PREFIX}-${scopeKey}`;
}

function parseSavedDrawings(
  scopeKey: string,
  raw: string,
): Readonly<{
  document: DrawingDocument;
  savedDrawings: readonly SavedDrawing[];
}> | null {
  if (!scopeKey || raw.length > MAX_DRAWING_STORAGE_CHARS) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const document = importSavedDrawings(scopeKey, value);
    if (!document || !Array.isArray(value)) return null;
    const normalized = exportDrawingDocument(document);
    if (!normalized) return null;
    return Object.freeze({
      document,
      savedDrawings: Object.freeze(normalized),
    });
  } catch {
    return null;
  }
}

/**
 * Strict, read-only compatibility edge for the pre-v2 JSON-array snapshot.
 * Reads never migrate or rewrite bytes; callers create v2 only after the first
 * canonical mutation.
 */
export function createLegacyDrawingImporter({
  storage,
  getStorage,
  monotonicNow = defaultMonotonicNow,
  encodeYield = defaultEncodeYield,
  encodeChunkBudgetMs = 8,
  encodeMaxEntitiesPerChunk = 8,
}: LegacyDrawingImporterOptions = {}): LegacyDrawingImporter {
  const trustedSnapshots = new WeakSet<object>();
  const resolveStorage = (): LegacyDrawingStorage | null => {
    if (storage !== undefined) return storage;
    try {
      return getStorage?.() ?? defaultStorage();
    } catch {
      return null;
    }
  };

  const trustSnapshot = <T extends EncodedLegacyDrawingSnapshot>(snapshot: T): T => {
    trustedSnapshots.add(snapshot);
    return snapshot;
  };

  return Object.freeze({
    encode(document: DrawingDocument) {
      const savedDrawings = exportDrawingDocument(document);
      if (!savedDrawings) return null;
      try {
        const raw = JSON.stringify(savedDrawings);
        if (raw.length > MAX_DRAWING_STORAGE_CHARS) return null;
        const decoded = parseSavedDrawings(document.scopeKey, raw);
        if (!decoded) return null;
        return trustSnapshot(Object.freeze({
          scopeKey: document.scopeKey,
          documentRevision: document.documentRevision,
          raw,
          savedDrawings: decoded.savedDrawings,
        }));
      } catch {
        return null;
      }
    },

    async encodeAsync(document: DrawingDocument) {
      if (!Number.isFinite(encodeChunkBudgetMs)
        || encodeChunkBudgetMs <= 0
        || !Number.isSafeInteger(encodeMaxEntitiesPerChunk)
        || encodeMaxEntitiesPerChunk <= 0) return null;

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

        const savedDrawings: SavedDrawing[] = [];
        const seenIds = new Set<string>();
        let totalPoints = 0;
        let totalSpans = 0;
        let serializedLength = 2;
        let raw = "[";
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
          if (entity.id !== id) return null;
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
          raw += `${index === 0 ? "" : ","}${itemRaw}`;
          savedDrawings.push(saved);
          chunkEntityCount += 1;

          const duration = Math.max(0, monotonicNow() - chunkStartedAt);
          if (index + 1 < document.zOrder.length
            && (chunkEntityCount >= encodeMaxEntitiesPerChunk || duration >= encodeChunkBudgetMs)) {
            finishChunk();
            await encodeYield();
            chunkCount += 1;
            chunkEntityCount = 0;
            chunkStartedAt = monotonicNow();
          }
        }

        raw += "]";
        finishChunk();
        if (raw.length !== serializedLength) return null;
        const encodeMetrics = Object.freeze({
          chunkCount,
          entityCount: savedDrawings.length,
          maxChunkDurationMs,
          serializedLength,
        });
        return trustSnapshot(Object.freeze({
          scopeKey: document.scopeKey,
          documentRevision: document.documentRevision,
          raw,
          savedDrawings: Object.freeze(savedDrawings),
          encodeMetrics,
        }));
      } catch {
        return null;
      }
    },

    load(scopeKey: string) {
      if (!scopeKey) {
        return Object.freeze({
          status: "invalid" as const,
          source: "legacy" as const,
          error: new TypeError("drawing scope key is empty"),
        });
      }
      const target = resolveStorage();
      if (!target) {
        return Object.freeze({
          status: "unavailable" as const,
          source: "legacy" as const,
          error: new Error("legacy drawing storage is unavailable"),
        });
      }
      let raw: string | null;
      try {
        raw = target.getItem(legacyDrawingStorageKey(scopeKey));
      } catch (error) {
        return Object.freeze({
          status: "unavailable" as const,
          source: "legacy" as const,
          error: errorFromUnknown(error, "legacy drawing storage read failed"),
        });
      }
      if (raw === null) {
        return Object.freeze({ status: "missing" as const, source: "legacy" as const });
      }
      const decoded = parseSavedDrawings(scopeKey, raw);
      if (!decoded) {
        return Object.freeze({
          status: "invalid" as const,
          source: "legacy" as const,
          error: new TypeError("legacy drawing snapshot failed strict validation"),
        });
      }
      return Object.freeze({
        status: "found" as const,
        source: "legacy" as const,
        document: decoded.document,
        raw,
        savedDrawings: decoded.savedDrawings,
      });
    },

    write(encoded: EncodedLegacyDrawingSnapshot) {
      const revision = encoded.documentRevision;
      const target = resolveStorage();
      if (!target) {
        return Object.freeze({
          ok: false as const,
          documentRevision: revision,
          error: new Error("legacy drawing storage is unavailable"),
        });
      }
      const trusted = typeof encoded === "object"
        && encoded !== null
        && trustedSnapshots.has(encoded);
      const decoded = trusted ? null : parseSavedDrawings(encoded.scopeKey, encoded.raw);
      if (!trusted && (!decoded
        || encoded.raw.length > MAX_DRAWING_STORAGE_CHARS
        || JSON.stringify(decoded.savedDrawings) !== encoded.raw)) {
        return Object.freeze({
          ok: false as const,
          documentRevision: revision,
          error: new TypeError("legacy drawing snapshot failed final validation"),
        });
      }
      try {
        // Never remove or clear first. A quota/security failure therefore
        // leaves the last legacy-compatible bytes untouched.
        target.setItem(legacyDrawingStorageKey(encoded.scopeKey), encoded.raw);
        return Object.freeze({ ok: true as const, documentRevision: revision });
      } catch (error) {
        return Object.freeze({
          ok: false as const,
          documentRevision: revision,
          error: errorFromUnknown(error, "legacy drawing snapshot write failed"),
        });
      }
    },
  });
}

export const legacyDrawingImporter = createLegacyDrawingImporter();
