# Drawing Engine Lazy-Load Design

## Goal

Move the native drawing engine out of the first chart render path while
preserving the current `ChartPane` and `MultiPaneChart` behavior. The first
K-line paint should not pay for drawing primitives unless the active chart
actually needs saved drawings or the user activates a drawing workflow.

The change should be implemented as an adapter boundary:

```txt
ChartPane
  -> DrawingController
      -> noop controller
      -> loading controller
      -> real useDrawing engine
```

`ChartPane` should keep the same render and imperative contract. The controller
decides whether the heavy implementation is absent, loading, or ready.

## Current Shape

- `ChartPane.jsx` imports `useDrawing` directly, so every pane pulls the full
  hook and all primitive classes into the active module graph.
- `useDrawing.js` imports all primitive implementations:
  `LineDrawingPrimitive`, `FreehandDrawingPrimitive`, `TextDrawingPrimitive`,
  `FibonacciDrawingPrimitive`, `PositionDrawingPrimitive`,
  `ShapeDrawingPrimitive`, `AxisLineDrawingPrimitive`, and
  `AngleMeasurementPrimitive`.
- `MultiPaneChart` forwards these imperative methods to the active panes:
  `clearAllDrawings`, `setDrawingsHidden`, `updateSelectedDrawingStyle`,
  `prepareExport`, and `getExportSnapshot`.
- Main-pane drawings use `drawingKeyBase || symbol`.
- Sub-pane drawings use `${drawingKeyBase || symbol}__${paneId}` and are
  anchored to the first indicator series once that series exists.
- Export calls `prepareExport()` before reading snapshots so active text edits
  can be committed.

## Controller Contract

The controller must expose every current `useDrawing` return field:

| Field | No-op behavior | Loading behavior | Real-engine behavior |
|---|---|---|---|
| `clearAll` | Clear persisted storage for the pane key, no attached primitives | Allow storage clear and cancel pending load if possible | Existing `useDrawing.clearAll` |
| `setHidden` | Store hidden state locally | Store hidden state and apply once loaded | Existing `useDrawing.setHidden` |
| `primitivesRef` | Stable ref with empty array | Stable ref with empty array until loaded | Existing primitive ref |
| `selectedPrimId` | `null` | `null` | Existing selected id |
| `selectedDrawingMeta` | `null` | `null` | Existing selected drawing metadata |
| `editingTextId` | `null` | `null` | Existing text edit id |
| `editingTextValue` | empty string | empty string | Existing text edit value |
| `editingTextPos` | `null` | `null` | Existing text edit position |
| `setEditingTextValue` | Stable no-op | Stable no-op until loaded | Existing setter |
| `commitTextEditing` | Return `false` | Return `false` until loaded | Existing commit function |
| `cancelTextEditing` | Stable no-op | Stable no-op until loaded | Existing cancel function |
| `editInputRef` | Stable ref with `null` | Stable ref with `null` | Existing input ref |
| `selectedTextSnapshot` | `null` | `null` | Existing selected text snapshot |
| `selectedTextBox` | `null` | `null` | Existing selected text box |
| `updateSelectedText` | Stable no-op | Stable no-op until loaded | Existing text style update |
| `updateSelectedDrawingStyle` | Stable no-op | Stable no-op until loaded | Existing drawing style update |
| `deleteSelected` | Stable no-op | Stable no-op until loaded | Existing delete selected |

These defaults let `ChartPane` render `TextEditOverlay` and `TextFormatBar`
conditionals unchanged: they simply receive null editing and selection state
until the real engine exists.

## Load Triggers

The real drawing engine should load when any of these are true:

1. The pane has saved drawings in localStorage for its drawing key.
2. The active tool is a drawing/editing tool rather than a passive cursor.
3. A drawing-related imperative call needs real state:
   `updateSelectedDrawingStyle`, `prepareExport` with saved drawings, or export
   with drawings visible and known saved drawings.
4. The user opens a workflow that must inspect or edit existing drawings.

Passive cursor tools should not load the engine by themselves:

- `cursor-default`
- `cursor-crosshair`
- `cursor-dot`
- `cursor-highlighter`
- `cursor-plain`

Drawing tools should load it:

- `pen`
- `highlighter`
- `eraser`
- line tools
- shape tools
- `text`
- `fibonacci`
- position tools
- angle measurement

## Saved Drawing Detection

Add a lightweight storage helper before implementation:

```js
hasSavedDrawings(symbolKey): boolean
```

It should only read and parse the existing localStorage key
`candlescope-drawings-${symbolKey}`. It must not import primitive classes.

`ChartPane` can compute the pane drawing key before controller creation:

- main: `drawingKeyBase || symbol`
- sub: `${drawingKeyBase || symbol}__${paneId}`

The controller uses `hasSavedDrawings(paneDrawingKey)` as an early load signal.
That keeps saved drawings from disappearing after refresh while still allowing
empty charts to avoid the heavy engine.

## Loading State

While the real engine chunk is loading:

- Keep the selected toolbar tool in app state.
- Keep the chart cursor/crosshair behavior driven by `drawingTool`, as today.
- Do not attach placeholder primitives.
- Ignore style edits until a selection exists.
- If the user starts a drawing gesture before the engine is ready, prevent the
  chart from creating a partial drawing. The first real drawing interaction
  should begin after the engine resolves.

The first implementation can use a short in-chart or toolbar loading affordance
only when the user actively selects a drawing tool. Saved-drawing restore can
load silently.

## Export Behavior

`prepareExport()` must keep committing active text edits before snapshot.

Rules:

- If the controller is no-op and `hasSavedDrawings` is false, `prepareExport`
  is a no-op and export can proceed.
- If saved drawings exist and the engine is not loaded, export should trigger
  or await engine loading before generating the snapshot.
- If the engine is loading due to a drawing tool activation, export should wait
  for loading to finish or show the existing export error path.
- `hideDrawings` must still call `setDrawingsHidden` through `MultiPaneChart`;
  hidden state should be replayed when the real engine loads.

## Text Editing

Text editing belongs entirely to the real engine.

- No-op and loading controllers return null text-edit state.
- `commitTextEditing()` returns `false` until the real engine is ready.
- If export triggers while text editing is active, the real controller must be
  available and `prepareExport()` must call the existing commit path.

This preserves current export behavior without forcing the text primitive code
into the first render path.

## Sub-Pane Differences

Sub-pane drawings have a different persistence key and a later anchor:

- Persistence key: `${drawingKeyBase || symbol}__${paneId}`
- Anchor series: first indicator series, not the candlestick series

The lazy controller should not instantiate the real engine for a sub-pane until
both conditions are satisfied:

1. The pane needs drawings because of saved drawings or active drawing tool.
2. The drawing anchor series is ready.

If a sub-pane is removed, `MultiPaneChart` should keep clearing the orphaned
storage key as it does today.

## Implementation Sequence

1. Add `hasSavedDrawings()` to `drawingStorage.js`.
2. Move the current `useDrawing` export behind a dynamically imported real
   engine module, without changing its public return shape.
3. Add `useDrawingController` as the adapter used by `ChartPane`.
4. Replace the direct `useDrawing` import in `ChartPane` with the controller.
5. Add smoke coverage before enabling the lazy path:
   - chart loads with no saved drawings
   - activating the line tool loads the real engine
   - saved drawing restore survives refresh
   - export calls `prepareExport` after text edit
6. Only after those checks pass, split primitive modules into the lazy chunk.

## Risks

- React hooks cannot be called conditionally. The real hook must live in a
  component or adapter layer that is only mounted after the lazy module loads.
- `useDrawing` currently owns DOM event listeners. Loading must happen before
  the first drawing gesture is handled.
- Export preview is asynchronous already, but it currently assumes
  `prepareExport()` is synchronous. Waiting for engine load may require a small
  async preparation step in the export runtime.
- Sub-pane anchors are created after indicator series, so eager saved-drawing
  restore in sub-panes can race if the controller ignores `seriesReady`.
- Existing primitive persistence formats must remain unchanged.

## Decision

Proceed with a controller boundary first, then lazy-load the real engine after
the contract is protected by smoke checks. Do not split primitive files directly
from `useDrawing` as the first change; that would reduce chunk size but leave
the lifecycle risks hidden inside `ChartPane`.
