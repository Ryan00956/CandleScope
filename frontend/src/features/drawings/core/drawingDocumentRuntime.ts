import { exportDrawingDocument, importSavedDrawings } from "./drawingCodec.js";
import { applyDrawingCommands } from "./drawingCommands.js";
import type { DrawingCommand } from "./drawingCommands.js";
import { canonicalDrawingValueEquals } from "./drawingDocument.js";
import type { DrawingDocument } from "./drawingDocument.js";
import type { DrawingDocumentStore } from "./drawingDocumentStore.js";
import {
  saveSavedDrawings,
  serializeDrawingPrimitive,
} from "../drawingPersistence.js";
import type {
  DrawingPrimitive,
  PersistableDrawingPrimitive,
  SavedDrawing,
} from "../drawingTypes.js";

export interface DrawingDocumentCommitSuccess {
  readonly changed: boolean;
  readonly document: DrawingDocument;
  readonly ok: true;
  readonly primitives: readonly DrawingPrimitive[];
}

export interface DrawingDocumentCommitFailure {
  readonly changed: false;
  readonly document: DrawingDocument;
  readonly error: string;
  readonly ok: false;
}

export type DrawingDocumentCommitResult =
  | DrawingDocumentCommitSuccess
  | DrawingDocumentCommitFailure;

export type LegacyPrimitiveCommandRequest =
  | Readonly<{ type: "create" | "move" | "resize" | "update-style" }>
  | Readonly<{
      geometryCommand: "move" | "resize";
      type: "update";
    }>;

function failure(document: DrawingDocument, error: string): DrawingDocumentCommitFailure {
  return Object.freeze({ changed: false, document, error, ok: false });
}

function persistentPrimitive(primitive: DrawingPrimitive): boolean {
  const candidate = primitive as DrawingPrimitive & {
    _id?: unknown;
    _isPreview?: unknown;
    _unconfirmedText?: unknown;
  };
  if (candidate._id === "__preview__" || candidate._isPreview === true) return false;
  // Only the explicit creation-draft credential is transient. Empty strings
  // are valid in legacy SavedDrawing payloads and must survive round-trips.
  if (candidate._unconfirmedText === true) return false;
  return true;
}

function legacyPrimitiveId(primitive: DrawingPrimitive): string | null {
  const candidate = primitive as DrawingPrimitive & { id?: unknown; _id?: unknown };
  if (typeof candidate.id === "string") return candidate.id;
  return typeof candidate._id === "string" ? candidate._id : null;
}

export function persistentLegacyPrimitives(
  primitives: readonly DrawingPrimitive[],
): readonly DrawingPrimitive[] {
  return Object.freeze(primitives.filter(persistentPrimitive));
}

export function savedDrawingsFromLegacyPrimitives(
  primitives: readonly DrawingPrimitive[],
): SavedDrawing[] | null {
  const saved: SavedDrawing[] = [];
  for (const primitive of persistentLegacyPrimitives(primitives)) {
    const item = serializeDrawingPrimitive(
      primitive as unknown as PersistableDrawingPrimitive,
    );
    if (!item) return null;
    saved.push(item);
  }
  return saved;
}

/**
 * Convert one terminal legacy interaction draft into an explicit command
 * payload before it crosses the document-store boundary. The full primitive
 * registry is validated separately and can never supply or rewrite payloads.
 */
export function drawingCommandsForLegacyPrimitive(
  primitive: DrawingPrimitive,
  request: LegacyPrimitiveCommandRequest,
): readonly DrawingCommand[] | null {
  if (!persistentPrimitive(primitive)) return null;
  const saved = serializeDrawingPrimitive(
    primitive as unknown as PersistableDrawingPrimitive,
  );
  if (!saved?.id || saved.id !== legacyPrimitiveId(primitive)) return null;
  return drawingCommandsForSavedDrawing(saved, request);
}

/** Build a command from a strict SavedDrawing candidate before mutating its renderer draft. */
export function drawingCommandsForSavedDrawing(
  saved: SavedDrawing,
  request: LegacyPrimitiveCommandRequest,
): readonly DrawingCommand[] | null {
  if (!saved.id) return null;
  const document = importSavedDrawings("__drawing-command__", [saved]);
  const entity = document?.entities.get(saved.id);
  if (!entity) return null;

  switch (request.type) {
    case "create":
      return Object.freeze([Object.freeze({ type: "create", entity })]);
    case "move":
    case "resize":
      return Object.freeze([Object.freeze({
        type: request.type,
        id: entity.id,
        geometry: entity.geometry,
      })]);
    case "update-style":
      return Object.freeze([Object.freeze({
        type: "update-style",
        id: entity.id,
        patch: entity.style as Readonly<Record<string, unknown>>,
      })]);
    case "update":
      return Object.freeze([
        Object.freeze({
          type: request.geometryCommand,
          id: entity.id,
          geometry: entity.geometry,
        }),
        Object.freeze({
          type: "update-style",
          id: entity.id,
          patch: entity.style as Readonly<Record<string, unknown>>,
        }),
      ]);
  }
}

