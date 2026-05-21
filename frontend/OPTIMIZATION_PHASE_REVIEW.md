# Frontend Optimization Phase Review

This review records the state after the Phase 1-6 optimization sequence on
`codex/frontend-chart-runtime`. The detailed execution log remains in
[OPTIMIZATION_EXECUTION.md](OPTIMIZATION_EXECUTION.md).

## Status

The original optimization plan is implemented through Phase 6.

| Phase | Result |
|---|---|
| Performance instrumentation | Done. Smoke reports frontend timing marks and chart-series render events. |
| K-line-first scheduling | Done. Initial K-line readiness is no longer gated by hosted indicators or background repair. |
| App shell extraction | Done. `App.jsx` is a composition root, while shell components own top-level UI layout. |
| Drawing engine boundary | Done. The real drawing engine is loaded through `DrawingEngineHost` only when saved drawings or active tools require it. |
| Chart rendering update cost | Partially done. Candles, barcolor overlays, and indicator lines now use conservative trailing update paths where safe. |
| Interaction preloading | Done for the highest-value lazy surfaces: symbol search and Settings. |

## Current Shape

- `src/runtime` owns app orchestration by domain: chart, streams, exchange,
  preferences, workflows, and performance.
- `src/components/app-shell` owns top-level layout surfaces and lazy UI wiring.
- `ChartPane` still owns Lightweight Charts objects and series lifecycle. This
  is intentional; rendering ownership has not been moved into runtime hooks.
- Drawing no longer forces the full drawing hook and primitives into the first
  chart module path. The chart mounts `DrawingEngineHost` only after a saved
  drawing or selected tool makes it necessary.
- Lazy UI remains lazy at boot. Symbol search and Settings use intent-based
  preload on hover/focus so normal first render stays small.

## Budget Snapshot

Latest local validation recorded in the execution doc:

| Area | Latest result |
|---|---:|
| App main chunk | ~148 kB minified |
| `DrawingEngineHost` lazy chunk | ~89 kB minified |
| Settings lazy chunk | ~82 kB minified |
| SymbolSearch lazy chunk | ~11 kB minified |
| Smoke bars | 722 |
| Smoke failures | 0 |

The main bundle and lazy chunks are inside the documented budgets. First chart
ready remains environment-sensitive because local backend readiness, cache
depth, and smoke polling all affect the number. Use trend comparisons from the
same machine instead of treating one local run as a universal benchmark.

## Remaining Risks

- `ChartPane` is still dense. It is safer now, but future work should split
  internals only after a measured reason appears.
- The current smoke measurement for lazy panels has a 500 ms polling floor, so
  `~500 ms` open numbers mean "visible by the first poll" rather than exact
  interaction latency.
- Fills, markers, hlines, and overlay lifecycle still need the same measured
  treatment that candles and indicator lines received.
- Manual interaction coverage is still important for pan/zoom, interval switch,
  drawing selection, text editing, and export preparation.
- Performance budgets are documented but not yet enforced in CI.

## Recommended Next Phase

Start Phase 7 with measurement quality, then continue rendering work:

1. Replace coarse lazy-surface smoke polling with a finer DOM-ready or perf-mark
   wait so click-to-open timing is meaningful below 500 ms.
2. Add render events for fills, markers, hlines, and overlay series lifecycle.
3. Use those events to identify avoidable full resets before changing chart
   structure.
4. Only after the measurements point at `ChartPane` structure as the problem,
   split it into small chart-owned helpers such as series managers or overlay
   controllers.
5. Consider a CI artifact for smoke timing snapshots once the timing collection
   is precise enough.

## Phase 7 Progress

The first measurement-quality checkpoint is implemented:

- Lazy-surface smoke waits now read app-owned performance timings instead of
  deriving open latency from the 500 ms DOM polling loop.
- DOM visibility checks remain in place as product assertions.
- Script-level lint and production build passed locally.

The next Phase 7 step is to add render events around fills, markers, hlines,
and overlay series lifecycle, then use those events to decide whether any
additional `ChartPane` internals should be split.

The overlay instrumentation checkpoint is now implemented:

- `ChartPane` records lifecycle events for indicator series, markers, hlines,
  fill area series, and bgcolor canvas overlays.
- Smoke reports now include `performanceEventSummary`, so event frequency can
  be compared without manually scanning the raw performance event list.
- The pass is intentionally observational. It does not change rendering
  strategy, so the next decision can be based on event frequency and point
  counts rather than source-code shape alone.

The first measured cleanup reduced repeated empty marker clears:

- Baseline smoke reported `chart.markerSeries.clear: 37` with no marker data.
- `ChartPane` now remembers when a target series is already marker-empty.
- Follow-up smoke reported `chart.markerSeries.clear: 6` with no product
  failures.
