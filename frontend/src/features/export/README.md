# Export Feature

`features/export` owns screenshot export options, preview generation, save actions, and the lazy export panel UI.

## Public Contract

`useExportRuntime(props)` exposes:

```js
{
  view: {
    isOpen,
    options,
    error,
    notice,
    preview,
    metadata,
  },
  actions: {
    updateOptions,
    togglePanel,
    closePanel,
    exportChart,
  },
  status: {
    inProgress,
  },
}
```

## Internal Ownership

- `exportOptionsStore.js` owns persisted export option loading and saving.
- `exportPreviewRuntime.js` owns debounced preview rendering and preview object URL lifecycle.
- `exportService.js` owns DOM capture, canvas finalization, filename generation, and browser download.
- `ExportPanel.jsx` and `ExportPreviewPanel.jsx` are the lazy-loaded export UI surface.

## Allowed Dependencies

- May receive the chart surface ref while export snapshot support is still exposed by `MultiPaneChart`.
- May receive `pageExportRef` for page-scope export capture.
- May receive `session.view` metadata for filenames and watermarks.
- May call drawing runtime actions to prepare text edits and temporarily hide or restore drawings.
- May use shared export filename utilities.

## Forbidden Dependencies

- Do not import App internals or sibling feature internals other than the drawing runtime public contract passed in by the caller.
- Do not mutate drawing state directly with App-owned setters.
- Do not load candles, indicators, watchlist prices, settings actions, alerts, or market data here.
- Do not persist options from UI components; route option changes through the feature runtime.

## Migration Notes

The chart surface still exposes `prepareExport`, `setDrawingsHidden`, and `getExportSnapshot` through the existing chart ref. A later chart-adapter pass can replace that ref with an explicit export adapter without changing the feature UI.