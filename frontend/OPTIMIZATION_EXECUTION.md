# Frontend Optimization Execution Plan

This document turns the remaining frontend optimization work into staged,
verifiable execution steps. It assumes the current architecture in
[ARCHITECTURE.md](ARCHITECTURE.md): runtime hooks are grouped under
`src/runtime`, non-first-render panels are lazy-loaded, and vendor chunks are
split in `vite.config.js`.

## Current Baseline

Keep these numbers as the reference point before starting the next phase:

| Metric | Current baseline |
|---|---:|
| App main chunk | ~237 kB minified after Phase 1 instrumentation |
| React vendor chunk | ~195 kB minified |
| Lightweight Charts vendor chunk | ~158 kB minified |
| Initial smoke target | K-line bars > 0, live WebSocket, drawing toolbar, symbol search, Settings |
| Known remaining risk | Drawing engine and primitives are still attached to active chart panes |

Do not continue optimizing only by chunk size once the main app chunk stays
below the budget. The next phases should optimize measured ready time,
rendering cost, and long-term module ownership.

## Budget

Use these as guardrails:

| Area | Budget |
|---|---:|
| App main chunk | < 250 kB minified |
| Any lazy UI chunk | < 100 kB minified |
| First chart ready, local dev | target < 2 s |
| Live WebSocket ready, local dev | target < 3 s |
| Lazy panel first open | target < 500 ms after click |

If a change exceeds a budget, either revert it or document why the tradeoff is
intentional.

## Phase 1: Frontend Performance Instrumentation

Goal: make frontend slowness measurable before changing scheduling or rendering
behavior.

Add lightweight marks for:

- app boot start
- first history request dispatched
- first history response received
- chart data committed
- first non-zero bars rendered
- WebSocket live ready
- indicator compute start/end
- lazy chunk open start/end for Settings, symbol search, watchlist, drawing
  toolbar, export, alerts, and indicators

Implementation notes:

- Prefer a small module such as `src/runtime/performance/perfMarks.js`.
- Use `performance.mark()` / `performance.measure()` when available.
- Keep collection local and dependency-free.
- Do not send analytics from this phase.
- Extend `frontend/scripts/smoke.mjs` to include the resulting timings in its
  JSON report.

Acceptance:

- `npm run smoke -- --url http://127.0.0.1:5173/` prints timing fields.
- Smoke still fails on product breakage, not on optional timing fields.
- Docs list the measured baseline after one successful local run.

Measured baseline after implementation:

| Metric | Local smoke result |
|---|---:|
| Smoke chart loaded gate | 2,008 ms |
| Browser `chartReadyMs` mark | 546 ms |
| Browser `firstBarsMs` mark | 546 ms |
| Browser `wsLiveReadyMs` mark | 573 ms |
| Browser latest request duration | 394 ms |
| Browser history request duration | 521 ms |
| Browser symbol search open mark | 357 ms |
| Browser Settings open mark | 389 ms |
| Smoke bars loaded | 710 |

The smoke gate is intentionally coarser than the browser marks because it polls
DOM text and waits for the "connected + live" product state. In local dev,
React StrictMode can also duplicate mount-time events; use the latest mark
values for comparison and inspect the event list when debugging double loads.

## Phase 2: K-Line First Scheduling

Goal: make first K-line visibility the primary UI milestone. Indicators and
background repair can arrive later, but the main chart must not wait for them.

Check these paths:

- `useChartInitialLoad`
- `useKlineStreamRuntime`
- `useIndicators`
- `useChartBackgroundPrefetch`
- `useChartGapRecovery`
- visible range and left-load retry behavior

Rules:

- The first chart loading state belongs to main K-line data only.
- Indicator panes must not hold the main chart loading state open.
- Indicator recomputation after initial bars should use non-urgent scheduling
  where React supports it, for example `startTransition`.
- Frontend callers choose semantic endpoints such as `/history`, `/range`,
  `/history/before`, and `/latest`; backend scheduling owns raw priority.
- Backfill, prefetch, and repair UI should expose waiting state without
  pretending the HTTP request is still blocking.

Acceptance:

- Smoke timing shows `firstBarsMs` before indicator completion when indicators
  are enabled.
- Disabling indicators does not change the K-line loading control flow.
- Drag-left loading still preserves the existing `backfill_completed` retry
  behavior.