function drawingDocumentProjectionEquals(
  expected: DrawingDocument,
  candidate: DrawingDocument,
): boolean {
  if (expected.scopeKey !== candidate.scopeKey
    || expected.schemaVersion !== candidate.schemaVersion
    || expected.entities.size !== candidate.entities.size
    || !canonicalDrawingValueEquals(expected.zOrder, candidate.zOrder)) return false;
  for (const [id, entity] of expected.entities) {
    const other = candidate.entities.get(id);
    if (!other
      || entity.kind !== other.kind
      || !canonicalDrawingValueEquals(entity.geometry, other.geometry)
      || !canonicalDrawingValueEquals(entity.style, other.style)) return false;
  }
  return true;
}

interface PreparedLegacyPrimitiveDraft {
  readonly primitives: readonly DrawingPrimitive[];
  readonly target: DrawingDocument;
}

function prepareLegacyPrimitiveDraft(
  current: DrawingDocument,
  scopeKey: string,
  primitives: readonly DrawingPrimitive[],
): PreparedLegacyPrimitiveDraft | string {
  if (!scopeKey || current.scopeKey !== scopeKey) {
    return "drawing primitive draft scope is stale";
  }
  const persistentPrimitives = persistentLegacyPrimitives(primitives);
  const saved = savedDrawingsFromLegacyPrimitives(persistentPrimitives);
  if (!saved) return "legacy primitive draft could not be serialized";
  for (let index = 0; index < saved.length; index += 1) {
    const drawing = saved[index];
    const primitive = persistentPrimitives[index];
    if (!drawing?.id || !primitive || drawing.id !== legacyPrimitiveId(primitive)) {
      return "legacy primitive draft ids are not canonical";
    }
  }
  const target = importSavedDrawings(scopeKey, saved);
  if (!target) return "legacy primitive draft failed document validation";
  return Object.freeze({ primitives: persistentPrimitives, target });
}

function preflightLegacyPrimitiveDraft(
  prepared: PreparedLegacyPrimitiveDraft,
  preflight?: (
    document: DrawingDocument,
    primitives: readonly DrawingPrimitive[],
  ) => boolean,
): string | null {
  if (!preflight) return null;
  try {
    return preflight(prepared.target, prepared.primitives)
      ? null
      : "legacy primitive draft failed renderer preflight";
  } catch {
    return "legacy primitive draft renderer preflight threw";
  }
}

/**
 * Commit one completed user mutation from an explicit command batch. Commands
 * define the next document first; the mutable primitive registry can only
 * validate that renderer state matches that already-defined result.
 */
export function commitLegacyPrimitiveCommands(
  store: DrawingDocumentStore,
  scopeKey: string,
  primitives: readonly DrawingPrimitive[],
  commands: readonly DrawingCommand[],
  preflight?: (
    document: DrawingDocument,
    primitives: readonly DrawingPrimitive[],
  ) => boolean,
): DrawingDocumentCommitResult {
  const current = store.getSnapshot();
  if (!scopeKey || current.scopeKey !== scopeKey) {
    return failure(current, "drawing command scope is stale");
  }
  const prepared = prepareLegacyPrimitiveDraft(current, scopeKey, primitives);
  if (typeof prepared === "string") return failure(current, prepared);
  // Acquire the exact externally-attached candidate registry before command
  // validation. Even an invalid/cap-exceeding command can then be compensated
  // without leaving an untracked surface primitive.
  const preflightError = preflightLegacyPrimitiveDraft(prepared, preflight);
  if (preflightError) return failure(current, preflightError);
  const expected = applyDrawingCommands(current, commands);
  if (!expected.ok) return failure(current, expected.error);
  if (!drawingDocumentProjectionEquals(expected.document, prepared.target)) {
    return failure(current, "legacy renderer draft does not match the explicit command payload");
  }
  const result = store.dispatchMany(commands);
  if (!result.ok) return failure(current, result.error);
  return Object.freeze({
    changed: result.changed,
    document: result.document,
    ok: true,
    primitives: prepared.primitives,
  });
}

export function loadSavedDrawingsIntoDocumentStore(
  store: DrawingDocumentStore,
  scopeKey: string,
  saved: unknown,
): DrawingDocumentCommitResult {
  const current = store.getSnapshot();
  if (!scopeKey || current.scopeKey !== scopeKey) {
    return failure(current, "saved drawing scope does not match the store");
  }
  const document = importSavedDrawings(scopeKey, saved);
  if (!document) return failure(current, "saved drawing payload failed document validation");
  const result = store.loadDocument(document);
  if (!result.ok) return failure(current, result.error);
  return Object.freeze({
    changed: result.changed,
    document: result.document,
    ok: true,
    primitives: Object.freeze([]),
  });
}

export function persistDrawingDocumentStore(store: DrawingDocumentStore): boolean {
  const document = store.getSnapshot();
  const saved = exportDrawingDocument(document);
  if (!saved || !saveSavedDrawings(document.scopeKey, saved)) return false;
  if (store.dirty) {
    store.acknowledgePersisted(document.scopeKey, document.documentRevision);
  }
  return true;
}
