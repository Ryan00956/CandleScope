import { resolveDrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import type { DrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import {
  clearSavedDrawings,
} from "./drawingPersistence.js";
import { drawingDocumentSessionRegistry } from "./core/drawingDocumentStore.js";
import { drawingPersistenceCoordinator } from "./persistence/drawingPersistenceCoordinator.js";

/**
 * Clear a complete drawing scope without bypassing the Phase 2 authority.
 *
 * Indicator/pane removal can happen while no DrawingEngineHost is mounted.
 * Clearing localStorage alone would leave the session store alive and allow a
 * later host to materialize deleted entities (or rewrite them during teardown).
 */
export function clearDrawingScopeAuthoritatively(
  scopeKey: string,
  authorityMode: DrawingDocumentAuthorityMode = resolveDrawingDocumentAuthorityMode(),
): boolean {
  if (!scopeKey) return false;
  if (authorityMode === "legacy") {
    clearSavedDrawings(scopeKey);
    return true;
  }

  const store = drawingDocumentSessionRegistry.getStore(scopeKey);
  drawingDocumentSessionRegistry.markLoaded(scopeKey, store);
  // The empty canonical document is a v2 tombstone. It supersedes any pending
  // async load immediately, but neither deletes the v2 record nor erases the
  // rollback snapshot before the atomic replacement succeeds.
  return drawingPersistenceCoordinator.clear(store);
}