Implementation notes after Phase 2:

- Hosted indicator subscriptions now wait for `chartDataMeta.status === "ready"`
  instead of starting from the provisional quick-latest bars.
- Local indicator result commits are wrapped in `startTransition`, and
  provisional first-bar recomputes are delayed so the full history response can
  win when it arrives shortly after quick latest.
- Background prefetch and periodic gap recovery wait for the active chart to be
  ready; left-load and `backfill_completed` retry behavior is unchanged.
- Smoke seeds a small MA indicator in its temporary browser profile so the
  report verifies the "indicators enabled" path.

Measured baseline after Phase 2:

| Metric | Local smoke result |
|---|---:|
| Smoke chart loaded gate | 1,005 ms |
| Browser `firstBarsMs` mark | 242 ms |
| Browser `chartReadyMs` mark | 242 ms |
| Browser `wsLiveReadyMs` mark | 268 ms |
| Browser hosted indicator open mark | 352 ms |
| Browser hosted indicator snapshot mark | 4,751 ms |
| Smoke bars loaded | 722 |

## Phase 3: App Shell Extraction

Goal: keep `App.jsx` as a composition root rather than a large JSX owner.

Extract:

- `TopBar`
- `ChartWorkspace`
- `LazySurfaces`
- `StatusBar`

Rules:

- Do not move data ownership just to reduce file size.
- Props should be explicit and typed by behavior names where possible.
- Runtime hooks stay under `src/runtime`; UI components stay under
  `src/components`.
- Avoid creating a generic "context dump" provider unless there is a proven
  prop-drilling problem.

Acceptance:

- `App.jsx` mostly wires runtime hooks to shell components.
- No behavior change in smoke.
- The file split makes ownership clearer, not merely smaller.

Implementation notes after Phase 3:

- Added `components/app-shell/TopBar.jsx`, `ChartWorkspace.jsx`,
  `LazySurfaces.jsx`, and `StatusBar.jsx`.
- `App.jsx` still owns runtime hooks, refs, callbacks, and data derivation; the
  shell components only receive explicit UI and behavior props.
- Lazy panels remain lazy-loaded from the shell layer, while chart data
  ownership and backend endpoint selection stay in `App.jsx` and runtime hooks.
- Build baseline after extraction: app main chunk about 240 kB minified, still
  under the 250 kB budget.

## Phase 4: Drawing Engine Design

Goal: decide whether the drawing engine can be loaded only when needed without
breaking chart interactions.

Do not jump straight to implementation. First write a short design note that
answers:

- What is the minimal no-op drawing adapter that `ChartPane` can use?
- When should the real engine load?
- How are saved drawings detected before the engine is loaded?
- How do text editing, selection, style sync, hide/show, clear, and export work?
- How does a sub-pane drawing key differ from the main-pane drawing key?
- What should happen if the user activates a drawing tool while the engine is
  still loading?

Candidate interface:

```txt
ChartPane
  -> DrawingController
      -> noop drawing controller
      -> lazy real drawing controller
```

High-risk areas:

- `useDrawing.js`
- `components/primitives/*`
- `ChartPane` imperative handle
- export preparation and text-edit commit
- persisted drawing restore

Acceptance for design:

- A no-op controller can support the current `ChartPane` contract.
- The design lists every current `useDrawing` return value and maps it to
  no-op, loading, or real-engine behavior.
- Smoke coverage is expanded before implementation begins.

Acceptance for implementation, if approved:

- No saved-drawing regression.
- Drawing toolbar activation loads the real engine and keeps selected tool
  state.
- Export still commits text editing before snapshot.
- Main chart panning/zooming remains smooth.

Design note after Phase 4:

- Added [DRAWING_ENGINE_LAZY_LOAD_DESIGN.md](DRAWING_ENGINE_LAZY_LOAD_DESIGN.md).
- Current `ChartPane` imports `useDrawing` directly, which pulls the full
  drawing hook and primitive classes into the active chart module graph.
- The approved direction is a `DrawingController` boundary with no-op, loading,
  and real-engine states. The controller must preserve the complete current
  `useDrawing` return shape so `ChartPane` and `MultiPaneChart` contracts stay
  stable.
- Implementation should start with a storage-only `hasSavedDrawings()` helper
  and smoke coverage for tool activation, saved restore, and export text commit
  before any primitive chunk split.

