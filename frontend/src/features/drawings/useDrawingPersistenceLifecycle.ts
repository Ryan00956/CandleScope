import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { createPrimitiveFromSavedDrawing } from "./drawingPrimitiveFactory.js";
import {
  loadDrawings,
  loadSavedDrawingsFailClosed,
  saveDrawings,
} from "./drawingPersistence.js";
import {
  EMPTY_SELECTED_TEXT_UI,
  selectedTextUiFromPrimitive,
} from "./drawingSelectionController.js";
import type { SelectedTextUi } from "./drawingSelectionController.js";
import { resolveDrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import { createEmptyDrawingDocument } from "./core/drawingDocument.js";
import {
  commitLegacyPrimitiveCommands,
  loadSavedDrawingsIntoDocumentStore,
  persistDrawingDocumentStore,
  persistentLegacyPrimitives,
} from "./core/drawingDocumentRuntime.js";
import type { DrawingCommand } from "./core/drawingCommands.js";
import {
  drawingDocumentSessionRegistry,
} from "./core/drawingDocumentStore.js";
import type { DrawingDocumentStore } from "./core/drawingDocumentStore.js";
import {
  createLegacyPrimitiveRenderer,
} from "./legacy/legacyPrimitiveRenderer.js";
import type { LegacyPrimitiveRenderer } from "./legacy/legacyPrimitiveRenderer.js";
import type {
  DrawingPrimitive,
} from "./drawingTypes.js";
import type { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import {
  drawingPerfCounters,
  registerDrawingPerfRuntimeSummaryProvider,
} from "./performance/drawingPerfCounters.js";
import type { DrawingPerfRuntimeSummary } from "./performance/drawingPerfCounters.js";

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function runtimeArrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function runtimePrimitiveType(record: Record<string, unknown>): string {
  if (typeof record._lineType === "string" || typeof record.lineType === "string") return "line";
  if (typeof record._shapeType === "string" || typeof record.shapeType === "string") return "shape";
  const type = record.type ?? record._type;
  if (typeof type === "string" && type.trim()) return type.trim();
  const constructorRecord = runtimeRecord(record.constructor);
  const constructorName = constructorRecord?.name;
  return typeof constructorName === "string" && constructorName.trim()
    ? constructorName.trim()
    : "unknown";
}

function runtimePrimitivePointCount(record: Record<string, unknown>): number {
  const stroke = runtimeRecord(record.stroke ?? record._stroke);
  const strokePointCount = runtimeArrayLength(stroke?.points);
  if (strokePointCount !== null) return strokePointCount;
  const dataPointCount = runtimeArrayLength(record.dataPoints ?? record._dataPoints);
  if (dataPointCount !== null) return dataPointCount;
  return record.dataPoint !== undefined || record._dataPoint !== undefined ? 1 : 0;
}

export function summarizeDrawingRuntimePrimitives(
  primitives: readonly unknown[],
): DrawingPerfRuntimeSummary {
  let entityCount = 0;
  let pointCount = 0;
  const typeCounts: Record<string, number> = {};
  for (const primitive of primitives) {
    const record = runtimeRecord(primitive);
    if (!record) continue;
    entityCount += 1;
    const type = runtimePrimitiveType(record);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    pointCount += runtimePrimitivePointCount(record);
  }
  return {
    entityCount,
    pointCount,
    typeCounts,
  };
}

function persistAndMeasure(symbol: string, primitives: readonly DrawingPrimitive[]): void {
  const startedAt = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  try {
    saveDrawings(symbol, primitives);
  } finally {
    const endedAt = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    const durationMs = Math.max(0, endedAt - startedAt);
    drawingPerfCounters.recordPersistenceDuration(durationMs);
  }
}

function persistDocumentAndMeasure(store: DrawingDocumentStore): boolean {
  const startedAt = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  try {
    return persistDrawingDocumentStore(store);
  } finally {
    const endedAt = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    drawingPerfCounters.recordPersistenceDuration(Math.max(0, endedAt - startedAt));
  }
}

export interface DrawingPersistenceAdapter {
  hasSeries?(): boolean;
  attachPrimitive?(primitive: DrawingPrimitive): unknown;
  detachPrimitive?(primitive: DrawingPrimitive): unknown;
}

export interface DrawingMutationScopeState {
  activeScope: string;
  hasSeries: boolean;
  previousScope: string | null;
  ready: boolean;
  requestedScope: string;
  surfaceScope: string;
}

/**
 * A user mutation may only touch the surface/store pair that belongs to the
 * symbol currently requested by React. During a failed A -> B transition the
 * old A store deliberately remains active, so `ready` alone is insufficient.
 */
export function isDrawingMutationScopeReady({
  activeScope,
  hasSeries,
  previousScope,
  ready,
  requestedScope,
  surfaceScope,
}: DrawingMutationScopeState): boolean {
  return ready
    && hasSeries
    && requestedScope.length > 0
    && activeScope === requestedScope
    && surfaceScope === requestedScope
    && previousScope === requestedScope;
}

export function prepareDrawingMutationScope(
  state: DrawingMutationScopeState,
  requestRetry: () => void,
): boolean {
  const ready = isDrawingMutationScopeReady(state);
  if (!ready) requestRetry();
  return ready;
}

export interface UseDrawingPersistenceLifecycleOptions {
  beforeScopeTransitionRef: MutableRefObject<() => boolean>;
  currentFreehandRef: MutableRefObject<FreehandDrawingPrimitive | null>;
  draggingRef: MutableRefObject<unknown | null>;
  getChartAdapter(): DrawingPersistenceAdapter | null;
  hiddenRef: MutableRefObject<boolean>;
  isDrawingFreehandRef: MutableRefObject<boolean>;
  prevSymbolRef: MutableRefObject<string | null>;
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  selectedIdRef: MutableRefObject<string | null>;
  seriesReady: number;
  setSelectedPrimId: Dispatch<SetStateAction<string | null>>;
  setSelectedTextUi: Dispatch<SetStateAction<SelectedTextUi>>;
  symbol: string;
  symbolRef: MutableRefObject<string>;
}

export function useDrawingPersistenceLifecycle({
  beforeScopeTransitionRef,
  currentFreehandRef,
  draggingRef,
  getChartAdapter,
  hiddenRef,
  isDrawingFreehandRef,
  prevSymbolRef,
  primitivesRef,
  selectedIdRef,
  seriesReady,
  setSelectedPrimId,
  setSelectedTextUi,
  symbol,
  symbolRef,
}: UseDrawingPersistenceLifecycleOptions): {
  clearDrawings(): boolean;
  completeSurfaceDispose(): void;
  invalidateSurfaceCredentialsForSeriesReplacement(): void;
  persistDrawings(commands: readonly DrawingCommand[]): boolean;
  persistActiveScopeDrawings(commands: readonly DrawingCommand[]): boolean;
  prepareUserMutationScope(): boolean;
  prepareSurfaceDispose(): boolean;
} {
  const authorityMode = resolveDrawingDocumentAuthorityMode();
  const adapterGetterRef = useRef(getChartAdapter);
  const [initialStore] = useState(() => drawingDocumentSessionRegistry.getStore(symbol));
  const [scopeRetryGeneration, setScopeRetryGeneration] = useState(0);
  const activeStoreRef = useRef<DrawingDocumentStore>(initialStore);
  const rendererRef = useRef<LegacyPrimitiveRenderer | null>(null);
  const requestedScopeRef = useRef(symbol);
  const scopeReadyRef = useRef(false);

  // Native pointer listeners and the imperative host API are replaced in
  // passive effects. Close the commit -> passive-effect window in layout so
  // even an old callback observes the newly requested scope and fails closed.
  useLayoutEffect(() => {
    requestedScopeRef.current = symbol;
    scopeReadyRef.current = false;
  }, [getChartAdapter, seriesReady, symbol]);

  useEffect(() => {
    adapterGetterRef.current = getChartAdapter;
  }, [getChartAdapter]);

  useEffect(() => {
    if (rendererRef.current) return;
    rendererRef.current = createLegacyPrimitiveRenderer({
      surface: {
        attachPrimitive: (primitive) => {
          const adapter = adapterGetterRef.current();
          if (!adapter?.attachPrimitive) return false;
          return adapter.attachPrimitive(primitive) !== false;
        },
        detachPrimitive: (primitive) => {
          const adapter = adapterGetterRef.current();
          if (!adapter?.detachPrimitive) return false;
          return adapter.detachPrimitive(primitive) !== false;
        },
      },
      createPrimitive: (saved) => {
        const primitive = createPrimitiveFromSavedDrawing(saved);
        if (!primitive) return null;
        primitive.setHidden?.(hiddenRef.current, false);
        const selectable = primitive as DrawingPrimitive & {
          setSelected?: (selected: boolean) => void;
        };
        selectable.setSelected?.(primitive.id === selectedIdRef.current);
        return primitive;
      },
    });
  }, [hiddenRef, selectedIdRef]);

  const commitPrimitiveDraft = useCallback((
    scopeKey: string,
    store: DrawingDocumentStore,
    primitives: readonly DrawingPrimitive[],
    options: Readonly<{
      adoptRenderer?: boolean;
      commands?: readonly DrawingCommand[];
      restoreOnFailure?: boolean;
    }> = {},
  ): boolean => {
    const adoptRenderer = options.adoptRenderer !== false;
    const restoreOnFailure = options.restoreOnFailure !== false;
    const renderer = rendererRef.current;
    if (!renderer) return false;
    const hasCommands = options.commands !== undefined;
    // Register only delta objects relative to the renderer registry before
    // validation. Terminal commands own their normal candidates; an empty
    // lifecycle barrier can also recover a candidate retained after an
    // exceptional controller callback failed before reaching this hook.
    renderer.stageAttached(persistentLegacyPrimitives(primitives));
    const result = commitLegacyPrimitiveCommands(
      store,
      scopeKey,
      primitives,
      options.commands ?? [],
      // A terminal command stages the exact externally-mutated candidate so
      // failure recovery owns every surface credential. Lifecycle barriers
      // pass an empty command batch and only validate the tracked projection;
      // they can never synthesize a document mutation from primitives.
      hasCommands
        ? (document, candidates) => renderer.adoptAttached(document, candidates)
        : (document, candidates) => renderer.canAdopt(document, candidates),
    );
    if (!result.ok) {
      console.warn("Failed to commit drawing document:", result.error);
      if (restoreOnFailure) {
        if (renderer.restoreDocument(store.getSnapshot())) {
          primitivesRef.current = [...renderer.snapshot()];
        } else {
          console.warn("Failed to restore the canonical drawing document after draft rejection");
        }
      }
      return false;
    }
    if (adoptRenderer) {
      const adopted = hasCommands
        ? renderer.adoptAttached(result.document, result.primitives)
        : renderer.adopt(result.document, result.primitives);
      if (!adopted) {
        if (!renderer.restoreDocument(result.document)) {
          console.warn("Failed to adopt or restore the committed drawing document; persistence was skipped");
          return false;
        }
        primitivesRef.current = [...renderer.snapshot()];
      }
    }
    if (result.changed || store.dirty) {
      try {
        if (!persistDocumentAndMeasure(store)) {
          console.warn("Failed to persist drawing document; the in-memory document remains dirty");
        }
      } catch (error) {
        // The document command is already committed and remains the in-memory
        // authority. Storage failure must not escape and make the controller
        // compensate a successfully published surface mutation.
        console.warn("Drawing document persistence threw; the in-memory document remains dirty", error);
      }
    }
    return true;
  }, [primitivesRef]);

  const requestScopeRetry = useCallback((): void => {
    setScopeRetryGeneration((generation) => (
      generation >= Number.MAX_SAFE_INTEGER ? 0 : generation + 1
    ));
  }, []);

  const prepareUserMutationScope = useCallback((): boolean => {
    const adapter = adapterGetterRef.current();
    const activeScope = authorityMode === "document"
      ? activeStoreRef.current.getSnapshot().scopeKey
      : symbolRef.current;
    return prepareDrawingMutationScope({
      activeScope,
      hasSeries: adapter?.hasSeries?.() === true,
      previousScope: prevSymbolRef.current,
      ready: scopeReadyRef.current,
      requestedScope: requestedScopeRef.current,
      surfaceScope: symbolRef.current,
    }, requestScopeRetry);
  }, [authorityMode, prevSymbolRef, requestScopeRetry, symbolRef]);

  // Scope transitions must be able to finish the old gesture against the old
  // store even after React has requested a new symbol. This path is private to
  // the transition barrier; normal user mutations always use persistDrawings.
  const persistActiveScopeDrawings = useCallback((commands: readonly DrawingCommand[]): boolean => {
    if (authorityMode === "legacy") {
      try {
        persistAndMeasure(symbolRef.current, primitivesRef.current);
        return true;
      } catch (error) {
        console.warn("Legacy drawing persistence threw", error);
        return false;
      }
    }
    const store = activeStoreRef.current;
    return commitPrimitiveDraft(
      store.getSnapshot().scopeKey,
      store,
      primitivesRef.current,
      { commands },
    );
  }, [authorityMode, commitPrimitiveDraft, primitivesRef, symbolRef]);

  const persistDrawings = useCallback((commands: readonly DrawingCommand[]): boolean => {
    if (!prepareUserMutationScope()) return false;
    return persistActiveScopeDrawings(commands);
  }, [persistActiveScopeDrawings, prepareUserMutationScope]);

  const clearDrawings = useCallback((): boolean => {
    // This check happens before any canonical primitive is detached. In a
    // failed A -> B transition it prevents a B-side clear action from clearing
    // the still-active A document and schedules the transition effect to retry.
    if (!prepareUserMutationScope()) return false;
    if (authorityMode === "legacy") {
      persistAndMeasure(symbolRef.current, []);
      const adapter = getChartAdapter();
      for (const primitive of primitivesRef.current) {
        try {
          adapter?.detachPrimitive?.(primitive);
        } catch {
          // Legacy rollback retains its historical best-effort clear behavior.
        }
      }
      return true;
    }
    const renderer = rendererRef.current;
    const store = activeStoreRef.current;
    if (!renderer) return false;
    const currentPrimitives = persistentLegacyPrimitives(primitivesRef.current);
    if (!renderer.canAdopt(store.getSnapshot(), currentPrimitives)
      || !renderer.adopt(store.getSnapshot(), currentPrimitives)) {
      console.warn("Failed to stage drawing clear against the current renderer registry");
      return false;
    }
    if (!renderer.detachSurface()) {
      renderer.rebindSurface();
      console.warn("Failed to detach every drawing before clear; the document was not changed");
      return false;
    }
    if (!commitPrimitiveDraft(store.getSnapshot().scopeKey, store, [], {
      commands: [Object.freeze({ type: "clear" })],
    })) return false;
    return true;
  }, [authorityMode, commitPrimitiveDraft, getChartAdapter, prepareUserMutationScope, primitivesRef, symbolRef]);

  const prepareSurfaceDispose = useCallback((): boolean => {
    scopeReadyRef.current = false;
    if (!beforeScopeTransitionRef.current()) return false;
    if (authorityMode === "legacy") {
      persistAndMeasure(symbolRef.current, primitivesRef.current);
      const adapter = getChartAdapter();
      let detached = true;
      for (const primitive of primitivesRef.current) {
        try {
          if (adapter?.detachPrimitive?.(primitive) === false) detached = false;
        } catch {
          detached = false;
        }
      }
      return detached;
    }

    const renderer = rendererRef.current;
    const store = activeStoreRef.current;
    if (!renderer) return false;
    const committed = commitPrimitiveDraft(
      store.getSnapshot().scopeKey,
      store,
      primitivesRef.current,
    );
    const detached = renderer.detachSurface();
    if (detached) {
      renderer.adopt(createEmptyDrawingDocument(store.getSnapshot().scopeKey), []);
    }
    return committed && detached;
  }, [authorityMode, beforeScopeTransitionRef, commitPrimitiveDraft, getChartAdapter, primitivesRef, symbolRef]);

  const completeSurfaceDispose = useCallback((): void => {
    scopeReadyRef.current = false;
    if (authorityMode === "document") {
      // chart.remove() invalidates even credentials whose explicit detach
      // failed. Forget them only after the surface owner confirms removal so
      // the next series rebuild attaches the canonical registry exactly once.
      const renderer = rendererRef.current;
      renderer?.releaseSurfaceCredentials();
      const scopeKey = activeStoreRef.current.getSnapshot().scopeKey;
      renderer?.adopt(createEmptyDrawingDocument(scopeKey), []);
      primitivesRef.current = [];
    }
  }, [authorityMode, primitivesRef]);

  const invalidateSurfaceCredentialsForSeriesReplacement = useCallback((): void => {
    // removeSeries() invalidates primitive-owned series bindings without
    // removing the chart itself. Preserve document and primitive registries,
    // but forget every old-series credential so the generation effect must
    // attach each canonical primitive to the replacement series.
    scopeReadyRef.current = false;
    try {
      rendererRef.current?.releaseSurfaceCredentials();
    } catch {
      // This imperative invalidation boundary is deliberately no-throw.
    }
  }, []);

  useEffect(() => registerDrawingPerfRuntimeSummaryProvider(
    () => summarizeDrawingRuntimePrimitives(primitivesRef.current),
  ), [primitivesRef]);

  useEffect(() => {
    scopeReadyRef.current = false;
    const adapter = getChartAdapter();
    const renderer = rendererRef.current;
    if (!adapter?.hasSeries?.() || !renderer || !symbol || !seriesReady) return;

    const prevSymbol = prevSymbolRef.current;
    const symbolChanged = prevSymbol && prevSymbol !== symbol;
    if (authorityMode === "document" && symbolChanged) {
      if (!beforeScopeTransitionRef.current()) {
        for (const primitive of renderer.snapshot()) primitive.setHidden?.(true);
        console.warn("Drawing scope transition preparation failed; the previous scope remains authoritative");
        return;
      }
    }

    if (authorityMode === "legacy") {
      if (symbolChanged) {
        if (primitivesRef.current.length > 0) {
          persistAndMeasure(prevSymbol, primitivesRef.current);
        }

        for (const prim of primitivesRef.current) adapter.detachPrimitive?.(prim);
        primitivesRef.current = [];
        selectedIdRef.current = null;
        setSelectedPrimId(null);
        setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
        draggingRef.current = null;
        isDrawingFreehandRef.current = false;
        currentFreehandRef.current = null;
        prevSymbolRef.current = symbol;
        symbolRef.current = symbol;
      }

      if (!symbolChanged && primitivesRef.current.length > 0) {
        for (const prim of primitivesRef.current) {
          try {
            adapter.detachPrimitive?.(prim);
            prim.setHidden?.(hiddenRef.current, false);
            adapter.attachPrimitive?.(prim);
          } catch (err) {
            console.warn("Failed to re-attach drawing:", err);
          }
        }
        prevSymbolRef.current = symbol;
        symbolRef.current = symbol;
        scopeReadyRef.current = true;
        return;
      }

      for (const item of loadDrawings(symbol)) {
        let primitive = null;
        try {
          primitive = createPrimitiveFromSavedDrawing(item);
        } catch (err) {
          console.warn("Failed to restore drawing:", err, item);
        }
        if (primitive) {
          primitive.setHidden?.(hiddenRef.current, false);
          adapter.attachPrimitive?.(primitive);
          primitivesRef.current.push(primitive);
        }
      }
      drawingPerfCounters.setGauge("visibleEntities", primitivesRef.current.length);
      prevSymbolRef.current = symbol;
      symbolRef.current = symbol;
      scopeReadyRef.current = true;
      return;
    }

    if (symbolChanged) {
      const previousStore = activeStoreRef.current;
      if (!commitPrimitiveDraft(prevSymbol, previousStore, primitivesRef.current, {
        adoptRenderer: false,
        restoreOnFailure: false,
      })) {
        console.warn("Failed to commit the previous drawing scope before switching symbols");
      }
      const detached = renderer.detachSurface();
      if (!detached) {
        // Some primitives may still belong to the old surface. Keep the old
        // registry/store authoritative and hide anything that remains attached;
        // activating the next scope here would mix symbols irreversibly.
        for (const primitive of renderer.snapshot()) primitive.setHidden?.(true);
        console.warn("Failed to detach the previous drawing scope completely; the scope transition was kept fail-closed");
        return;
      }
      primitivesRef.current = [];
      renderer.adopt(createEmptyDrawingDocument(prevSymbol), []);
      selectedIdRef.current = null;
      setSelectedPrimId(null);
      setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      draggingRef.current = null;
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
      prevSymbolRef.current = symbol;
    }

    if (!symbolChanged && primitivesRef.current.length > 0) {
      const currentPrimitives = persistentLegacyPrimitives(primitivesRef.current);
      for (const prim of currentPrimitives) prim.setHidden?.(hiddenRef.current, false);
      let rebound = true;
      if (!renderer.adopt(activeStoreRef.current.getSnapshot(), currentPrimitives)
        || !renderer.rebindSurface()) {
        if (renderer.restoreDocument(activeStoreRef.current.getSnapshot())) {
          primitivesRef.current = [...renderer.snapshot()];
        } else {
          rebound = false;
          for (const primitive of renderer.snapshot()) primitive.setHidden?.(true);
          console.warn("Failed to restore the drawing renderer registry after a series rebuild; the surface was kept fail-closed");
        }
      } else {
        primitivesRef.current = [...currentPrimitives];
      }
      prevSymbolRef.current = symbol;
      symbolRef.current = symbol;
      scopeReadyRef.current = rebound;
      return;
    }

    const store = drawingDocumentSessionRegistry.getStore(symbol);
    activeStoreRef.current = store;
    symbolRef.current = symbol;
    prevSymbolRef.current = symbol;
    if (!drawingDocumentSessionRegistry.isLoaded(symbol) && store.dirty) {
      // A dirty in-memory snapshot is newer than disk by definition. Mark it
      // as the session's loaded source so a host remount cannot overwrite the
      // unsaved revision with an older localStorage payload.
      drawingDocumentSessionRegistry.markLoaded(symbol, store);
    } else if (drawingDocumentSessionRegistry.shouldLoadFromPersistence(symbol, store)) {
      const saved = loadSavedDrawingsFailClosed(symbol);
      const loaded = saved
        ? loadSavedDrawingsIntoDocumentStore(store, symbol, saved)
        : null;
      if (!loaded?.ok) {
        console.warn("Failed to load drawing document:", loaded?.error ?? "saved drawing payload failed validation");
      } else {
        drawingDocumentSessionRegistry.markLoaded(symbol, store);
      }
    }

    if (!renderer.reconcile(store.getSnapshot())) {
      console.warn("Failed to materialize the drawing document; the document was retained for retry");
    } else {
      primitivesRef.current = [...renderer.snapshot()];
      const selected = selectedIdRef.current
        ? renderer.getPrimitiveById(selectedIdRef.current)
        : null;
      setSelectedTextUi(selectedTextUiFromPrimitive(selected));
      if (selectedIdRef.current && !selected) {
        selectedIdRef.current = null;
        setSelectedPrimId(null);
      }
      scopeReadyRef.current = true;
    }
    drawingPerfCounters.setGauge("visibleEntities", primitivesRef.current.length);

    prevSymbolRef.current = symbol;
  }, [
    currentFreehandRef,
    authorityMode,
    beforeScopeTransitionRef,
    commitPrimitiveDraft,
    draggingRef,
    getChartAdapter,
    hiddenRef,
    isDrawingFreehandRef,
    prevSymbolRef,
    primitivesRef,
    selectedIdRef,
    seriesReady,
    setSelectedPrimId,
    setSelectedTextUi,
    symbol,
    symbolRef,
    // A rejected user mutation increments this generation so the exact same
    // symbol/series pair re-enters the transition effect instead of remaining
    // permanently stuck on the previous store.
    scopeRetryGeneration,
  ]);

  useEffect(() => () => {
    scopeReadyRef.current = false;
    const adapter = getChartAdapter();
    if (authorityMode === "document") {
      const prepared = beforeScopeTransitionRef.current();
      const store = activeStoreRef.current;
      if (prepared) {
        commitPrimitiveDraft(store.getSnapshot().scopeKey, store, primitivesRef.current, {
          adoptRenderer: false,
          restoreOnFailure: false,
        });
      }
    }
    const renderer = rendererRef.current;
    let detached = true;
    if (authorityMode === "document" && renderer) {
      detached = renderer.detachSurface();
    } else {
      for (const prim of primitivesRef.current) {
        try {
          if (adapter?.detachPrimitive?.(prim) === false) detached = false;
        } catch {
          detached = false;
          // Best-effort teardown. The owning chart may already be disposing.
        }
      }
    }
    if (!detached) console.warn("Drawing surface teardown was incomplete; the next surface will retry attachment");
    if (detached) {
      const activeScope = activeStoreRef.current.getSnapshot().scopeKey;
      renderer?.adopt(createEmptyDrawingDocument(activeScope), []);
    }
  }, [authorityMode, beforeScopeTransitionRef, commitPrimitiveDraft, getChartAdapter, primitivesRef]);

  return {
    clearDrawings,
    completeSurfaceDispose,
    invalidateSurfaceCredentialsForSeriesReplacement,
    persistActiveScopeDrawings,
    persistDrawings,
    prepareSurfaceDispose,
    prepareUserMutationScope,
  };
}
