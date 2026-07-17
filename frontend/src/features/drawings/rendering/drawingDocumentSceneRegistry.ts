import {
  createDrawingDocument,
} from "../core/drawingDocument.js";
import type { DrawingDocument } from "../core/drawingDocument.js";
import type {
  LegacyPrimitiveAsyncReconcileOptions,
  LegacyPrimitiveAsyncReconcileResult,
  LegacyPrimitiveRenderer,
} from "../legacy/legacyPrimitiveRenderer.js";
import type { DrawingPrimitive } from "../drawingTypes.js";

export interface DrawingDocumentSceneRegistryEvidence {
  readonly registryKind: "scene-document-only";
  readonly documentEntityCount: number;
  readonly legacyPrimitiveAttachedCount: 0;
  readonly legacyPrimitiveInstanceCount: 0;
  readonly disposed: boolean;
}

export interface DrawingDocumentSceneRegistry extends LegacyPrimitiveRenderer {
  /**
   * Phase 8 rollout evidence. The unique composite scene primitive is owned by
   * the scene bridge and is intentionally not counted as a legacy primitive.
   */
  evidence(): DrawingDocumentSceneRegistryEvidence;
}

function canonicalDocument(document: DrawingDocument): DrawingDocument | null {
  try {
    const validated = createDrawingDocument({
      scopeKey: document.scopeKey,
      documentRevision: document.documentRevision,
      entities: document.entities,
      zOrder: document.zOrder,
    });
    const sharesEntities = validated.entities.size === document.entities.size
      && validated.zOrder.every((id) => validated.entities.get(id) === document.entities.get(id));
    return sharesEntities && Object.isFrozen(document) && Object.isFrozen(document.zOrder)
      ? document
      : validated;
  } catch {
    return null;
  }
}

/**
 * Scene-canary registry which retains only the canonical document identity.
 * It deliberately cannot manufacture or own per-drawing chart primitives.
 */
export function createDrawingDocumentSceneRegistry(): DrawingDocumentSceneRegistry {
  let document: DrawingDocument | null = null;
  let disposed = false;

  const replace = (candidate: DrawingDocument): boolean => {
    if (disposed) return false;
    const next = canonicalDocument(candidate);
    if (!next) return false;
    document = next;
    return true;
  };

  const acceptsEmptyProjection = (
    candidate: DrawingDocument,
    primitives: readonly DrawingPrimitive[],
  ): boolean => !disposed && primitives.length === 0 && canonicalDocument(candidate) !== null;

  const registry: DrawingDocumentSceneRegistry = {
    reconcile: replace,
    async reconcileAsync(
      candidate: DrawingDocument,
      options: LegacyPrimitiveAsyncReconcileOptions = {},
    ): Promise<LegacyPrimitiveAsyncReconcileResult> {
      if (options.signal?.aborted || disposed) {
        return Object.freeze({
          ok: false,
          cancelled: true,
          entityCount: 0,
          chunkCount: 0,
          maxChunkDurationMs: 0,
        });
      }
      const ok = replace(candidate);
      return Object.freeze({
        ok,
        cancelled: false,
        entityCount: ok ? candidate.entities.size : 0,
        chunkCount: ok && candidate.entities.size > 0 ? 1 : 0,
        maxChunkDurationMs: 0,
      });
    },
    replaceDocument: replace,
    adopt(candidate, primitives) {
      return acceptsEmptyProjection(candidate, primitives) && replace(candidate);
    },
    adoptAttached(candidate, primitives) {
      return acceptsEmptyProjection(candidate, primitives) && replace(candidate);
    },
    adoptDetached(candidate, primitives = []) {
      return acceptsEmptyProjection(candidate, primitives) && replace(candidate);
    },
    canAdopt: acceptsEmptyProjection,
    stageAttached(primitives) {
      if (primitives.length > 0) {
        throw new TypeError("drawing scene registry cannot stage legacy primitives");
      }
    },
    snapshot() {
      return Object.freeze([]);
    },
    attachedCount() {
      return 0;
    },
    evidence() {
      return Object.freeze({
        registryKind: "scene-document-only" as const,
        documentEntityCount: document?.entities.size ?? 0,
        legacyPrimitiveAttachedCount: 0 as const,
        legacyPrimitiveInstanceCount: 0 as const,
        disposed,
      });
    },
    documentSnapshot() {
      return document;
    },
    getPrimitiveById() {
      return null;
    },
    detachSurface() {
      return !disposed;
    },
    rebindSurface() {
      return !disposed;
    },
    releaseSurfaceCredentials() {
      // The scene bridge owns the sole chart attachment.
    },
    restoreDocument: replace,
    detachAll() {
      return !disposed;
    },
    dispose() {
      disposed = true;
      document = null;
    },
  };
  return Object.freeze(registry);
}