Pre-implementation smoke coverage after Phase 4:

- `DrawingToolbar` exposes stable `data-drawing-tool` and
  `data-drawing-action` selectors for smoke tests and future lazy-load checks.
- `scripts/smoke.mjs --drawing-check` activates the line tool, draws on the
  main pane, verifies drawing persistence, reloads the page, and verifies the
  saved drawing is still present.
- Local result with `--drawing-check`: chart gate 1,002 ms, line tool active,
  persisted drawings 1, restored drawings 1, no network failures.

Implementation checkpoint after Phase 4 preflight:

- Added storage-only `hasSavedDrawings()` in `drawingStorage.js`.
- Added `useDrawingController` as the `ChartPane` drawing adapter boundary.
- `ChartPane` now computes a single pane drawing key and passes it through the
  controller, preserving the main/sub-pane key distinction documented above.

Implementation notes after Phase 4 lazy split:

- Added `DrawingEngineHost`, which owns the real `useDrawing` hook and text
  overlay rendering. `ChartPane` only mounts it when saved drawings exist or an
  active drawing tool requires the real engine.
- `ChartPane` keeps no-op imperative behavior for hidden drawings, clear,
  selected-style updates, and export preparation while the real engine is not
  mounted.
- Build result after the split: app main chunk about 146 kB minified;
  `DrawingEngineHost` lazy chunk about 89 kB minified. Both stay within budget.
- Local `--drawing-check` after lazy split: drawing engine ready true, line tool
  active true, persisted drawings 1, restored drawings 1, failures 0.

## Phase 5: Chart Rendering Update Cost

Goal: reduce runtime rendering cost after data arrives.

Investigate:

- whether K-line updates use full `setData()` when `update()` is enough
- whether `buildRenderableChartData` reruns on unrelated state changes
- whether `mainOverlayLines`, `subPanes`, fills, markers, and hlines have
  stable references
- whether visible-range restore causes avoidable chart resets
- whether indicator line updates recreate series unnecessarily

Rules:

- Prefer measured improvements over speculative memoization.
- Do not hide real data freshness bugs behind memoization.
- Keep Lightweight Charts ownership inside chart components, not runtime hooks.

Acceptance:

- Smoke still passes.
- Manual pan/zoom and interval switch remain stable.
- Performance report shows lower chart update time or fewer full resets.

Implementation notes after Phase 5 first pass:

- Added chart render perf events for candle and indicator series operations:
  `chart.candleSeries.setData`, `chart.candleSeries.update`,
  `chart.indicatorSeries.setData`, and `chart.indicatorSeries.update`.
- The main K-line path already used `update()` for normal trailing changes; it
  now records whether each render pass was a full replace or trailing update.
- Indicator lines now use a conservative trailing-update fast path. They only
  call `series.update()` when all stable historical points are unchanged and
  the change is limited to the last point or one appended point. Parameter
  recomputes, history changes, and middle-data changes still use `setData()`.
- Local smoke after this pass: bars 721, connected true, live true, failures 0,
  chartReadyMs 305, firstBarsMs 305. Series event counts: candle `setData` 2,
  candle `update` 3, indicator `setData` 1.
- Local `--drawing-check` also passed after the `ChartPane` changes: drawing
  engine ready true, persisted drawings 1, restored drawings 1, failures 0.

Implementation notes after Phase 5 barcolor pass:

- Barcolor overlays now keep their previous colored candle data and use a
  conservative trailing `update()` path when the colored history is stable.
  They still use `setData()` for first apply, clear, history changes, or any
  middle-candle color/value change.
- Local smoke after this pass: bars 722, connected true, live true, failures 0,
  chartReadyMs 793, firstBarsMs 793. Series event counts: candle `setData` 2,
  candle `update` 2, indicator `setData` 5, indicator `update` 7.
- Local `--drawing-check` still passed: drawing engine ready true, persisted
  drawings 1, restored drawings 1, failures 0.

## Phase 6: Interaction Preloading

Goal: remove first-click delay from lazy UI only if users feel it.

Candidates:

- preload symbol search on hover/focus of `#symbol-selector`
- preload Settings on hover/focus of settings button
- preload drawing toolbar immediately after first chart ready if the current
  network/cache profile makes it noticeable

Rules:

