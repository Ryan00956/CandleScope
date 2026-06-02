# Frontend Cleanup Execution Plan

This document defines the next frontend cleanup phase for the temporary
frontend optimization worktree. This worktree is not an independent frontend
repository. Its changes are expected to merge back into the main
`H:\program\CandleScope` project.

Do not spend this phase removing `backend/`, `packages/`, or top-level
full-stack documentation from the worktree. Treat those paths as inherited
project context unless a merge-specific change explicitly requires touching
them.

## Goals

- Keep `App.jsx` as the composition root and avoid moving ownership back into
  it.
- Reduce the largest frontend modules by ownership, not by source-line count.
- Make UI components depend less directly on backend services, storage, and
  performance internals.
- Keep exchange-specific behavior driven by backend capabilities wherever the
  backend contract already exists.
- Preserve the current performance wins from the previous optimization phases.
- Keep every slice easy to merge back into the main CandleScope repository.

## Current Baseline

The current architecture is already acceptable enough to build on:

- `src/runtime` owns orchestration for chart data, streams, exchange metadata,
  preferences, workflows, and performance.
- `src/components/app-shell` owns top-level layout surfaces and lazy UI wiring.
- `src/services` owns API and storage primitives.
- Same-origin `/api/v1` is the default API base, with Vite proxying `/api` to
  the backend in local development.
- `eslint .` and `vite build` pass with the bundled Node runtime on this
  Windows machine.

The remaining work is cleanup and boundary hardening, not a new architecture
rewrite.

## Non-Goals

- Do not convert this worktree into a standalone frontend repository.
- Do not remove backend or package directories from this worktree.
- Do not introduce a large global state library only to reduce prop passing.
- Do not move Lightweight Charts object ownership out of chart components
  without measured evidence.
- Do not add frontend hardcoding for new exchange behavior that belongs in a
  backend plugin capability.

## Phase 1: Settings Modal Decomposition

Goal: turn `SettingsModal.jsx` into a shell for focused settings panels.

Suggested split:

| New unit | Ownership |
|---|---|
| `SettingsModal.jsx` | modal frame, tab state, close behavior |
| `settings/ProxySettingsPanel.jsx` | proxy mode, custom proxy, proxy test |
| `settings/ExchangeDataPanel.jsx` | exchange metadata refresh and status |
| `settings/StorageMaintenancePanel.jsx` | repair and gap-scan actions |
| `settings/CacheLimitsPanel.jsx` | cache limit controls |
| `settings/ChartAppearancePanel.jsx` | theme, colors, timezone, chart display |
| `runtime/preferences/useSettingsActions.js` | backend-backed settings actions |

Rules:

- Keep visual layout behavior unchanged.
- Move backend calls out of the presentational panels when practical.
- Keep mock-backed or local-only maintenance flows clearly named; do not make
  them look backend-backed unless the endpoint is verified.
- Prefer small props over a single broad `settingsContext` object.

Acceptance:

- Settings still opens through the lazy surface.
- Proxy test, exchange refresh, storage repair/gap scan, and cache-limit sync
  keep their current behavior.
- `SettingsModal.jsx` no longer owns every settings form and backend action.
- `eslint .` and `vite build` pass.

Checkpoint after first implementation slice:

- Added `settings/ChartAppearancePanel.jsx`,
  `settings/ProxySettingsPanel.jsx`, and `settings/ExchangeSettingsPanel.jsx`.
- Added `runtime/preferences/useProxySettingsRuntime.js` and
  `runtime/exchange/useExchangeSettingsRuntime.js`.
- `SettingsModal.jsx` now keeps the category shell and the remaining data,
  database, and about sections, while proxy and exchange backend actions moved
  to runtime hooks.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after data-section split:

- Added `settings/CacheLimitsPanel.jsx`,
  `settings/StorageMaintenancePanel.jsx`, and
  `settings/AboutSettingsPanel.jsx`.
- Added `runtime/preferences/useSettingsMaintenanceRuntime.js` for storage
  repair, gap scan, and exchange symbol refresh actions.
- `SettingsModal.jsx` no longer imports settings backend action services or
  symbol parsing helpers directly. It now mounts focused panels and keeps
  category state plus modal chrome.
