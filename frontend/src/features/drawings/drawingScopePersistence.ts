import { resolveDrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import type { DrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import {
  clearSavedDrawings,
  loadSavedDrawingsFailClosed,
} from "./drawingPersistence.js";
import {
  loadSavedDrawingsIntoDocumentStore,
  persistDrawingDocumentStore,
} from "./core/drawingDocumentRuntime.js";
import { drawingDocumentSessionRegistry } from "./core/drawingDocumentStore.js";

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
  if (drawingDocumentSessionRegistry.shouldLoadFromPersistence(scopeKey, store)) {
    const saved = loadSavedDrawingsFailClosed(scopeKey);
    if (saved) {
      const loaded = loadSavedDrawingsIntoDocumentStore(store, scopeKey, saved);
      if (!loaded.ok) return false;
    }
    // A malformed payload is already non-materializable. Marking it loaded
    // lets the clear overwrite it without repeatedly attempting the bad read.
    drawingDocumentSessionRegistry.markLoaded(scopeKey, store);
  }
  const result = store.dispatch(Object.freeze({ type: "clear" }));
  if (!result.ok) return false;
  // A clear is also a storage tombstone. Force the current (possibly already
  // empty) revision dirty so getItem/setItem failures remain retryable instead
  // of allowing an inaccessible old payload to reappear in a later process.
  if (!store.requirePersistence(scopeKey)) return false;

  // Mark the empty in-memory snapshot as the session source even if storage is
  // temporarily unavailable. A failed write then remains fail-closed instead
  // of reloading the stale payload on the next host mount.
  drawingDocumentSessionRegistry.markLoaded(scopeKey, store);
  try {
    return persistDrawingDocumentStore(store);
  } catch (error) {
    console.warn("Failed to persist authoritative drawing scope clear", error);
    return false;
  }
}
