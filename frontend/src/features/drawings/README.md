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

The hook still returns legacy flat fields while `App.jsx` and shell props are migrated.

## Internal Ownership

- `drawingModel.js` owns tool ids, drawing constants, id creation, and pure geometry helpers.
- `drawingToolState.js` owns toolbar-facing drawing preferences and selected drawing style mirroring.
- `drawingPersistence.js` owns localStorage serialization, loading, existence checks, and clearing.
- `useDrawingPersistenceLifecycle.js` owns when saved drawings are persisted,
  restored, re-attached, or swapped across symbols.
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