- `SettingsModal.jsx` shrank from 2,676 lines at the start of Phase 1 to 1,713
  lines after this checkpoint. The remaining line count is mostly modal style
  definitions and the existing database tools panel mount.
- Validation passed with bundled Node: `eslint .` and `vite build`.

## Phase 2: Indicator Runtime Split

Goal: split `useIndicators.js` by responsibility while preserving the current
indicator user experience.

Suggested split:

| New unit | Ownership |
|---|---|
| `runtime/indicators/useActiveIndicators.js` | local persistence and list mutations |
| `runtime/indicators/useIndicatorCompute.js` | compute requests and recompute scheduling |
| `runtime/indicators/useIndicatorSnapshots.js` | hosted snapshot and stream handling |
| `runtime/indicators/useIndicatorChartBindings.js` | chart refs, pane targets, and output mapping |
| `runtime/indicators/indicatorComputeRuntime.js` | pure compute input/result shaping |
| `runtime/indicators/indicatorPayloadRuntime.js` | payload, annotation, merge, and signature helpers |
| `runtime/indicators/indicatorPaneRuntime.js` | pure pane-output derivation |
| `runtime/indicators/indicatorWsRuntime.js` | hosted subscription, signature, and range message helpers |
| `runtime/chart/indicatorRangeRuntime.js` | keep range request chunking here |

Rules:

- Keep K-line readiness independent from indicator readiness.
- Keep built-in and Pyne/custom indicator paths visible in the names of helper
  functions.
- Do not mix chart series ownership into service clients.
- Preserve the existing localStorage migration behavior for active indicators.

Acceptance:

- Existing indicators add/remove/toggle/update/recompute correctly.
- Hosted indicator snapshots still arrive after `chartDataMeta.status ===
  "ready"`.
- MA/VOL smoke coverage still passes.
- Overlay-heavy smoke remains available for rendering lifecycle checks.

Checkpoint after active-indicator split:

- Added `runtime/indicators/useActiveIndicators.js`.
- Active indicator localStorage loading/saving, first-load VOL insertion, and
  add/remove/toggle/params/script mutations moved out of `useIndicators.js`.
- `useIndicators.js` still owns compute, hosted snapshots, chart-output
  mapping, and runtime result patches; it keeps `setActiveIndicators` available
  for those paths.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after payload-runtime split:

- Added `runtime/indicators/indicatorPayloadRuntime.js`.
- Indicator error formatting, builtin/WS-hosted detection, payload
  normalization, annotation splitting, line/item merging, WS value resolution,
  and point upsert helpers moved out of `useIndicators.js`.
- `useIndicators.js` still owns React state, effects, WebSocket lifecycle,
  compute scheduling, and pane output state updates.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after pane/signature runtime split:

- Added `runtime/indicators/indicatorPaneRuntime.js` for pure
  `mainOverlayLines` and `subPanes` derivation.
- Moved chart data signatures, provisional-status detection, and script string
  signatures into `indicatorPayloadRuntime.js`.
- `useIndicators.js` now delegates pane derivation and data signatures to runtime
  helpers while keeping the React effect scheduling in place.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after compute-runtime helper split:

- Added `runtime/indicators/indicatorComputeRuntime.js`.
- Moved OHLCV request shaping, VOL color parameter injection, and local compute
  result aggregation into pure runtime helpers.
- Reused the same VOL color parameter helper for hosted subscriptions and local
  compute requests to avoid drift between the two paths.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after hosted-WS helper split:

- Added `runtime/indicators/indicatorWsRuntime.js`.
- Moved visible hosted-indicator filtering, WS signature construction,
  subscription message construction, subscription signature construction, and
  range request message shaping out of `useIndicators.js`.
- Kept socket lifecycle, reconnect handling, sequence-gap resubscribe, and
  runtime state patches in `useIndicators.js`.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after hosted-WS message dispatch split:

- Added parse, sequence-gap state resolution, and typed message dispatch helpers
  to `runtime/indicators/indicatorWsRuntime.js`.
- `useIndicators.js` now keeps the WebSocket effect lifecycle and timers, while
  delegating message parsing, heartbeat/client checks, snapshot/patch/update/error
  routing, and sequence-gap detection to runtime helpers.
