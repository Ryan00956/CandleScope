# Drawing Engine V2 performance baselines

This directory stores the curated, reviewable JSON checkpoints produced by
`frontend/scripts/drawing-performance.mjs`.

## What is versioned

- `baseline-*.json` files are intentional before/after checkpoints. They must
  include the Git commit and dirty state, browser build, viewport, DPR, bar
  count, drawing-engine mode, fixture metadata, raw per-run samples, warm-up
  policy, summarized percentiles, and acceptance decisions.
- This README documents the stable evidence contract.

Ad-hoc runs, traces, screenshots, and failed exploratory samples should use a
different filename prefix and remain local. Do not overwrite a reviewed
baseline with a later run; create a new file so regressions stay explainable.

## Required run shape

- production build and preview;
- deterministic local mock API, not an external exchange connection;
- viewport `1440 x 900`;
- at least five measured runs per scenario after warm-up;
- fixtures for zero drawings, one 4096-point freehand, 64 x 512-point
  freehands, 200 entities, and 512 entities;
- active freehand, hover, continuous wheel, pan, mouseup, and reload/restore
  coverage;
- rAF intervals, Long Tasks, Event Timing, ScriptDuration, heap, drawing-local
  counters, and worker queue depth when available.

From `frontend/`, run the default deterministic baseline with:

```powershell
npm.cmd run perf:drawing
```

The runner builds the production bundle before starting its deterministic mock
API and Vite preview. On PowerShell, pass custom runner arguments through
`npm.cmd`, for example:

```powershell
npm.cmd run perf:drawing -- --smoke --headless --scenarios empty-viewport
npm.cmd run perf:drawing -- --bars 10000 --dpr 1.5 --headless
```

`--smoke` is explicitly non-Phase-0: it may validate a subset and exit zero,
but its JSON can never satisfy `phase0Acceptance`. A formal run requires all
six scenarios, one warm-up plus at least five measured repetitions, complete
raw capture, clean diagnostics, and successful real reload/restore checks.

The active 4096-pointer scenario starts with 200 persisted entities so mouseup
can add and reload the new stroke without exceeding the current 512-entity
codec limit. The separate 512-entity mixed scenario still exercises that hard
cap. `fixture.points` is the total canonical point count, not only freehand
points.

Use `--enforce-targets` only after a phase is expected to satisfy the V2 target
budgets. The initial legacy baseline is expected to miss target performance;
it passes Phase 0 when the harness is valid and reproduces the documented heavy
scene and active-stroke regressions.
