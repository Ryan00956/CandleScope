# Drawings Feature

`features/drawings` owns native chart drawing tools, drawing selection, interaction state, persistence, and export-time drawing preparation.

## Public Contract

`useDrawingRuntime({ chartSurfaceActions, session })` exposes:

```js
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
    handleSelectedDrawingChange,
    handleSelectedDrawingStyleChange,
    handleIndicatorRemoved,
  },
  status: {},
}
```

The hook returns only `view`, `actions`, and `status`; callers must not depend
on legacy flat fields.

## Internal Ownership

- `drawingModel.js` owns tool ids, drawing constants, id creation, and pure geometry helpers.
- `drawingToolState.js` owns toolbar-facing drawing preferences and selected drawing style mirroring.
- `core/drawingDocument.ts` owns the immutable nine-kind business model and
  independent document, geometry, and style revisions.
- `core/drawingCommands.ts` and `core/drawingDocumentStore.ts` are the only
  committed mutation/publication path. Completed controller actions carry the
  complete canonical payload required by create, delete, move, resize,
  update-style, clear, or reorder; unrelated primitive drift rejects the whole
  transaction and can never supply missing command data.
- `core/drawingCodec.ts` owns fail-closed conversion between the canonical
  document and the unchanged legacy `SavedDrawing[]` wire contract.
- `drawingPersistence.js` owns the legacy-compatible localStorage wire boundary;
  in document mode it receives codec output, never raw primitives.
- `useDrawingPersistenceLifecycle.js` owns command commit, dirty-session retry,
  renderer compensation, restore/rebind, surface credentials, and retryable
  symbol/scope isolation. User mutations remain blocked until the requested
  symbol, active store, and current chart surface agree.
- `drawingScopePersistence.ts` clears removed pane/indicator scopes through the
  document session registry, including retryable empty storage tombstones.
- `legacy/legacyPrimitiveRenderer.ts` materializes document snapshots into the
  existing primitives. Primitive private fields are transient gesture/render
  drafts and are validated at the command barrier, not persistent business truth.
- `drawingPrimitiveFactory.js` owns primitive creation from saved models and tool actions.
- `drawingSnapController.js` owns magnet snapping to visible candle time/price candidates.
- `drawingSelectionController.js` owns selected drawing metadata, selected text snapshots, and hit testing.
- `drawingInteractionController.js` owns pointer, keyboard, drag, resize, erase, text edit, primitive lifecycle, and chart adapter calls.
- `drawingPointerController.js` owns pointer coordinate normalization and DOM pointer listener lifecycle.
- `drawingEraseController.js` owns eraser hit deletion and hover-state updates.
- `primitives/` owns drawing primitive implementations used by the drawing
  controller, primitive factory, and drawing-specific UI defaults.
- `DrawingEngineHost.jsx` mounts the interaction controller and text editing surfaces.

## Allowed Dependencies

- May consume chart session through the runtime argument to derive drawing storage keys for drawing-owned cleanup.
- May expose event-style actions, such as `handleIndicatorRemoved`, so the app
  composition root can route lifecycle events without knowing drawing storage keys.
- May depend on explicit `chart-adapter` surface actions passed by the app
  composition root.
- May import drawing primitive implementations from `features/drawings/primitives`.
- May expose feature UI entry points such as `DrawingToolbar` and `DrawingEngineHost`.

## Forbidden Dependencies

- Do not load K-line data, indicators, watchlist, settings, or export options here.
- Do not import App internals or sibling feature internals.
- Do not expose raw Lightweight Charts refs or series instances from the public runtime contract.
- Do not let generic UI components own drawing localStorage access.

## Migration Notes

Phase 11 removed the old `src/hooks` and `src/runtime/workflows` drawing wrappers.
`src/services/drawingStorage.js` remains as a compatibility storage entry until
all drawing storage imports are folded into this feature.

Drawing Engine V2 Phase 2 makes document authority the default. Set
`VITE_DRAWING_DOCUMENT_AUTHORITY=legacy` at build time for an exact renderer
rollback; both modes continue reading and writing the same `SavedDrawing[]`
storage keys, so rollback does not migrate or delete user data.