- Runtime state patch handlers still live in `useIndicators.js`, so this step
  does not change snapshot, patch, preview/update, or error side effects.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after compute-scheduling helper split:

- Moved candle color key construction, indicator mutation signatures, VOL
  presence checks, compute debounce/provisional delay selection, and series-ready
  compute delay selection into `runtime/indicators/indicatorComputeRuntime.js`.
- `useIndicators.js` still owns the compute effects and actual `computeAll`
  invocation, but no longer inlines the pure scheduling decisions.
- Preserved the existing provisional-data performance event semantics.
- Validation passed with bundled Node: `eslint .` and `vite build`.

## Phase 3: Drawing Ownership Cleanup

Goal: reduce the size and coupling of drawing code without regressing saved
drawings or export preparation.

Suggested split:

| New unit | Ownership |
|---|---|
| `hooks/drawing/useDrawingPersistence.js` | saved drawing load/save/restore coordination |
| `hooks/drawing/useDrawingInteraction.js` | pointer interaction and active shape lifecycle |
| `hooks/drawing/useDrawingSelection.js` | selection, style sync, hide/show, clear |
| `components/drawing/DrawingToolGroup.jsx` | grouped toolbar sections |
| `components/drawing/DrawingStyleControls.jsx` | style controls for selected tools |

Rules:

- Keep the existing `useDrawingController` boundary intact.
- Keep `DrawingEngineHost` lazy and mounted only when needed.
- Preserve drawing keys for main and sub-pane drawings.
- Keep export text-edit commit behavior unchanged.

Acceptance:

- `scripts/smoke.mjs --drawing-check` passes when backend and Vite are running.
- Saved drawings restore after reload.
- Activating a drawing tool still loads the real drawing engine.
- Export preparation still commits active text editing.

Checkpoint after toolbar flyout split:

- Added `components/drawing/ToolFlyout.jsx`.
- Moved the shared variant flyout rendering and outside-click close behavior out
  of `DrawingToolbar.jsx`.
- Kept drawing state, selected variant state, export controls, and chart/runtime
  integration inside the existing toolbar and drawing runtime.
- Normalized drawing toolbar variant labels and tooltips to ASCII text while
  repairing encoding-corrupted JSX produced during the split.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after toolbar settings-panel split:

- Added `components/drawing/FibLevelsPanel.jsx` and
  `components/drawing/PositionSettingsPanel.jsx`.
- Moved Fibonacci level editing, custom level insertion, default-level checks,
  and position size presets out of `DrawingToolbar.jsx`.
- Kept toolbar-owned flyout state and drawing tool selection in
  `DrawingToolbar.jsx`; the new panels only manage their local form state and
  outside-click close behavior.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after toolbar style-controls split:

- Added `components/drawing/DrawingStyleControls.jsx`.
- Moved pen/highlighter color and size controls, line/shape/fibonacci style
  controls, text color/font/bold/italic controls, and the position-size trigger
  out of `DrawingToolbar.jsx`.
- Kept style mutation handlers in `DrawingToolbar.jsx` so selected-drawing style
  synchronization and default drawing style updates still share the existing
  callback path.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after toolbar action-buttons split:

- Added `components/drawing/DrawingActionButtons.jsx`.
- Moved export, hide/show, and clear button rendering plus their icons out of
  `DrawingToolbar.jsx`.
- Kept the export click wrapper in `DrawingToolbar.jsx` so opening the export
  panel still closes any active flyout before delegating to the existing export
  panel callback.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after toolbar variant-button split:

- Added `components/drawing/DrawingVariantToolButton.jsx`.
- Moved the repeated wrapper/button/flyout structure for chart type, cursor,
  freehand, line, shape, and position variants out of `DrawingToolbar.jsx`.
- Kept all click, double-click, context-menu, variant-selection, and flyout-open
  state handlers in `DrawingToolbar.jsx`, preserving the existing tool-selection
  timing.
- Kept Fibonacci settings on the toolbar-owned path because it opens a custom
  settings panel instead of a regular variant flyout.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after toolbar simple-button split:

- Added `components/drawing/DrawingToolButton.jsx`.
- Moved the remaining simple wrapper/button structure for eraser, text,
  Fibonacci, and snap controls out of `DrawingToolbar.jsx`.