- Do not preload every lazy chunk at boot.
- Prefer intent-based preload: hover, focus, keyboard shortcut, or idle after
  first bars.
- Keep smoke able to prove the lazy surface still opens.

Acceptance:

- Lazy panel first-open time improves.
- First chart ready time does not regress.

Implementation notes after Phase 6:

- Added shared lazy surface loaders for Settings, Indicator Panel, and Alerts
  so the same dynamic import functions can be used by both `React.lazy()` and
  interaction preloads.
- `#symbol-selector` and the settings button now preload their lazy chunks on
  pointer hover, mouse hover, and focus. The preload stays intent-based and does
  not move those panels back into the boot path.
- Smoke now triggers the same intent events before measuring the click-to-open
  path for symbol search and Settings. This keeps the test aligned with the
  real interaction path instead of measuring a cold lazy import every time.
- Local validation after the preload pass: app main chunk about 148 kB
  minified, `DrawingEngineHost` lazy chunk about 89 kB, Settings lazy chunk
  about 82 kB, SymbolSearch lazy chunk about 11 kB. Smoke passed with bars 722,
  connected true, live true, failures 0, chartReadyMs 2,580, firstBarsMs 2,580,
  symbolSearchOpenMs 506, settingsOpenMs 521.

## Phase 7: Measurement Quality and Overlay Rendering

Goal: make the next optimization pass measurable below the coarse smoke polling
floor, then continue chart rendering work with evidence.

First checkpoint:

- Replace lazy-surface smoke timing that depended on 500 ms DOM polling with
  waits against app-owned performance marks.
- Keep DOM visibility checks as product assertions, but use
  `settingsOpenMs`, `symbolSearchOpenMs`, and `drawingToolbarReadyMs` from the
  browser performance report for timing.
- Keep the hosted-indicator wait on the existing slower polling interval; that
  path waits for backend/runtime work rather than a sub-500 ms UI interaction.

Acceptance for the measurement checkpoint:

- Script-level lint passes.
- Build stays within existing chunk budgets.
- When backend and Vite are available, smoke reports lazy-surface timings that
  can fall below 500 ms.

Implementation notes after Phase 7 measurement checkpoint:

- `scripts/smoke.mjs` now supports configurable polling for
  `waitForPerfTiming()` and adds `waitForExpression()` for DOM assertions.
- Settings, symbol search, and drawing toolbar readiness now use perf-report
  timings where available, with DOM checks preserved to catch product breakage.
- Local validation: smoke script eslint passed; Vite build passed with app main
  chunk about 148 kB minified. End-to-end smoke was not run because neither
  Vite on `127.0.0.1:5173` nor the backend on `127.0.0.1:8000` was running.

Second checkpoint:

- Add render events around the chart surfaces that were still opaque after the
  candle and indicator-line work.
- Keep this pass instrumentation-only. Do not change fill, marker, hline, or
  background overlay update strategy until the events show which path is
  actually hot.

Implementation notes after Phase 7 overlay instrumentation:

- `ChartPane` now records lifecycle events for indicator series create/remove,
  marker set/clear, hline create/remove, fill-series create/remove, and
  bgcolor canvas overlay create/remove/render.
- Event details include pane id, definition counts, created/removed series
  counts, marker counts, fill point counts, and visible bgcolor region counts.
- Local validation: `eslint src/components/ChartPane.jsx` passed; Vite build
  passed with app main chunk about 149 kB minified. End-to-end smoke was not
  run because the local backend/Vite services were not running.

## Verification Commands

Use repository-local commands:

```bash
cd frontend
npm run lint
npm run build
npm run smoke -- --url http://127.0.0.1:5173/
```

On this Windows Codex environment, if `npm` or `node` is not available on
`PATH`, use the bundled Node executable:

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/
```

For smoke, start the backend with UTF-8 output on Windows if needed:

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Commit Strategy

Use small checkpoints:

1. instrumentation only
2. K-line-first scheduling only
3. App shell extraction only
4. drawing design document only
5. drawing engine implementation, if approved
6. rendering-cost optimizations

Each commit should include its validation output in the final summary.

## Stop Conditions

Stop and reassess when:

- chart panning or zooming regresses
- saved drawings fail to restore
- smoke timing becomes flaky
- frontend starts assigning backend raw scheduling priority
- a change only reduces source line count without improving ownership,
  performance, or verification
