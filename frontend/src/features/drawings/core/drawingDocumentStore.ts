import { applyDrawingCommands } from "./drawingCommands.js";
import type {
  DrawingCommand,
  DrawingCommandApplyResult,
} from "./drawingCommands.js";
import {
  canonicalDrawingValueEquals,
  createDrawingDocument,
} from "./drawingDocument.js";
import type { DrawingDocument } from "./drawingDocument.js";

export type DrawingDocumentStoreListener = (
  snapshot: DrawingDocument,
  previous: DrawingDocument,
) => void;

export interface DrawingDocumentLoadSuccess {
  readonly changed: boolean;
  readonly document: DrawingDocument;
  readonly ok: true;
}

export interface DrawingDocumentLoadFailure {
  readonly changed: false;
  readonly document: DrawingDocument;
  readonly error: string;
  readonly ok: false;
}

export type DrawingDocumentLoadResult = DrawingDocumentLoadSuccess | DrawingDocumentLoadFailure;

export interface DrawingDocumentStore {
  readonly dirty: boolean;
  readonly dirtyRevision: number | null;
  acknowledgePersisted(scopeKey: string, documentRevision: number): boolean;
  dispatch(command: DrawingCommand): DrawingCommandApplyResult;
  dispatchMany(commands: readonly DrawingCommand[]): DrawingCommandApplyResult;
  getSnapshot(): DrawingDocument;
  loadDocument(document: DrawingDocument): DrawingDocumentLoadResult;
  requirePersistence(scopeKey: string): boolean;
  subscribe(listener: DrawingDocumentStoreListener): () => void;
}

export interface DrawingDocumentSessionRegistry {
  getStore(scopeKey: string): DrawingDocumentStore;
  isLoaded(scopeKey: string): boolean;
  shouldLoadFromPersistence(scopeKey: string, store: DrawingDocumentStore): boolean;
  markLoaded(scopeKey: string, store: DrawingDocumentStore): boolean;
}

function documentsEqual(left: DrawingDocument, right: DrawingDocument): boolean {
  if (left.scopeKey !== right.scopeKey
    || left.schemaVersion !== right.schemaVersion
    || left.documentRevision !== right.documentRevision
    || !canonicalDrawingValueEquals(left.zOrder, right.zOrder)
    || left.entities.size !== right.entities.size) return false;
  for (const [id, entity] of left.entities) {
    const other = right.entities.get(id);
    if (!other
      || entity.kind !== other.kind
      || entity.geometryRevision !== other.geometryRevision
      || entity.styleRevision !== other.styleRevision
      || !canonicalDrawingValueEquals(entity.geometry, other.geometry)
      || !canonicalDrawingValueEquals(entity.style, other.style)) return false;
  }
  return true;
}

function loadFailure(document: DrawingDocument, error: unknown): DrawingDocumentLoadFailure {
  return Object.freeze({
    changed: false,
    document,
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  });
}

export function createDrawingDocumentStore(
  initial: string | DrawingDocument,
): DrawingDocumentStore {
  let snapshot = typeof initial === "string"
    ? createDrawingDocument({ scopeKey: initial })
    : createDrawingDocument({
        scopeKey: initial.scopeKey,
        documentRevision: initial.documentRevision,
        entities: initial.entities,
        zOrder: initial.zOrder,
      });
  let currentDirtyRevision: number | null = null;
  const listeners = new Set<DrawingDocumentStoreListener>();

  const publish = (next: DrawingDocument): void => {
    const previous = snapshot;
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener(next, previous);
      } catch {
        // Listener failures cannot roll back an already committed document.
      }
    }
  };

  const dispatchMany = (commands: readonly DrawingCommand[]): DrawingCommandApplyResult => {
    const result = applyDrawingCommands(snapshot, commands);
    if (!result.ok || !result.changed) return result;
    currentDirtyRevision = result.document.documentRevision;
    publish(result.document);
    return result;
  };

  const store: DrawingDocumentStore = {
    get dirty() { return currentDirtyRevision !== null; },
    get dirtyRevision() { return currentDirtyRevision; },
    acknowledgePersisted(scopeKey, documentRevision) {
      if (scopeKey !== snapshot.scopeKey
        || documentRevision !== snapshot.documentRevision
        || currentDirtyRevision !== documentRevision) return false;
      currentDirtyRevision = null;
      return true;
    },
    dispatch(command) {
      return dispatchMany([command]);
    },
    dispatchMany,
    getSnapshot() {
      return snapshot;
    },
    loadDocument(document) {
      if (document.scopeKey !== snapshot.scopeKey) {
        return loadFailure(snapshot, "drawing document load scope does not match the store");
      }
      let next: DrawingDocument;
      try {
        // createDrawingDocument copies the map/z-order boundary while sharing
        // only module-authenticated, deeply immutable canonical entities. A
        // large freehand restore therefore cannot trigger a second full deep
        // clone after the repository already validated it; forged entities
        // are still rebuilt defensively by the document constructor.
        next = createDrawingDocument({
          scopeKey: document.scopeKey,
          documentRevision: document.documentRevision,
          entities: document.entities,
          zOrder: document.zOrder,
        });
      } catch (error) {
        return loadFailure(snapshot, error);
      }
      const changed = !documentsEqual(snapshot, next);
      currentDirtyRevision = null;
      if (changed) publish(next);
      return Object.freeze({ changed, document: snapshot, ok: true });
    },
    requirePersistence(scopeKey) {
      if (scopeKey !== snapshot.scopeKey) return false;
      currentDirtyRevision = snapshot.documentRevision;
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("drawing store listener must be a function");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return Object.freeze(store);
}

/**
 * Session-lifetime scope registry. Dirty snapshots survive chart surface and
 * React host remounts so a failed localStorage write remains retryable.
 */
export function createDrawingDocumentSessionRegistry(): DrawingDocumentSessionRegistry {
  const stores = new Map<string, DrawingDocumentStore>();
  const loadedScopes = new Set<string>();
  return Object.freeze({
    getStore(scopeKey: string) {
      let store = stores.get(scopeKey);
      if (!store) {
        store = createDrawingDocumentStore(scopeKey);
        stores.set(scopeKey, store);
      }
      return store;
    },
    isLoaded(scopeKey: string) {
      return loadedScopes.has(scopeKey);
    },
    shouldLoadFromPersistence(scopeKey: string, store: DrawingDocumentStore) {
      return stores.get(scopeKey) === store
        && store.getSnapshot().scopeKey === scopeKey
        && !loadedScopes.has(scopeKey)
        && !store.dirty;
    },
    markLoaded(scopeKey: string, store: DrawingDocumentStore) {
      if (stores.get(scopeKey) !== store || store.getSnapshot().scopeKey !== scopeKey) return false;
      loadedScopes.add(scopeKey);
      return true;
    },
  });
}

export const drawingDocumentSessionRegistry = createDrawingDocumentSessionRegistry();
