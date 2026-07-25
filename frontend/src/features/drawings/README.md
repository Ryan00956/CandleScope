# Drawings Feature

`features/drawings` owns native chart drawing tools, drawing selection, interaction state, persistence, and export-time drawing preparation.

## Public Contract

`useDrawingRuntime({ chartSurfaceActions, session })` exposes:

```ts
{
  view: {
    drawingTool,
    penColor,
    penSize,
    textFontSize,
    textBold,
    textItalic,
    fibLevels,
    fibInverted,
    positionSize,
    drawingsHidden,
    drawingSnapEnabled,
    drawingContinuousEnabled,
    selectedDrawing,
  },
  actions: {
    setDrawingTool,
    setPenColor,
    setPenSize,
    setTextFontSize,
    setTextBold,
    setTextItalic,
    handleClearDrawing,
    handleToggleDrawingsHidden,
    handleDrawingSnapEnabledChange,
    handleDrawingContinuousEnabledChange,
    handleSelectedDrawingChange,
    handleSelectedDrawingStyleChange,
    prepareExport,
    exportInstrumentation,
    handleIndicatorRemoved,
  },
  status: {},
}
```

The hook returns only `view`, `actions`, and `status`; callers must not depend
on legacy flat fields.

## Internal Ownership

- `drawingModel.ts` owns tool ids, drawing constants, id creation, and pure geometry helpers.
- `drawingToolState.ts` owns toolbar-facing drawing preferences and selected drawing style mirroring.
- `core/drawingDocument.ts` owns the immutable nine-kind business model and
  independent document, geometry, and style revisions.
- `core/drawingCommands.ts` and `core/drawingDocumentStore.ts` are the only
  committed mutation/publication path. Completed controller actions carry the
  complete canonical payload required by create, delete, move, resize,
  update-style, clear, or reorder; unrelated primitive drift rejects the whole
  transaction and can never supply missing command data.
- `core/drawingCodec.ts` owns fail-closed conversion between the canonical
  document and the unchanged legacy `SavedDrawing[]` wire contract.
- `persistence/drawingDocumentRepository.ts` owns the canonical scope-keyed
  IndexedDB record, manifest validation, bounded encode/decode, and v2-first
  load policy. `drawingPersistenceCoordinator.ts` owns debounced single-flight
  writes, latest-pending retry, lifecycle flushes, and compatible snapshot
  refresh. `legacyDrawingImporter.ts` is the bounded legacy import/export
  boundary; it does not become a second source of truth.
- `drawingPersistence.ts` retains the validated `SavedDrawing[]` compatibility
  codec/storage helpers used by rollback builds and import tests.
- `useDrawingPersistenceLifecycle.ts` owns command commit, dirty-session retry,
  document repository coordination, renderer compensation, restore/rebind,
  surface credentials, export preparation, and retryable symbol/scope
  isolation. User mutations remain blocked until the requested symbol, active
  store, and current chart surface agree.
- `drawingScopePersistence.ts` clears removed pane/indicator scopes through the
  document session registry, including retryable empty storage tombstones.
- `engine/` owns revision-stamped scene scheduling, canonical scene projection,
  registry publication, shadow parity, and latest-frame runtime coordination.
- `rendering/` owns the clipped display list, the single visible
  `DrawingScenePrimitive`, kind-specific Canvas painters, and the dynamic
  interaction overlay. Final Lightweight Charts-bound projection stays on the
  main-thread adapter boundary.
- `geometry/` owns canonical bounds, pixel-budget LOD, and the spatial hit
  index. `worker/` may process typed, clipped/LOD display-list jobs with
  latest-wins backpressure; it must not import chart-adapter or reproduce
  Lightweight Charts coordinate logic.
- `interaction/` owns document-native create, drag, hit, text-edit, live-ink,
  and dynamic-overlay behavior. The top-level pointer, selection, erase,
  keyboard, snap, and interaction controllers coordinate those operations with
  the chart adapter.
- `export/` owns the exact-revision render/persistence barrier, hidden-scene
  lifecycle, post-capture revalidation, and fail-closed export readiness.
- `DrawingEngineHost.tsx` mounts the mode-locked document/scene/legacy owner,
  interaction controller, overlay canvases, and text editing surfaces.
- `legacy/`, `primitives/`, and `drawingPrimitiveFactory.ts` are retained only
  for the current legacy renderer, rollback builds, and compatibility probes.
  They are not persistent business truth and must not be extended as the V2
  rendering path.
- `performance/` owns drawing-local counters and runtime evidence used by the
  performance, soak, and rollback gates.

## Allowed Dependencies

- May consume chart session through the runtime argument to derive drawing storage keys for drawing-owned cleanup.
- May expose event-style actions, such as `handleIndicatorRemoved`, so the app
  composition root can route lifecycle events without knowing drawing storage keys.
- May depend on explicit `chart-adapter` surface actions passed by the app
  composition root.
- May use legacy primitive implementations only inside the documented rollback
  renderer and compatibility probes; new visible rendering belongs in the
  scene/display-list path.
- May expose feature UI entry points such as `DrawingToolbar` and `DrawingEngineHost`.

## Forbidden Dependencies

- Do not load K-line data, indicators, watchlist, settings, or export options here.
- Do not import App internals or sibling feature internals.
- Do not expose raw Lightweight Charts refs or series instances from the public runtime contract.
- Do not let generic UI components own IndexedDB, legacy snapshot, or drawing
  persistence policy.
- Do not let drawing workers import `chart-adapter`/Lightweight Charts or
  duplicate time/price projection internals.

## Migration Notes

Phase 11 removed the old `src/hooks` and `src/runtime/workflows` drawing wrappers.
`src/services/drawingStorage.ts` remains a compatibility re-export; storage
policy stays inside this feature.

Drawing Engine V2 Phases 0-8 and the local Phase 9 rollback drills are complete.
The canonical document, batch coordinate projector, visible `scene-canary`
renderer, `overlay` interaction surface, and worker raster backend are now the
repository release defaults. Full `scene` remains fail-closed until production
cohorts, observation windows, the one-hour soak, and migration-loss audit pass.

Set `VITE_DRAWING_DOCUMENT_AUTHORITY=legacy`,
`VITE_DRAWING_COORDINATE_PROJECTOR=scalar`,
`VITE_DRAWING_ENGINE_MODE=legacy`,
`VITE_DRAWING_INTERACTION_OVERLAY=legacy`, or
`VITE_DRAWING_RASTER_BACKEND=main-thread` only as scoped emergency rollback
controls. V2
IndexedDB writes continue refreshing the bounded legacy-compatible
`SavedDrawing[]` snapshot; no rollback path may delete user data. Legacy
primitives and their factory remain until the Phase 9 deletion conditions are
satisfied.