- Moved the shared corner-triangle indicator into drawing button components.
- Kept Fibonacci context-menu and double-click handlers in `DrawingToolbar.jsx`
  so the custom settings-panel open behavior remains unchanged.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after toolbar definitions split:

- Added `components/drawing/drawingToolbarDefinitions.jsx`.
- Moved static SVG icons, chart-type variants, drawing variant lists, and
  tool-id sets out of `DrawingToolbar.jsx`.
- `DrawingToolbar.jsx` now imports definitions and keeps tool state, click
  timing, flyout state, and style mutation callbacks.
- Removed stale mojibake comments from the touched toolbar area and normalized
  fallback labels to ASCII.
- Validation passed with bundled Node: `eslint .`, `vite build`, and
  `git diff --check`.

Checkpoint after toolbar controller split:

- Added `components/drawing/useDrawingToolbarController.js`.
- Moved toolbar-only variant state, flyout state, button refs, click timers,
  active-tool booleans, current icon/label derivation, and click/context-menu
  handlers out of `DrawingToolbar.jsx`.
- Kept selected-drawing style mutation and render composition in
  `DrawingToolbar.jsx`, so default style updates and selected drawing updates
  still flow through the existing callbacks.
- Validation passed with bundled Node: `eslint .`, `vite build`, and
  `git diff --check`.

## Phase 4: Component Boundary Hardening

Goal: make components more presentational where the surrounding runtime already
has a natural owner.

Candidates:

- Move symbol search data loading out of `SymbolSearchModal.jsx` into a runtime
  hook.
- Move indicator catalog/security-policy loading out of panel/editor components
  into indicator runtime hooks.
- Replace component-owned performance marks with callbacks or small runtime
  hooks where that reduces coupling.
- Keep chart components as chart owners; do not blindly remove their runtime
  imports when those imports are chart-specific helpers.

Acceptance:

- Components still receive explicit props rather than a broad app context dump.
- Runtime modules do not render JSX.
- Service modules remain HTTP/WebSocket/storage primitives.
- No product behavior changes are introduced in this phase.

Checkpoint after symbol catalog runtime split:

- Added `runtime/exchange/useSymbolCatalogRuntime.js`.
- Moved symbol catalog initial load, refresh flow, loading state, refreshing
  state, and exchange/market/key enrichment out of `SymbolSearchModal.jsx`.
- `SymbolSearchModal.jsx` still owns local search filters, favorites,
  keyboard/list interaction, context menu state, and watchlist rendering.
- Updated modal reset/clamp effects to schedule state changes asynchronously so
  the current React lint gate remains clean.
- Validation passed with bundled Node: `eslint .` and `vite build`.

Checkpoint after indicator catalog/security runtime split:

- Added `runtime/indicators/useIndicatorCatalogRuntime.js`.
- Moved built-in preset loading, custom indicator loading, catalog
  normalization, full-preset resolution for chart insertion, and custom catalog
  upsert/remove helpers out of `IndicatorPanel.jsx`.
- Added `runtime/indicators/usePyneSecurityPolicy.js` and moved the editor
  security-policy fetch out of `IndicatorEditor.jsx`.
- `IndicatorPanel.jsx` still owns active indicator actions, save/delete service
  mutations, editor navigation, and visible UI grouping.
- Guarded the catalog hook with a loaded ref so an empty preset response does
  not trigger repeated first-open loads.
- Validation passed with bundled Node: `eslint .` and `vite build`.

## Phase 5: API Client Hardening

Goal: make the API layer easier to cancel, test, and extend.

Implementation path:

1. Extend the internal `request()` helper to accept `{ method, headers, body,
   signal }`.
2. Introduce a small `ApiError` that carries `status`, `detail`, and `url`.
3. Convert remaining manual query strings to `URLSearchParams`.
4. Pass `AbortController.signal` through initial history/latest requests where
   stale request cancellation is already modeled.
5. Keep WebSocket URL builders in the service layer.

Rules:

- Do not change endpoint paths or backend scheduling semantics.
- Do not make the frontend assign raw backend priority.
- Keep the same-origin `/api/v1` default.

Acceptance:

- Stale initial loads do not commit data after abort.
- Existing settings, subscriptions, symbols, klines, and indicator calls keep
  their behavior.
- Error messages remain useful in the UI.

Checkpoint after API request helper hardening:

- Added `ApiError` in `services/api.js` with `status`, `detail`, and `url`.
- Extended the internal `request()` helper to accept `method`, `headers`,
  `body`, and `signal`, and to JSON-encode plain request bodies.
- Converted repeated write-operation `fetch` blocks in `services/api.js` to use
  the shared helper.
- Converted kline, exchange-info, storage maintenance, and kline WebSocket URL
  query construction to shared `URLSearchParams` helpers.
- Threaded `AbortController.signal` through initial latest/history loads and
  initial history retry in `useChartInitialLoad.js`.
- Validation passed with bundled Node: `eslint .` and `vite build`.

## Phase 6: Exchange Fallback Narrowing

Goal: keep the frontend fallback tables as startup resilience, not as the
primary source of exchange truth.

Implementation path:

1. Document which fields must come from `GET /api/v1/exchanges/`.
2. Use backend `native_intervals`, `markets`, `protocol_features`,
   `ws_connection_model`, and `known_limitations` whenever present.
3. If backend capabilities later expose default history windows or pagination
   hints, move `intervalDays` decisions to those capabilities.
4. Keep the local Binance/OKX interval table only for capability load failure
   and first-render fallback.

Acceptance:

- Adding a new exchange still starts from a backend plugin.
- Frontend interval UI follows backend metadata.
- Fallback behavior remains stable if the backend capability request fails.

Checkpoint after exchange fallback narrowing:

- `exchangeCatalogRuntime.js` now records whether interval history-window days
  came from backend capabilities or local fallback.
- `getIntervalDays(interval, exchange, catalog)` now accepts the backend
  exchange catalog and prefers optional capability-provided history-window maps
  when present.
- Current Binance/OKX `intervalDays` values remain as fallback-only behavior
  for capability load failure or backends that do not expose history windows.
- `App.jsx` now passes an exchange-catalog-bound `getIntervalDays` function to
  initial load, backfill completion, WS reconnect recovery, and gap recovery.
- Validation passed with bundled Node: `eslint .` and `vite build`.

## Phase 7: Merge-Back Preparation

Goal: make this worktree safe to merge into `H:\program\CandleScope`.

Checklist:

- Rebase or merge from the latest main CandleScope branch before the final
  validation pass.
- Review diffs under `frontend/` first; backend/package diffs should be absent
  unless explicitly intended.
- Keep frontend docs linked from `frontend/README.md`.
- Update both English and Chinese docs when a stable architecture rule changes.
- Run the repository-local frontend gates.
- If possible, run browser smoke with backend and Vite services up.

Final validation commands:

```powershell
cd H:\program\CandleScope-frontend\frontend
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
```

When backend and Vite are running:

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/ --drawing-check
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/ --overlay-heavy
```

Checkpoint after merge-back validation pass:

- Confirmed the diff scope is confined to `frontend/` in this worktree.
- Confirmed cleanup docs are linked from `frontend/README.md`.
- Re-ran the frontend gates with bundled Node: `eslint .`, `vite build`, and
  `git diff --check`.
- Browser smoke was run against the original backend in `H:\program\CandleScope`
  and this frontend worktree's Vite dev server: base smoke, `--drawing-check`,
  and `--overlay-heavy` all passed.
- `git diff --check` only reported Windows LF/CRLF normalization warnings, with
  no whitespace errors.

## Commit Strategy

Use small checkpoints:

1. Settings panel decomposition.
2. Indicator runtime split.
3. Drawing internals cleanup.
4. Component boundary hardening.
5. API client hardening.
6. Exchange fallback narrowing.
7. Documentation and merge-back validation.

Each commit summary should include:

- files or ownership area changed
- validation commands run
- smoke status, if available
- any intentionally deferred risk

## Stop Conditions

Stop and reassess when:

- first K-line readiness starts waiting on indicators or background repair
- saved drawings fail to restore
- chart pan/zoom or interval switching regresses
- Settings actions become harder to trace than before the split
- the frontend starts duplicating backend exchange plugin policy
- a change only moves code without improving ownership, testability, or merge
  safety
