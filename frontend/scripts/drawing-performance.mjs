import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildDrawingFixture,
  DEFAULT_FIXTURE_OPTIONS,
  fixtureTimeOffsetDenominator,
} from "./drawing-performance-fixtures.mjs";
import {
  buildDrawingPerformanceReport,
  DRAWING_PERFORMANCE_HARD_GATES,
  evaluateGates,
  stableStringify,
} from "./drawing-performance-metrics.mjs";
import {
  PHASE4_CROSSHAIR_MOVE_COUNT,
  PHASE4_REQUIRED_SCENARIO_IDS,
  buildPhase4Acceptance,
} from "./drawing-performance-phase4.mjs";
import {
  PHASE5_POINTER_SAMPLE_COUNT,
  PHASE5_REQUIRED_SCENARIO_IDS,
  PHASE5_SCENARIO_IDS,
  buildPhase5Acceptance,
} from "./drawing-performance-phase5.mjs";
import { phase5BrowserProbeBootstrap } from "./drawing-performance-phase5-browser.mjs";
import {
  PHASE6_BAR_COUNT,
  PHASE6_HIT_QUERY_COUNT,
  PHASE6_REQUIRED_SCENARIO_IDS,
  PHASE6_LINEAGE_VIEWPORT_SCENARIO,
  PHASE6_SCENARIO_IDS,
  buildPhase6HitQueryPoints,
  buildPhase6Acceptance,
  normalizePhase6PanePlotRect,
} from "./drawing-performance-phase6.mjs";
import {
  phase6ActionRequiresCurrentPaint,
  phase6BrowserProbeBootstrap,
  phase6SceneReadiness,
  waitForPhase6ActionCurrentPaint,
} from "./drawing-performance-phase6-browser.mjs";
import { buildDrawingPerformanceMockBars } from "./drawing-performance-mock-data.mjs";
import {
  buildPhase6LineageFixtureContract,
  phase6LineageSettings,
} from "./drawing-performance-phase6-lineage.mjs";
import {
  navigateToDrawingPerformanceScenario,
  reloadFreshDrawingPerformanceDocument,
} from "./drawing-performance-storage.mjs";
import {
  assessDrawingEngineDomEvidence,
  drawingEngineDomEvidenceBrowserSnapshot,
  formatDrawingEngineDomEvidenceFailure,
  shouldRequireDrawingEngineDomEvidenceForPerformance,
  summarizeDrawingEngineDomEvidenceAssessments,
} from "./drawing-engine-dom-evidence.mjs";
import {
  assessDrawingSoak,
  DRAWING_SOAK_DEFAULTS,
  DRAWING_SOAK_FIXED_CONTRACT,
  isFormalDrawingSoakConfiguration,
  normalizeDrawingSoakRuntimeEvidence,
  phase9MeasuredWorkloadDeadline,
  selectPhase9SoakDueAction,
} from "./drawing-soak-metrics.mjs";
import { createDrawingInputPaintFenceTracker } from "./drawing-performance-input-fence.mjs";
import { runDrawingEventLatencyCalibration } from "./drawing-event-latency-calibration.mjs";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const DEFAULT_MOCK_END_TIME = 1_783_987_200;
const PHASE0_MIN_MEASURED_RUNS = 5;
const PHASE0_MIN_WARMUP_RUNS = 1;
const PHASE0_POINTER_SAMPLES = 4_096;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANAGED_BUILD_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  VITE_API_BASE: "/api/v1",
  VITE_DRAWING_COORDINATE_PROJECTOR: "batch",
  VITE_DRAWING_DOCUMENT_AUTHORITY: "document",
});
const PHASE0_REQUIRED_SCENARIO_IDS = Object.freeze([
  "empty-viewport",
  "single-freehand-4096-viewport",
  "freehand-64x512-viewport",
  "entities-200-mixed",
  "entities-512-mixed",
  "active-freehand-4096",
]);
const DEFAULT_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "empty-viewport",
    fixture: "empty",
    action: "viewport",
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs", "eventTimingMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: "single-freehand-4096-viewport",
    fixture: "singleFreehand4096",
    action: "viewport",
    requiredMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "eventTimingMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
    ],
    targetCounters: ["surfacePrimitiveCount", "requestUpdatePerFrame", "workerQueueDepth"],
  }),
  Object.freeze({
    id: "freehand-64x512-viewport",
    fixture: "freehand64x512",
    action: "viewport",
    requiredMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "eventTimingMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
    ],
    targetCounters: [
      "staticProjectionCount",
      "surfacePrimitiveCount",
      "requestUpdatePerFrame",
      "workerQueueDepth",
    ],
  }),
  Object.freeze({
    id: "entities-200-mixed",
    fixture: "entities200",
    action: "mixed",
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs", "eventTimingMs", "hitQueryMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs", "hitQueryMs"],
    targetCounters: ["surfacePrimitiveCount", "workerQueueDepth"],
  }),
  Object.freeze({
    id: "entities-512-mixed",
    fixture: "entities512",
    action: "mixed",
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs", "eventTimingMs", "hitQueryMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs", "hitQueryMs"],
    targetCounters: ["surfacePrimitiveCount", "workerQueueDepth"],
  }),
  Object.freeze({
    id: "active-freehand-4096",
    // Leave room below MAX_SAVED_DRAWINGS (512) for the stroke finalized by
    // this scenario; the separate entities-512 scenario covers the hard cap.
    fixture: "entities200",
    action: "active-freehand",
    requiredMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "eventTimingMs",
      "mouseupSyncMs",
      "persistenceMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "workerFinalizeMs",
      "persistenceMs",
      "exactRenderMs",
      "activeOverlayCpuMs",
    ],
    targetCounters: [
      "surfacePrimitiveCount",
      "requestUpdatePerFrame",
      "workerQueueDepth",
    ],
  }),
  Object.freeze({
    id: "phase4-migrated-64-viewport",
    fixture: "phase4Migrated64",
    action: "viewport",
    requiredMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "inputToNextPaintMs", "eventTimingMs"],
    targetMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "inputToNextPaintMs"],
    targetCounters: ["surfacePrimitiveCount", "requestUpdatePerFrame"],
  }),
  Object.freeze({
    id: "phase4-mixed-64-viewport",
    fixture: "phase4Mixed64",
    action: "viewport",
    requiredMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "inputToNextPaintMs", "eventTimingMs"],
    targetMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "inputToNextPaintMs"],
    // The mixed primitive count has a fixture-derived expectation and is
    // checked by Phase 4 acceptance rather than the global fixed-to-one gate.
    targetCounters: ["requestUpdatePerFrame"],
  }),
  Object.freeze({
    id: "phase4-crosshair-1000",
    fixture: "phase4Migrated64",
    action: "crosshair",
    // Synthetic passive mouse moves do not reliably emit PerformanceEventTiming
    // entries in headless Chromium; input-to-paint and the explicit 1000-move
    // action evidence remain mandatory.
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs"],
    targetCounters: [
      "staticProjectionCount",
      "sceneRebuildCount",
      "surfacePrimitiveCount",
      "requestUpdatePerFrame",
    ],
  }),
  Object.freeze({
    id: "phase4-freehand-64-viewport",
    fixture: "freehand64x512",
    action: "viewport",
    requiredMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs", "eventTimingMs"],
    targetMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs"],
    // Freehand is deliberately still legacy in Phase 4, so the exact count is
    // one scene primitive plus 64 legacy primitives, not the global one gate.
    targetCounters: ["requestUpdatePerFrame"],
  }),
  Object.freeze({
    id: PHASE5_SCENARIO_IDS.pen,
    fixture: "freehand64x512",
    action: "phase5-pen",
    // Exercise 4096 active samples over the full 64x512 scene, then clear the
    // maxed aggregate fixture and commit a second legal 4096-point stroke.
    expectedEntityDelta: -63,
    expectedTypeDeltas: Object.freeze({ freehand: -63 }),
    // The interaction draft receives 4096 samples; persistence may apply the
    // canonical final simplifier before serialization, so stored point count
    // is not used as a proxy for input coverage.
    minimumFinalPointCount: 1,
    requiredMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs", "mouseupSyncMs", "activeOverlayCpuMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: PHASE5_SCENARIO_IDS.highlighter,
    fixture: "freehand64x512",
    action: "phase5-highlighter",
    expectedEntityDelta: -63,
    expectedTypeDeltas: Object.freeze({ freehand: -64, highlighter: 1 }),
    minimumFinalPointCount: 1,
    requiredMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs", "mouseupSyncMs", "activeOverlayCpuMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: PHASE5_SCENARIO_IDS.dragResize,
    fixture: "empty",
    action: "phase5-drag-resize",
    expectedEntityDelta: 1,
    expectedTypeDeltas: Object.freeze({ line: 1 }),
    minimumPointDelta: 2,
    requiredMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs", "mouseupSyncMs", "activeOverlayCpuMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: PHASE5_SCENARIO_IDS.twoPoint,
    fixture: "empty",
    action: "phase5-two-point",
    expectedEntityDelta: 1,
    expectedTypeDeltas: Object.freeze({ line: 1 }),
    minimumPointDelta: 2,
    requiredMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs", "mouseupSyncMs", "activeOverlayCpuMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: PHASE5_SCENARIO_IDS.eraserCancel,
    fixture: "empty",
    action: "phase5-eraser-cancel",
    expectedEntityDelta: 1,
    expectedTypeDeltas: Object.freeze({ line: 1 }),
    minimumPointDelta: 2,
    requiredMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: ["drawingMainThreadMs", "frameIntervalMs", "inputToNextPaintMs", "mouseupSyncMs", "activeOverlayCpuMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: PHASE6_SCENARIO_IDS.freehandZoomPan,
    fixture: "freehand64x512",
    action: "phase6-viewport",
    requiredMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    targetMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    targetCounters: [
      "surfacePrimitiveCount",
      "workerQueueDepth",
      "workerInFlight",
      "staleWorkerPublishCount",
    ],
  }),
  PHASE6_LINEAGE_VIEWPORT_SCENARIO,
  Object.freeze({
    id: PHASE6_SCENARIO_IDS.hitIndex,
    fixture: "entities512",
    action: "phase6-hit-index",
    requiredMetrics: ["hitQueryMs"],
    targetMetrics: ["hitQueryMs"],
    targetCounters: [
      "surfacePrimitiveCount",
      "workerQueueDepth",
      "workerInFlight",
      "staleWorkerPublishCount",
    ],
  }),
  Object.freeze({
    id: PHASE6_SCENARIO_IDS.activeFinalize,
    fixture: "freehand64x512",
    action: "phase6-active-finalize",
    expectedEntityDelta: -63,
    expectedTypeDeltas: Object.freeze({ freehand: -63 }),
    minimumFinalPointCount: 1,
    requiredMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "workerFinalizeMs",
      "exactRenderMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "workerFinalizeMs",
      "exactRenderMs",
    ],
    targetCounters: [
      "surfacePrimitiveCount",
      "workerQueueDepth",
      "workerInFlight",
      "staleWorkerPublishCount",
    ],
  }),
  Object.freeze({
    id: PHASE6_SCENARIO_IDS.workerBackpressure,
    fixture: "freehand64x512",
    action: "phase6-worker-backpressure",
    requiredMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    // Fault injection deliberately delays exact completion. Keep the sample
    // mandatory to prove convergence, but do not apply the normal 120 ms SLO.
    targetMetrics: ["sceneProjectPaintMs", "frameIntervalMs"],
    targetCounters: [
      "surfacePrimitiveCount",
      "workerQueueDepth",
      "workerInFlight",
      "staleWorkerPublishCount",
    ],
  }),
  Object.freeze({
    id: PHASE6_SCENARIO_IDS.mainThreadFallback,
    fixture: "freehand64x512",
    action: "phase6-main-thread-fallback",
    requiredMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    targetMetrics: ["sceneProjectPaintMs", "frameIntervalMs", "exactRenderMs"],
    targetCounters: [
      "surfacePrimitiveCount",
      "workerQueueDepth",
      "workerInFlight",
      "staleWorkerPublishCount",
    ],
  }),
]);

function parseNumber(value, label, { min = 0, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(label + " must be " + (integer ? "an integer" : "a number") + " >= " + min);
  }
  return parsed;
}

function parsePhase(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const phase = normalized === "phase9-soak"
    ? "phase9"
    : /^\d+$/.test(normalized) ? `phase${normalized}` : normalized;
  if (!["phase0", "phase1", "phase3", "phase4", "phase5", "phase6", "phase9"].includes(phase)) {
    throw new Error("--phase must be phase0, phase1, phase3, phase4, phase5, phase6, or phase9");
  }
  return phase;
}

function parseArgs(argv) {
  let scenariosExplicit = false;
  let dprExplicit = false;
  let barsExplicit = false;
  let engineModeExplicit = ["legacy", "shadow", "scene-canary", "scene"].includes(
    process.env.VITE_DRAWING_ENGINE_MODE,
  );
  let interactionSurfaceModeExplicit = ["overlay", "legacy"].includes(
    process.env.VITE_DRAWING_INTERACTION_OVERLAY,
  );
  const args = {
    url: "",
    out: "",
    compareBefore: "",
    chromePath: process.env.CHROME_PATH || "",
    bars: 1_500,
    dpr: 1,
    runs: 5,
    warmupRuns: 1,
    seed: DEFAULT_FIXTURE_OPTIONS.seed,
    mockEndTime: DEFAULT_MOCK_END_TIME,
    intervalSeconds: 3_600,
    wheelEvents: 60,
    hoverEvents: 240,
    pointerSamples: PHASE5_POINTER_SAMPLE_COUNT,
    settleMs: 750,
    timeoutMs: 45_000,
    headless: false,
    smoke: false,
    phase: "phase0",
    engineMode: ["legacy", "shadow", "scene-canary", "scene"].includes(
      process.env.VITE_DRAWING_ENGINE_MODE,
    ) ? process.env.VITE_DRAWING_ENGINE_MODE : "legacy",
    interactionSurfaceMode: interactionSurfaceModeExplicit
      ? process.env.VITE_DRAWING_INTERACTION_OVERLAY
      : null,
    rasterBackend: null,
    enforceTargets: false,
    soakConfiguration: { ...DRAWING_SOAK_DEFAULTS },
    // Preserve the historical phase0/1/3 default set. Phase 4 and Phase 5
    // replace it below with their own formal matrices.
    scenarios: DEFAULT_SCENARIOS
      .map((scenario) => scenario.id)
      .filter((id) => !PHASE5_REQUIRED_SCENARIO_IDS.includes(id)
        && !PHASE6_REQUIRED_SCENARIO_IDS.includes(id)),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = String(argv[++index] || "");
    else if (arg === "--out") args.out = String(argv[++index] || "");
    else if (arg === "--compare-before") args.compareBefore = String(argv[++index] || "");
    else if (arg === "--chrome") args.chromePath = String(argv[++index] || "");
    else if (arg === "--bars") {
      args.bars = parseNumber(argv[++index], "--bars", { min: 2, integer: true });
      barsExplicit = true;
    }
    else if (arg === "--dpr") {
      args.dpr = parseNumber(argv[++index], "--dpr", { min: 0.5 });
      dprExplicit = true;
    }
    else if (arg === "--runs") args.runs = parseNumber(argv[++index], "--runs", { min: 1, integer: true });
    else if (arg === "--warmup-runs") {
      args.warmupRuns = parseNumber(argv[++index], "--warmup-runs", { min: 0, integer: true });
    } else if (arg === "--seed") {
      args.seed = parseNumber(argv[++index], "--seed", { min: 0, integer: true });
    } else if (arg === "--mock-end-time") {
      args.mockEndTime = parseNumber(argv[++index], "--mock-end-time", { min: 1, integer: true });
    } else if (arg === "--interval-seconds") {
      args.intervalSeconds = parseNumber(argv[++index], "--interval-seconds", { min: 1, integer: true });
    } else if (arg === "--wheel-events") {
      args.wheelEvents = parseNumber(argv[++index], "--wheel-events", { min: 1, integer: true });
    } else if (arg === "--hover-events") {
      args.hoverEvents = parseNumber(argv[++index], "--hover-events", { min: 1, integer: true });
    } else if (arg === "--pointer-samples") {
      args.pointerSamples = parseNumber(argv[++index], "--pointer-samples", { min: 2, integer: true });
    } else if (arg === "--settle-ms") {
      args.settleMs = parseNumber(argv[++index], "--settle-ms", { min: 0, integer: true });
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = parseNumber(argv[++index], "--timeout-ms", { min: 1_000, integer: true });
    } else if (arg === "--soak-duration-ms") {
      args.soakConfiguration.durationMs = parseNumber(
        argv[++index],
        "--soak-duration-ms",
        { min: 1_000, integer: true },
      );
    } else if (arg === "--soak-warmup-ms") {
      args.soakConfiguration.warmupMs = parseNumber(
        argv[++index],
        "--soak-warmup-ms",
        { min: 0, integer: true },
      );
    } else if (arg === "--soak-required-ms") {
      args.soakConfiguration.requiredMeasuredDurationMs = parseNumber(
        argv[++index],
        "--soak-required-ms",
        { min: 1_000, integer: true },
      );
    } else if (arg === "--soak-sample-ms") {
      args.soakConfiguration.sampleIntervalMs = parseNumber(
        argv[++index],
        "--soak-sample-ms",
        { min: 100, integer: true },
      );
    } else if (arg === "--soak-gc-interval-ms") {
      args.soakConfiguration.gcIntervalMs = parseNumber(
        argv[++index],
        "--soak-gc-interval-ms",
        { min: 500, integer: true },
      );
    } else if (arg === "--soak-workload-interval-ms") {
      args.soakConfiguration.workloadIntervalMs = parseNumber(
        argv[++index],
        "--soak-workload-interval-ms",
        { min: 250, integer: true },
      );
    } else if (arg === "--soak-comparison-window-ms") {
      args.soakConfiguration.comparisonWindowMs = parseNumber(
        argv[++index],
        "--soak-comparison-window-ms",
        { min: 100, integer: true },
      );
    } else if (arg === "--soak-max-sample-gap-ms") {
      args.soakConfiguration.maxSampleGapMs = parseNumber(
        argv[++index],
        "--soak-max-sample-gap-ms",
        { min: 100, integer: true },
      );
    } else if (arg === "--soak-min-sample-coverage") {
      args.soakConfiguration.minSampleCoverage = parseNumber(
        argv[++index],
        "--soak-min-sample-coverage",
        { min: 0 },
      );
    } else if (arg === "--soak-min-gc-checkpoints") {
      args.soakConfiguration.minGcCheckpoints = parseNumber(
        argv[++index],
        "--soak-min-gc-checkpoints",
        { min: 1, integer: true },
      );
    } else if (arg === "--soak-min-viewport-revisions") {
      args.soakConfiguration.minDistinctViewportRevisions = parseNumber(
        argv[++index],
        "--soak-min-viewport-revisions",
        { min: 1, integer: true },
      );
    } else if (arg === "--soak-max-heap-delta-pct") {
      args.soakConfiguration.maxHeapDeltaPct = parseNumber(
        argv[++index],
        "--soak-max-heap-delta-pct",
        { min: 0 },
      );
    } else if (arg === "--soak-max-heap-slope-pct-per-hour") {
      args.soakConfiguration.maxHeapSlopePctPerHour = parseNumber(
        argv[++index],
        "--soak-max-heap-slope-pct-per-hour",
        { min: 0 },
      );
    } else if (arg === "--soak-heap-slope-noise-floor-bytes-per-hour") {
      args.soakConfiguration.heapSlopeNoiseFloorBytesPerHour = parseNumber(
        argv[++index],
        "--soak-heap-slope-noise-floor-bytes-per-hour",
        { min: 1 },
      );
    } else if (arg === "--soak-terminal-plateau-pct") {
      args.soakConfiguration.terminalPlateauPct = parseNumber(
        argv[++index],
        "--soak-terminal-plateau-pct",
        { min: 0 },
      );
    } else if (arg === "--soak-terminal-plateau-noise-floor-bytes") {
      args.soakConfiguration.terminalPlateauNoiseFloorBytes = parseNumber(
        argv[++index],
        "--soak-terminal-plateau-noise-floor-bytes",
        { min: 1 },
      );
    } else if (arg === "--soak-plateau-window-size") {
      args.soakConfiguration.plateauWindowSize = parseNumber(
        argv[++index],
        "--soak-plateau-window-size",
        { min: 1, integer: true },
      );
    } else if (arg === "--scenarios") {
      args.scenarios = String(argv[++index] || "").split(",").map((value) => value.trim()).filter(Boolean);
      scenariosExplicit = true;
    } else if (arg === "--phase") {
      args.phase = parsePhase(argv[++index]);
    } else if (arg.startsWith("--phase=")) {
      args.phase = parsePhase(arg.slice("--phase=".length));
    } else if (arg === "--engine-mode") {
      const mode = String(argv[++index] || "");
      if (!["legacy", "shadow", "scene-canary", "scene"].includes(mode)) {
        throw new Error("--engine-mode must be legacy, shadow, scene-canary, or scene");
      }
      args.engineMode = mode;
      engineModeExplicit = true;
    } else if (arg === "--interaction-surface-mode") {
      const mode = String(argv[++index] || "");
      if (!["overlay", "legacy"].includes(mode)) {
        throw new Error("--interaction-surface-mode must be overlay or legacy");
      }
      args.interactionSurfaceMode = mode;
      interactionSurfaceModeExplicit = true;
    } else if (arg === "--raster-backend") {
      const backend = String(argv[++index] || "");
      if (!["worker", "main-thread"].includes(backend)) {
        throw new Error("--raster-backend must be worker or main-thread");
      }
      args.rasterBackend = backend;
    } else if (arg === "--headless") args.headless = true;
    else if (arg === "--smoke") args.smoke = true;
    else if (arg === "--enforce-targets") args.enforceTargets = true;
    else throw new Error("Unknown argument: " + arg);
  }

  if (!scenariosExplicit && args.phase === "phase4") {
    args.scenarios = [...PHASE4_REQUIRED_SCENARIO_IDS];
  }
  if (!scenariosExplicit && args.phase === "phase5") {
    args.scenarios = [...PHASE5_REQUIRED_SCENARIO_IDS];
  }
  if (!scenariosExplicit && args.phase === "phase6") {
    args.scenarios = [...PHASE6_REQUIRED_SCENARIO_IDS];
  }
  if (args.phase === "phase9") {
    if (args.url) throw new Error("Phase 9 soak requires the managed production build/mock server");
    if (args.smoke) throw new Error("Phase 9 soak uses explicit --soak-* short-run parameters, not --smoke");
    if (args.headless) throw new Error("Phase 9 soak requires a headed visible browser window");
    args.scenarios = [PHASE6_SCENARIO_IDS.freehandZoomPan];
    args.bars = PHASE6_BAR_COUNT;
    args.dpr = 1.5;
    args.engineMode = "scene-canary";
    args.interactionSurfaceMode = "overlay";
    args.rasterBackend = "worker";
    if (args.seed !== DEFAULT_FIXTURE_OPTIONS.seed) {
      throw new Error(`Phase 9 soak requires the fixed fixture seed ${DEFAULT_FIXTURE_OPTIONS.seed}`);
    }
    if (args.intervalSeconds !== 3_600) {
      throw new Error("Phase 9 soak requires the fixed 3600-second source interval");
    }
    if (args.mockEndTime !== DEFAULT_MOCK_END_TIME) {
      throw new Error(`Phase 9 soak requires the fixed mock end time ${DEFAULT_MOCK_END_TIME}`);
    }
    if (args.soakConfiguration.minSampleCoverage > 1) {
      throw new Error("--soak-min-sample-coverage must be <= 1");
    }
    if (args.soakConfiguration.durationMs
      < args.soakConfiguration.warmupMs
        + args.soakConfiguration.requiredMeasuredDurationMs) {
      throw new Error("Phase 9 soak duration must cover warmup plus the required measured window");
    }
  }
  if (args.phase === "phase5" && !dprExplicit) args.dpr = 1.5;
  if (args.phase === "phase5" && !engineModeExplicit) {
    args.engineMode = "scene-canary";
  }
  if (args.phase === "phase5" && !interactionSurfaceModeExplicit) {
    args.interactionSurfaceMode = "overlay";
  }
  if (args.phase === "phase6") {
    if (!barsExplicit) args.bars = PHASE6_BAR_COUNT;
    if (!engineModeExplicit) args.engineMode = "scene-canary";
    if (!interactionSurfaceModeExplicit) args.interactionSurfaceMode = "overlay";
    if (args.rasterBackend === null) args.rasterBackend = "worker";
  }

  const knownScenarioIds = new Set(DEFAULT_SCENARIOS.map((scenario) => scenario.id));
  for (const scenarioId of args.scenarios) {
    if (!knownScenarioIds.has(scenarioId)) {
      throw new Error("Unknown scenario " + scenarioId + ". Known scenarios: "
        + Array.from(knownScenarioIds).join(", "));
    }
  }
  if (args.scenarios.length === 0) throw new Error("At least one scenario is required");
  return args;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error("HTTP " + response.statusCode + " for " + url));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await httpJson(url);
    } catch (error) {
      lastError = error;
      await wait(200);
    }
  }
  throw lastError || new Error("Timed out waiting for " + url);
}

function captureProcessOutput(child) {
  const lines = [];
  const capture = (chunk) => {
    const text = String(chunk || "").trim();
    if (!text) return;
    lines.push(...text.split(/\r?\n/));
    if (lines.length > 80) lines.splice(0, lines.length - 80);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return lines;
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(timeoutMs),
  ]);
}

async function removeDirectoryWithRetries(directory, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        console.warn("Could not remove temporary Chrome profile: " + error.message);
        return;
      }
      await wait(200 * (attempt + 1));
    }
  }
}

function findChrome(explicitPath) {
  const candidates = [
    explicitPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function waitForDebugTarget(port, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await httpJson("http://127.0.0.1:" + port + "/json");
      if (Array.isArray(targets) && targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await wait(200);
  }
  throw lastError || new Error("Timed out waiting for Chrome debug target");
}

async function connectWebSocket(wsUrl) {
  if (!globalThis.WebSocket) {
    throw new Error("This Node.js runtime does not expose global WebSocket");
  }
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to CDP")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error: " + (event.message || "unknown")));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  let closedError = null;
  const rejectPending = (error) => {
    if (closedError === null) closedError = error;
    for (const deferred of pending.values()) {
      clearTimeout(deferred.timer);
      deferred.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(deferred.timer);
      if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else deferred.resolve(message);
      return;
    }
    if (!message.method) return;
    for (const handler of handlers.get(message.method) || []) handler(message.params, message);
  });
  socket.addEventListener("close", (event) => {
    rejectPending(new Error("CDP websocket closed (code=" + event.code
      + (event.reason ? ", reason=" + event.reason : "") + ")"));
  });
  socket.addEventListener("error", (event) => {
    rejectPending(new Error("CDP websocket error: " + (event.message || "unknown")));
  });

  return {
    send(method, params = {}, sessionId = null) {
      if (closedError) return Promise.reject(closedError);
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("CDP websocket is not open for " + method));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Timed out waiting for CDP command " + method));
        }, 60_000);
        pending.set(id, { resolve, reject, timer, method });
        try {
          socket.send(JSON.stringify({
            id,
            method,
            params,
            ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
          }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    close() {
      rejectPending(new Error("CDP websocket closed by the drawing performance runner"));
      socket.close();
    },
  };
}

function isDrawingWorkerTarget(targetInfo) {
  if (targetInfo?.type !== "worker") return false;
  const identity = [targetInfo.title, targetInfo.url].filter(Boolean).join(" ");
  return /(candlescope-drawing-worker|drawing(?:\.worker|-worker))/i.test(identity);
}

async function createDrawingWorkerHeapTracker(cdp) {
  const sessions = new Map();
  const register = (sessionId, targetInfo) => {
    if (typeof sessionId !== "string" || !isDrawingWorkerTarget(targetInfo)) return;
    const current = sessions.get(sessionId);
    if (current) {
      current.targetInfo = targetInfo;
      return;
    }
    const record = {
      sessionId,
      targetInfo,
      error: null,
      ready: null,
    };
    record.ready = Promise.all([
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("HeapProfiler.enable", {}, sessionId),
    ]).catch((error) => {
      record.error = error instanceof Error ? error.message : String(error);
    });
    sessions.set(sessionId, record);
  };
  const removeAttached = cdp.on("Target.attachedToTarget", (event) => {
    register(event?.sessionId, event?.targetInfo);
  });
  const removeDetached = cdp.on("Target.detachedFromTarget", (event) => {
    if (typeof event?.sessionId === "string") sessions.delete(event.sessionId);
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  const refresh = async () => {
    const response = await cdp.send("Target.getTargets");
    const trackedTargetIds = new Set(Array.from(
      sessions.values(),
      (record) => record.targetInfo?.targetId,
    ));
    for (const targetInfo of response.result?.targetInfos || []) {
      if (!isDrawingWorkerTarget(targetInfo)
        || trackedTargetIds.has(targetInfo.targetId)
        || targetInfo.attached === true) continue;
      const attached = await cdp.send("Target.attachToTarget", {
        targetId: targetInfo.targetId,
        flatten: true,
      });
      register(attached.result?.sessionId, targetInfo);
    }
  };

  const readyRecords = async () => {
    await refresh();
    const records = Array.from(sessions.values());
    await Promise.all(records.map((record) => record.ready));
    const initializationError = records.find((record) => record.error !== null);
    if (initializationError) {
      throw new Error("Drawing worker CDP initialization failed: " + initializationError.error);
    }
    return records;
  };

  return Object.freeze({
    async waitForWorker(timeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        const records = await readyRecords();
        if (records.length > 0) return this.targets();
        await wait(50);
      }
      throw new Error("Timed out waiting for the named drawing worker CDP target");
    },
    targets() {
      return Array.from(sessions.values(), (record) => ({
        sessionId: record.sessionId,
        targetId: record.targetInfo?.targetId ?? null,
        type: record.targetInfo?.type ?? null,
        title: record.targetInfo?.title ?? null,
        url: record.targetInfo?.url ?? null,
      }));
    },
    async readHeap() {
      const records = await readyRecords();
      if (records.length === 0) throw new Error("Drawing worker heap target is not visible");
      return Promise.all(records.map(async (record) => {
        const response = await cdp.send("Runtime.getHeapUsage", {}, record.sessionId);
        const heap = response.result || {};
        return {
          sessionId: record.sessionId,
          targetId: record.targetInfo?.targetId ?? null,
          title: record.targetInfo?.title ?? null,
          url: record.targetInfo?.url ?? null,
          usedSize: heap.usedSize ?? null,
          totalSize: heap.totalSize ?? null,
          embedderHeapUsedSize: heap.embedderHeapUsedSize ?? null,
          backingStorageSize: heap.backingStorageSize ?? null,
        };
      }));
    },
    async collectGarbage() {
      const records = await readyRecords();
      if (records.length === 0) throw new Error("Drawing worker GC target is not visible");
      await Promise.all(records.map((record) => (
        cdp.send("HeapProfiler.collectGarbage", {}, record.sessionId)
      )));
    },
    dispose() {
      removeAttached();
      removeDetached();
    },
  });
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = response.result?.result;
  if (result?.subtype === "error") {
    throw new Error(result.description || result.value || "Runtime.evaluate failed");
  }
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text || "Runtime.evaluate exception");
  }
  return result?.value;
}

async function evaluateJson(cdp, functionSource) {
  const value = await evaluate(cdp, "JSON.stringify((" + functionSource + ")())");
  return typeof value === "string" ? JSON.parse(value) : null;
}

async function readDrawingEngineDomEvidence(cdp, args) {
  const raw = await evaluateJson(cdp, drawingEngineDomEvidenceBrowserSnapshot);
  return assessDrawingEngineDomEvidence(raw, {
    required: shouldRequireDrawingEngineDomEvidenceForPerformance(args),
  });
}

function metricMap(response) {
  return Object.fromEntries((response?.result?.metrics || []).map((metric) => [metric.name, metric.value]));
}

function metricDelta(before, after, name) {
  const left = Number(before?.[name]);
  const right = Number(after?.[name]);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.max(0, right - left) : null;
}

function managedBuildEnvironment(
  engineMode,
  interactionSurfaceMode = null,
  rasterBackend = null,
) {
  const environment = {
    ...MANAGED_BUILD_ENVIRONMENT,
    VITE_DRAWING_ENGINE_MODE: engineMode,
  };
  if (interactionSurfaceMode === "overlay" || interactionSurfaceMode === "legacy") {
    environment.VITE_DRAWING_INTERACTION_OVERLAY = interactionSurfaceMode;
  }
  if (rasterBackend === "worker" || rasterBackend === "main-thread") {
    environment.VITE_DRAWING_RASTER_BACKEND = rasterBackend;
  }
  return environment;
}

function managedBuildProcessEnvironment(
  engineMode,
  interactionSurfaceMode = null,
  rasterBackend = null,
) {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith("VITE_")));
  return {
    ...inherited,
    ...managedBuildEnvironment(engineMode, interactionSurfaceMode, rasterBackend),
  };
}

function ensureProductionBuild(engineMode, interactionSurfaceMode = null, rasterBackend = null) {
  const viteBin = path.join(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  execFileSync(process.execPath, [viteBin, "build"], {
    cwd: FRONTEND_ROOT,
    env: managedBuildProcessEnvironment(engineMode, interactionSurfaceMode, rasterBackend),
    stdio: "inherit",
    windowsHide: true,
  });
}

async function startManagedServers(args) {
  if (!fs.existsSync(path.join(FRONTEND_ROOT, "dist", "index.html"))) {
    throw new Error("Production build missing. Run npm run build before perf:drawing.");
  }
  const apiPort = await freePort();
  const previewPort = await freePort();
  const api = spawn(process.execPath, [path.join(FRONTEND_ROOT, "scripts", "mock-api.mjs")], {
    cwd: FRONTEND_ROOT,
    env: {
      ...process.env,
      PORT: String(apiPort),
      CANDLESCOPE_MOCK_BAR_COUNT: String(args.bars),
      CANDLESCOPE_MOCK_INTERVAL_SECONDS: String(args.intervalSeconds),
      CANDLESCOPE_MOCK_END_TIME: String(args.mockEndTime),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const apiLogs = captureProcessOutput(api);
  const viteBin = path.join(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  const preview = spawn(process.execPath, [
    viteBin,
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(previewPort),
    "--strictPort",
  ], {
    cwd: FRONTEND_ROOT,
    env: {
      ...process.env,
      VITE_API_PROXY_TARGET: "http://127.0.0.1:" + apiPort,
      VITE_DEV_PORT: String(previewPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const previewLogs = captureProcessOutput(preview);

  try {
    const mockMeta = await waitForHttp("http://127.0.0.1:" + apiPort + "/__mock__/meta");
    await waitForHttp("http://127.0.0.1:" + previewPort + "/api/v1/exchanges/");
    return {
      url: "http://127.0.0.1:" + previewPort + "/",
      mockMeta,
      async close() {
        await stopProcess(preview);
        await stopProcess(api);
      },
    };
  } catch (error) {
    await stopProcess(preview);
    await stopProcess(api);
    throw new Error(error.message + "\nMock API:\n" + apiLogs.join("\n")
      + "\nVite preview:\n" + previewLogs.join("\n"));
  }
}

function browserBenchmarkBootstrap(payload, createInputFenceTracker) {
  window.__CANDLESCOPE_DRAWING_PERF_CONFIG__ = Object.freeze({
    benchmarkRawCapture: payload.benchmarkRawCapture !== false,
    rawCaptureCapacity: 20_000,
    phase6ForceMainThreadFallback: payload.phase6ForceMainThreadFallback === true,
    phase6WorkerDelayMs: Number.isFinite(payload.phase6WorkerDelayMs)
      ? Math.max(0, payload.phase6WorkerDelayMs)
      : 0,
  });
  try {
    localStorage.setItem(payload.storageKey, payload.raw);
    localStorage.setItem("candlescope-settings", JSON.stringify(payload.chartSettings));
    localStorage.setItem("candlescope-user-prefs", JSON.stringify({
      lastExchange: "binance",
      lastMarketType: "spot",
      lastSymbol: "BTCUSDT",
      lastInterval: "1h",
    }));
    // Viewport actions are intentionally persisted by the production app.
    // A benchmark run must not inherit the previous scenario's pan/zoom state.
    localStorage.removeItem("candlescope-visible-ranges");
    localStorage.setItem("candlescope-active-indicators", "[]");
    localStorage.setItem("candlescope-vol-initialized", "1");
  } catch {
    // about:blank and restricted frames may not expose localStorage. The same
    // bootstrap runs again in the application origin before its modules load.
  }

  const timingHistogramBucketWidthMs = 0.1;
  const timingHistogramMaxMs = 1_000;
  const timingHistogramBucketCount = Math.floor(
    timingHistogramMaxMs / timingHistogramBucketWidthMs,
  ) + 1;
  const inputEventTypes = ["pointerdown", "pointermove", "pointerup", "wheel"];
  const eventTimingTypes = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "mousedown",
    "mouseup",
    "wheel",
  ];
  const makeTimingHistogram = () => ({
    bucketCounts: new Uint32Array(timingHistogramBucketCount),
    totalCount: 0,
    invalidCount: 0,
    maxMs: null,
  });
  const makeTimingHistogramMap = (types) => Object.fromEntries(
    types.map((type) => [type, makeTimingHistogram()]),
  );
  const makeState = () => ({
    startedAt: performance.now(),
    lastRafAt: null,
    rafIntervalsMs: [],
    inputToNextPaintMs: [],
    eventTimingMs: [],
    mouseupSyncMs: [],
    longTasks: [],
    longTaskObservedCount: 0,
    longTaskDroppedCount: 0,
    instrumentationWindows: [],
    activeInstrumentation: null,
    captureStats: {
      rafIntervalsMs: { observed: 0, dropped: 0 },
      inputToNextPaintMs: { observed: 0, dropped: 0 },
      eventTimingMs: { observed: 0, dropped: 0 },
      mouseupSyncMs: { observed: 0, dropped: 0 },
    },
    timingHistograms: {
      rafIntervalsMs: makeTimingHistogram(),
      inputToNextPaintMs: makeTimingHistogram(),
      eventTimingMs: makeTimingHistogram(),
      mouseupSyncMs: makeTimingHistogram(),
    },
    inputToNextPaintByType: makeTimingHistogramMap(inputEventTypes),
    eventTimingByType: makeTimingHistogramMap(eventTimingTypes),
  });
  let state = makeState();
  let inputFenceTracker = null;
  let eventTimingSupported = false;
  let longTaskSupported = false;
  const timingSampleCapacity = Number.isSafeInteger(payload.timingSampleCapacity)
    && payload.timingSampleCapacity >= 0
    ? payload.timingSampleCapacity
    : 20_000;
  const longTaskCapacity = Number.isSafeInteger(payload.longTaskCapacity)
    && payload.longTaskCapacity > 0
    ? payload.longTaskCapacity
    : 20_000;

  const histogramPercentile = (histogram, percentile) => {
    if (histogram.totalCount === 0) return null;
    const rank = Math.max(1, Math.ceil((percentile / 100) * histogram.totalCount));
    let cumulative = 0;
    for (let index = 0; index < histogram.bucketCounts.length; index += 1) {
      cumulative += histogram.bucketCounts[index];
      if (cumulative < rank) continue;
      if (index === histogram.bucketCounts.length - 1) return histogram.maxMs;
      return Math.min(histogram.maxMs, (index + 1) * timingHistogramBucketWidthMs);
    }
    return null;
  };

  const summarizeHistogram = (histogram, captureObserved, includeBuckets) => ({
      totalCount: histogram.totalCount,
      invalidCount: histogram.invalidCount,
      captureObserved,
      bucketWidthMs: timingHistogramBucketWidthMs,
      histogramMaxMs: timingHistogramMaxMs,
      bucketCount: timingHistogramBucketCount,
      overflowCount: histogram.bucketCounts[timingHistogramBucketCount - 1],
      p50Ms: histogramPercentile(histogram, 50),
      p95Ms: histogramPercentile(histogram, 95),
      p99Ms: histogramPercentile(histogram, 99),
      maxMs: histogram.maxMs,
      ...(includeBuckets
        ? { bucketCounts: Array.from(histogram.bucketCounts) }
        : {}),
    });

  const summarizeTimingMetric = (metric, includeBuckets) => {
    const stats = state.captureStats[metric];
    const histogram = state.timingHistograms[metric];
    return summarizeHistogram(histogram, stats.observed, includeBuckets);
  };

  const summarizeHistogramMap = (histograms, includeBuckets) => Object.fromEntries(
    Object.entries(histograms).map(([type, histogram]) => [
      type,
      summarizeHistogram(histogram, histogram.totalCount, includeBuckets),
    ]),
  );

  const summarizeTimingState = (
    includeBuckets = false,
    inputFenceSnapshot = inputFenceTracker?.snapshot() ?? null,
  ) => ({
    timingSchemaVersion: "drawing-browser-timing/v2",
    windowDurationMs: Math.max(0, performance.now() - state.startedAt),
    inputEvents: inputFenceSnapshot?.inputEvents ?? 0,
    inputEventCounts: structuredClone(inputFenceSnapshot?.inputEventCounts ?? {}),
    inputPaintFenceStats: structuredClone(inputFenceSnapshot?.inputPaintFenceStats ?? {}),
    inputFenceOverall: structuredClone(inputFenceSnapshot?.overall ?? null),
    inputToNextPaintByType: summarizeHistogramMap(
      state.inputToNextPaintByType,
      includeBuckets,
    ),
    eventTimingByType: summarizeHistogramMap(state.eventTimingByType, includeBuckets),
    eventTimingSupported,
    longTaskSupported,
    captureStats: structuredClone(state.captureStats),
    metrics: {
      frameIntervalMs: summarizeTimingMetric("rafIntervalsMs", includeBuckets),
      inputToNextPaintMs: summarizeTimingMetric("inputToNextPaintMs", includeBuckets),
      eventTimingMs: summarizeTimingMetric("eventTimingMs", includeBuckets),
      mouseupSyncMs: summarizeTimingMetric("mouseupSyncMs", includeBuckets),
    },
  });

  const summarizeLongTasks = () => {
    const windows = state.instrumentationWindows.slice();
    if (state.activeInstrumentation) {
      windows.push({
        ...state.activeInstrumentation,
        endTime: performance.now(),
      });
    }
    const containedByInstrumentation = (task) => windows.some((window) => (
      task.startTime >= window.startTime
        && task.startTime + task.duration <= window.endTime
    ));
    const attributable = state.longTasks.filter((task) => !containedByInstrumentation(task));
    const excluded = state.longTasks.filter(containedByInstrumentation);
    return {
      instrumentationWindows: windows,
      attributable,
      excluded,
      excludedCount: excluded.length,
      retainedCount: state.longTasks.length,
      droppedCount: state.longTaskDroppedCount,
      totalCount: state.longTaskObservedCount,
    };
  };

  const recordHistogram = (histogram, value) => {
    if (!Number.isFinite(value) || value < 0) {
      histogram.invalidCount += 1;
      return false;
    }
    const bucketIndex = Math.min(
      timingHistogramBucketCount - 1,
      Math.floor(value / timingHistogramBucketWidthMs),
    );
    histogram.bucketCounts[bucketIndex] += 1;
    histogram.totalCount += 1;
    histogram.maxMs = histogram.maxMs === null ? value : Math.max(histogram.maxMs, value);
    return true;
  };

  const boundedPush = (target, metric, value, capacity = timingSampleCapacity) => {
    const histogram = state.timingHistograms[metric];
    if (!recordHistogram(histogram, value)) return;
    state.captureStats[metric].observed += 1;
    if (capacity === 0) return;
    target.push(value);
    if (target.length > capacity) {
      const dropped = target.length - capacity;
      target.splice(0, dropped);
      state.captureStats[metric].dropped += dropped;
    }
  };

  const makeInputFenceTracker = () => createInputFenceTracker({
    eventTypes: inputEventTypes,
    now: () => performance.now(),
    performanceTimeOriginMs: performance.timeOrigin,
    readLastRafAt: () => state.lastRafAt,
    requestFrame: (callback) => requestAnimationFrame(callback),
    schedulePostRafTask: (callback) => setTimeout(callback, 0),
    topKCapacity: Number.isSafeInteger(payload.inputPaintFenceTopKCapacity)
      && payload.inputPaintFenceTopKCapacity >= 0
      ? payload.inputPaintFenceTopKCapacity
      : 64,
    onOverallFence: (latencyMs) => boundedPush(
      state.inputToNextPaintMs,
      "inputToNextPaintMs",
      latencyMs,
    ),
    onTypeFence: (type, latencyMs) => {
      recordHistogram(state.inputToNextPaintByType[type], latencyMs);
    },
  });
  inputFenceTracker = makeInputFenceTracker();

  const rafLoop = (at) => {
    if (state.lastRafAt !== null) {
      boundedPush(state.rafIntervalsMs, "rafIntervalsMs", at - state.lastRafAt);
    }
    state.lastRafAt = at;
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);

  const onInput = (event) => {
    const timeStamp = event.timeStamp >= performance.timeOrigin
      ? event.timeStamp - performance.timeOrigin
      : event.timeStamp;
    inputFenceTracker.recordInput({ type: event.type, timeStamp });
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
    addEventListener(type, onInput, { capture: true, passive: true });
  }
  addEventListener("pointerup", () => {
    const startedAt = performance.now();
    queueMicrotask(() => boundedPush(
      state.mouseupSyncMs,
      "mouseupSyncMs",
      performance.now() - startedAt,
    ));
  }, { capture: true, passive: true });

  try {
    const eventObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (eventTimingTypes.includes(entry.name)) {
          boundedPush(state.eventTimingMs, "eventTimingMs", entry.duration);
          recordHistogram(state.eventTimingByType[entry.name], entry.duration);
        }
      }
    });
    eventObserver.observe({ type: "event", buffered: false, durationThreshold: 0 });
    eventTimingSupported = true;
  } catch {
    // Event Timing is not available in every Chromium build.
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTaskObservedCount += 1;
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          attribution: Array.from(entry.attribution || [], (item) => ({
            name: item.name || null,
            containerType: item.containerType || null,
            containerName: item.containerName || null,
            containerId: item.containerId || null,
            containerSrc: item.containerSrc || null,
          })),
        });
        if (state.longTasks.length > longTaskCapacity) {
          const dropped = state.longTasks.length - longTaskCapacity;
          state.longTasks.splice(0, dropped);
          state.longTaskDroppedCount += dropped;
        }
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: false });
    longTaskSupported = true;
  } catch {
    // Long Tasks may be disabled in some embedded/headless environments.
  }

  window.__CANDLESCOPE_DRAWING_BENCH__ = Object.freeze({
    reset() {
      inputFenceTracker.dispose();
      state = makeState();
      inputFenceTracker = makeInputFenceTracker();
    },
    timingSummary() {
      return summarizeTimingState();
    },
    beginInputCycle(cycle) {
      return inputFenceTracker.beginCycle(cycle);
    },
    endInputCycle(cycle) {
      return inputFenceTracker.endCycle(cycle);
    },
    beginInstrumentation(name) {
      if (state.activeInstrumentation !== null || typeof name !== "string" || name.length === 0) {
        return false;
      }
      state.activeInstrumentation = { name, startTime: performance.now() };
      return true;
    },
    endInstrumentation(name) {
      const active = state.activeInstrumentation;
      if (!active || active.name !== name) return false;
      state.instrumentationWindows.push({
        ...active,
        endTime: performance.now(),
      });
      state.activeInstrumentation = null;
      return true;
    },
    report() {
      const longTaskSummary = summarizeLongTasks();
      const inputFenceSnapshot = inputFenceTracker.snapshot();
      const timingSummary = summarizeTimingState(true, inputFenceSnapshot);
      return {
        startedAt: state.startedAt,
        endedAt: performance.now(),
        rafIntervalsMs: state.rafIntervalsMs.slice(),
        inputToNextPaintMs: state.inputToNextPaintMs.slice(),
        eventTimingMs: state.eventTimingMs.slice(),
        mouseupSyncMs: state.mouseupSyncMs.slice(),
        longTasks: state.longTasks.slice(),
        attributableLongTasks: longTaskSummary.attributable,
        excludedLongTasks: longTaskSummary.excluded,
        instrumentationWindows: longTaskSummary.instrumentationWindows,
        excludedLongTaskCount: longTaskSummary.excludedCount,
        retainedLongTaskCount: longTaskSummary.retainedCount,
        droppedLongTaskCount: longTaskSummary.droppedCount,
        totalLongTaskCount: longTaskSummary.totalCount,
        inputEvents: inputFenceSnapshot.inputEvents,
        inputEventCounts: structuredClone(inputFenceSnapshot.inputEventCounts),
        inputPaintFenceStats: structuredClone(inputFenceSnapshot.inputPaintFenceStats),
        inputFenceOverall: structuredClone(inputFenceSnapshot.overall),
        slowInputPostRafTaskFences: structuredClone(
          inputFenceSnapshot.slowInputPostRafTaskFences,
        ),
        slowInputPaintFences: structuredClone(inputFenceSnapshot.slowInputPaintFences),
        eventTimingSupported,
        longTaskSupported,
        captureStats: structuredClone(state.captureStats),
        timingSummary,
        devicePixelRatio,
        viewport: {
          width: innerWidth,
          height: innerHeight,
        },
      };
    },
  });
}

async function installScenarioBootstrap(cdp, fixture, scenario, { soak = false } = {}) {
  const source = '('
    + browserBenchmarkBootstrap.toString()
    + ')('
    + JSON.stringify({
      storageKey: fixture.storageKey,
      raw: fixture.raw,
      phase6ForceMainThreadFallback:
        scenario?.id === PHASE6_SCENARIO_IDS.mainThreadFallback,
      phase6WorkerDelayMs:
        scenario?.id === PHASE6_SCENARIO_IDS.workerBackpressure ? 96 : 0,
      chartSettings: scenario?.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan
        ? phase6LineageSettings()
        : { chartType: "candlestick" },
      timingSampleCapacity: soak ? 0 : 20_000,
      longTaskCapacity: soak ? 2_000 : 20_000,
      benchmarkRawCapture: !soak,
      inputPaintFenceTopKCapacity: 64,
    }) + ',(' + createDrawingInputPaintFenceTracker.toString() + "));";
  const response = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return response.result?.identifier || null;
}

async function waitForChartReady(
  cdp,
  expectedDrawingCount,
  timeoutMs,
  { requireDrawingEngine = false } = {},
) {
  const started = Date.now();
  let latest = null;
  let lastEvaluationError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await evaluateJson(cdp, () => {
        const report = window.__CANDLESCOPE_PERF__?.report?.() || null;
        const events = Array.isArray(report?.events) ? report.events : [];
        let commit = null;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index]?.name === "chart.data.commit") {
            commit = events[index]?.detail || null;
            break;
          }
        }
        const chart = document.querySelector(
          ".chart-pane[data-pane-id=\"main\"] .chart-pane-container, "
          + ".chart-pane[data-pane-id=\"single-chart\"]",
        );
        const drawingReady = Boolean(document.querySelector("[data-drawing-engine=\"ready\"]"));
        const drawingHandle = window.__CANDLESCOPE_DRAWING_PERF__;
        const runtimeSummary = drawingHandle?.readRuntimeSummary?.() || null;
        return {
          chartReady: Boolean(report?.marks?.["chart.ready"]),
          chartPresent: Boolean(chart),
          drawingReady,
          drawingHandlePresent: Boolean(drawingHandle),
          loadedDrawingCount: Number.isSafeInteger(runtimeSummary?.entityCount)
            ? runtimeSummary.entityCount
            : null,
          runtimeSummary,
          commit,
          readyState: document.readyState,
        };
      });
      lastEvaluationError = null;
    } catch (error) {
      lastEvaluationError = error;
      latest = null;
    }
    const normalizedRuntimeSummary = latest?.runtimeSummary || (expectedDrawingCount === 0
      ? { entityCount: 0, pointCount: 0, typeCounts: {} }
      : null);
    const normalizedLoadedDrawingCount = normalizedRuntimeSummary?.entityCount ?? null;
    const drawingEngineSatisfied = expectedDrawingCount === 0 && !requireDrawingEngine
      ? true
      : latest?.drawingReady;
    const drawingSatisfied = drawingEngineSatisfied
      && latest?.drawingHandlePresent
      && normalizedLoadedDrawingCount === expectedDrawingCount;
    if (latest?.chartReady && latest?.chartPresent && drawingSatisfied) {
      return {
        ...latest,
        loadedDrawingCount: normalizedLoadedDrawingCount,
        runtimeSummary: normalizedRuntimeSummary,
        waitedMs: Date.now() - started,
      };
    }
    await wait(100);
  }
  throw new Error("Timed out waiting for chart/drawing engine: " + JSON.stringify({
    expectedDrawingCount,
    latest,
    lastEvaluationError: lastEvaluationError?.message || null,
  }));
}

async function getChartRect(cdp) {
  return evaluateJson(cdp, () => {
    const element = document.querySelector(
      ".chart-pane[data-pane-id=\"main\"] .chart-pane-container, "
      + ".chart-pane[data-pane-id=\"single-chart\"]",
    );
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function clickTool(cdp, tool) {
  const expression = "(() => {"
    + "const el=document.querySelector('[data-drawing-tool=" + JSON.stringify(tool) + "]');"
    + "if(!el||el.disabled)return false;el.click();return true;"
    + "})()";
  return Boolean(await evaluate(cdp, expression));
}

async function selectToolVariant(cdp, parentTool, variant) {
  const opened = Boolean(await evaluate(cdp, "(() => {"
    + "const el=document.querySelector('[data-drawing-tool="
    + JSON.stringify(parentTool) + "]');"
    + "if(!el||el.disabled)return false;"
    + "el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}));"
    + "return true;"
    + "})()"));
  if (!opened) return false;
  await waitNextAnimationFrame(cdp);
  const expression = "(() => {"
    + "const el=document.querySelector('[data-tool-variant=" + JSON.stringify(variant) + "]');"
    + "if(!el||el.disabled)return false;el.click();return true;"
    + "})()";
  return Boolean(await evaluate(cdp, expression));
}

async function selectToolVariantFromCandidates(cdp, parentTools, variant) {
  const candidates = Array.isArray(parentTools) ? parentTools : [parentTools];
  const opened = Boolean(await evaluate(cdp, "(() => {"
    + "const selectors=" + JSON.stringify(candidates)
    + ".map((tool)=>'[data-drawing-tool=\\\"'+CSS.escape(tool)+'\\\"]');"
    + "const el=document.querySelector(selectors.join(','));"
    + "if(!el||el.disabled)return false;"
    + "el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}));"
    + "return true;"
    + "})()"));
  if (!opened) return false;
  await waitNextAnimationFrame(cdp);
  const expression = "(() => {"
    + "const el=document.querySelector('[data-tool-variant=" + JSON.stringify(variant) + "]');"
    + "if(!el||el.disabled)return false;el.click();return true;"
    + "})()";
  return Boolean(await evaluate(cdp, expression));
}

async function dispatchLeftClick(cdp, point, { modifiers = 0 } = {}) {
  await dispatchMouseMove(cdp, point.x, point.y, 0, modifiers);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
}

async function dispatchEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
}

async function clickDrawingAction(cdp, action) {
  return Boolean(await evaluate(cdp, "(() => {"
    + "const el=Array.from(document.querySelectorAll('[data-drawing-action]'))"
    + ".find((node)=>node.getAttribute('data-drawing-action')===" + JSON.stringify(action) + ");"
    + "if(!el||el.disabled)return false;el.click();return true;"
    + "})()"));
}

async function waitNextAnimationFrame(cdp, timeoutMs = 2_000) {
  const safeTimeoutMs = Math.max(250, Number(timeoutMs) || 2_000);
  const arrived = await Promise.race([
    evaluate(cdp, "new Promise((resolve)=>requestAnimationFrame(()=>resolve(true)))"),
    wait(safeTimeoutMs).then(() => false),
  ]);
  if (arrived !== true) {
    throw new Error("Animation frame did not arrive within " + safeTimeoutMs
      + "ms; the headed benchmark window may be hidden or minimized");
  }
}

async function ensureHeadedBenchmarkWindow(cdp, windowId, headless) {
  if (headless) {
    return {
      headed: false,
      windowState: "headless",
      visibilityState: null,
      hidden: null,
      devicePixelRatio: null,
    };
  }
  if (!Number.isSafeInteger(windowId)) {
    throw new Error("Headed benchmark browser window is unavailable");
  }

  const before = await cdp.send("Browser.getWindowBounds", { windowId });
  if (before.result?.bounds?.windowState !== "normal") {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
  }
  await cdp.send("Page.bringToFront");
  await wait(50);
  const visibility = await evaluateJson(cdp, () => ({
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    devicePixelRatio: window.devicePixelRatio,
  }));
  const after = await cdp.send("Browser.getWindowBounds", { windowId });
  const evidence = {
    headed: true,
    windowState: after.result?.bounds?.windowState ?? null,
    visibilityState: visibility?.visibilityState ?? null,
    hidden: visibility?.hidden ?? null,
    devicePixelRatio: Number(visibility?.devicePixelRatio),
  };
  if (evidence.windowState !== "normal"
    || evidence.visibilityState !== "visible"
    || evidence.hidden !== false) {
    throw new Error("Headed benchmark window is not visible: " + JSON.stringify(evidence));
  }
  return evidence;
}

async function waitForShadowParityCoverage(cdp, timeoutMs) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    latest = await evaluateJson(cdp, () => {
      const snapshot = window.__CANDLESCOPE_DRAWING_PERF__?.report?.() || null;
      return {
        compareCount: Number(snapshot?.counterMaxima?.shadowCompareCount || 0),
        comparedEntities: Number(snapshot?.gaugeMaxima?.shadowComparedEntities || 0),
        comparedHits: Number(snapshot?.gaugeMaxima?.shadowComparedHits || 0),
        errorCount: Number(snapshot?.counterMaxima?.shadowErrorCount || 0),
        sceneRebuildCount: Number(snapshot?.counterMaxima?.sceneRebuildCount || 0),
        skippedCount: Number(snapshot?.counterMaxima?.shadowSkippedCount || 0),
      };
    });
    if (latest?.compareCount > 0
      && latest?.comparedEntities > 0
      && latest?.comparedHits > 0) return { passed: true, evidence: latest };
    await wait(50);
  }
  return { passed: false, evidence: latest };
}

async function requestFinalShadowParity(cdp, timeoutMs) {
  const requested = await evaluateJson(cdp, () => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const before = Number(handle?.report?.()?.counterMaxima?.shadowCompareCount || 0);
    return {
      before,
      requested: handle?.requestShadowParity?.() === true,
    };
  });
  if (!requested?.requested) return { passed: false, evidence: requested ?? null };
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    latest = await evaluateJson(cdp, () => {
      const snapshot = window.__CANDLESCOPE_DRAWING_PERF__?.report?.() || null;
      return {
        compareCount: Number(snapshot?.counterMaxima?.shadowCompareCount || 0),
        errorCount: Number(snapshot?.counterMaxima?.shadowErrorCount || 0),
        mismatchCount: Number(snapshot?.counterMaxima?.shadowParityMismatchCount || 0),
        mismatchItems: Number(snapshot?.gaugeMaxima?.shadowMismatchItems || 0),
      };
    });
    if (latest?.compareCount > requested.before) {
      return {
        passed: latest.errorCount === 0
          && latest.mismatchCount === 0
          && latest.mismatchItems === 0,
        evidence: latest,
      };
    }
    await wait(50);
  }
  return { passed: false, evidence: latest };
}

async function dispatchMouseMove(cdp, x, y, buttons = 0, modifiers = 0) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: buttons ? "left" : "none",
    buttons,
    modifiers,
  });
}

async function runWheel(cdp, rect, count) {
  const x = Math.round(rect.x + rect.width * 0.56);
  const y = Math.round(rect.y + rect.height * 0.52);
  for (let index = 0; index < count; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: index % 2 === 0 ? -92 : 92,
    });
    await wait(24);
  }
  return count;
}

async function runWheelBurst(cdp, rect, count) {
  const x = Math.round(rect.x + rect.width * 0.56);
  const y = Math.round(rect.y + rect.height * 0.52);
  const batchSize = 32;
  for (let offset = 0; offset < count; offset += batchSize) {
    const pending = [];
    const end = Math.min(count, offset + batchSize);
    for (let index = offset; index < end; index += 1) {
      pending.push(cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: index % 2 === 0 ? -92 : 92,
      }));
    }
    await Promise.all(pending);
    await waitNextAnimationFrame(cdp);
  }
  return count;
}

async function runWorkerBackpressureWheelCadence(cdp, rect, count) {
  const x = Math.round(rect.x + rect.width * 0.56);
  const y = Math.round(rect.y + rect.height * 0.52);
  // One trusted wheel input per display frame forces distinct viewport scene
  // builds faster than the benchmark's delayed worker can finish. This is what
  // exercises the real 1-in-flight + 1-pending latest-wins queue; large CDP
  // Promise batches serialize too slowly and collapse into a few rebuilds.
  for (let index = 0; index < count; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: index % 2 === 0 ? -92 : 92,
    });
    await waitNextAnimationFrame(cdp);
  }
  return count;
}

async function runPan(cdp, rect) {
  await clickTool(cdp, "cursor");
  const fromX = Math.round(rect.x + rect.width * 0.72);
  const toX = Math.round(rect.x + rect.width * 0.30);
  const y = Math.round(rect.y + rect.height * 0.62);
  await dispatchMouseMove(cdp, fromX, y);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  const steps = 36;
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(fromX + (toX - fromX) * (step / steps));
    await dispatchMouseMove(cdp, x, y, 1);
    await wait(12);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return steps;
}

async function resetTimeScaleWarmup(cdp, rect) {
  const x = Math.round(rect.x + rect.width * 0.5);
  const y = Math.round(rect.y + rect.height - 8);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 2,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 2,
  });
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
}

async function runHover(cdp, rect, count) {
  await clickTool(cdp, "eraser");
  const left = rect.x + rect.width * 0.08;
  const top = rect.y + rect.height * 0.12;
  const width = rect.width * 0.84;
  const height = rect.height * 0.72;
  for (let index = 0; index < count; index += 1) {
    const progress = index / Math.max(1, count - 1);
    const x = Math.round(left + width * progress);
    const y = Math.round(top + height * (0.5 + Math.sin(index * 0.19) * 0.32));
    await dispatchMouseMove(cdp, x, y);
    if (index % 4 === 3) await waitNextAnimationFrame(cdp);
  }
  return count;
}

async function runCrosshairMoves(cdp, rect, count) {
  const activated = await selectToolVariant(cdp, "cursor", "cursor-crosshair");
  if (!activated) throw new Error("Crosshair cursor tool is not available");
  const left = rect.x + rect.width * 0.08;
  const top = rect.y + rect.height * 0.12;
  const width = rect.width * 0.84;
  const height = rect.height * 0.72;
  const batchSize = 32;
  for (let offset = 0; offset < count; offset += batchSize) {
    const pending = [];
    const end = Math.min(count, offset + batchSize);
    for (let index = offset; index < end; index += 1) {
      const progress = index / Math.max(1, count - 1);
      pending.push(dispatchMouseMove(
        cdp,
        Math.round(left + width * progress),
        Math.round(top + height * (0.5 + Math.sin(index * 0.113) * 0.34)),
      ));
    }
    await Promise.all(pending);
    await waitNextAnimationFrame(cdp);
  }
  return count;
}

async function runActiveFreehand(cdp, rect, count) {
  const activated = await clickTool(cdp, "pen");
  if (!activated) throw new Error("Pen tool is not available");
  await wait(100);
  const left = rect.x + rect.width * 0.08;
  const top = rect.y + rect.height * 0.18;
  const width = Math.max(120, rect.width * 0.82);
  const height = Math.max(80, rect.height * 0.60);
  const startX = Math.round(left);
  const startY = Math.round(top + height * 0.50);
  await dispatchMouseMove(cdp, startX, startY);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: startX,
    y: startY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });

  const batchSize = 32;
  for (let offset = 0; offset < count; offset += batchSize) {
    const pending = [];
    const end = Math.min(count, offset + batchSize);
    for (let index = offset; index < end; index += 1) {
      const x = Math.round(left + ((index * 3.25) % width));
      const y = Math.round(top + height * (0.50
        + Math.sin(index * 0.071) * 0.28
        + Math.cos(index * 0.017) * 0.12));
      pending.push(cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
      }));
    }
    await Promise.all(pending);
    await waitNextAnimationFrame(cdp);
  }
  const endX = Math.round(left + (((count - 1) * 3.25) % width));
  const endY = Math.round(top + height * (0.50 + Math.sin((count - 1) * 0.071) * 0.28));
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return count;
}

const PHASE5_LINE_TOOL_CANDIDATES = Object.freeze([
  "line-segment",
  "line-ray",
  "line-infinite",
  "line-horizontal",
  "line-vertical",
  "line-cross",
  "angle-measure",
]);

function phase5LineGeometry(rect) {
  const first = {
    x: Math.round(rect.x + rect.width * 0.30),
    y: Math.round(rect.y + rect.height * 0.36),
  };
  const second = {
    x: Math.round(rect.x + rect.width * 0.67),
    y: Math.round(rect.y + rect.height * 0.64),
  };
  return {
    first,
    second,
    midpoint: {
      x: Math.round((first.x + second.x) / 2),
      y: Math.round((first.y + second.y) / 2),
    },
  };
}

function phase5FreehandPoint(rect, index) {
  const left = rect.x + rect.width * 0.10;
  const top = rect.y + rect.height * 0.20;
  const width = rect.width * 0.78;
  const height = rect.height * 0.56;
  return {
    // Keep adjacent samples farther apart than the production min-distance
    // filter while wrapping inside the plot. This proves a 4096-sample typed
    // draft instead of merely dispatching 4096 sub-pixel events that collapse
    // into a much smaller canonical stroke.
    x: Math.round(left + ((index * 3.25) % width)),
    y: Math.round(top + height * (
      0.5
      + Math.sin(index * 0.071) * 0.27
      + Math.cos(index * 0.017) * 0.11
    )),
  };
}

async function activatePhase5FreehandTool(cdp, tool) {
  const activated = await selectToolVariantFromCandidates(
    cdp,
    ["pen", "highlighter"],
    tool,
  );
  if (!activated) throw new Error("Phase 5 " + tool + " toolbar variant is unavailable");
}

async function activatePhase5LineTool(cdp) {
  const activated = await selectToolVariantFromCandidates(
    cdp,
    PHASE5_LINE_TOOL_CANDIDATES,
    "line-segment",
  );
  if (!activated) throw new Error("Phase 5 line-segment toolbar variant is unavailable");
}

async function dispatchPhase5CoalescedPointerMoves(cdp, points) {
  const payload = Array.isArray(points)
    ? points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    : [];
  if (payload.length === 0) return 0;
  return Number(await evaluate(cdp, "(() => {"
    + "const points=" + JSON.stringify(payload) + ";"
    + "const target=document.querySelector('.chart-pane[data-pane-id=\\\"main\\\"] .chart-pane-container,"
      + ".chart-pane[data-pane-id=\\\"single-chart\\\"]');"
    + "if(!target||typeof PointerEvent!=='function')return 0;"
    + "const last=points[points.length-1];"
    + "const event=new PointerEvent('pointermove',{bubbles:true,cancelable:true,"
      + "clientX:last.x,clientY:last.y,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true});"
    + "Object.defineProperty(event,'getCoalescedEvents',{configurable:true,value:()=>points.map((point)=>({"
      + "clientX:point.x,clientY:point.y,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true"
      + "}))});"
    + "target.dispatchEvent(event);return points.length;"
    + "})()"));
}

async function runPhase5FreehandGesture(cdp, rect, count, tool, {
  commit,
  label,
} = {}) {
  await activatePhase5FreehandTool(cdp, tool);
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  const first = phase5FreehandPoint(rect, 0);
  const end = phase5FreehandPoint(rect, count - 1);
  const watch = [
    phase5FreehandPoint(rect, Math.floor(count * 0.25)),
    phase5FreehandPoint(rect, Math.floor(count * 0.50)),
    phase5FreehandPoint(rect, Math.floor(count * 0.75)),
    end,
  ];
  await callPhase5Probe(cdp, "setWatchPoints", "live-ink", watch);
  await dispatchMouseMove(cdp, first.x, first.y);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  if (await callPhase5Probe(cdp, "settleReactRenders") !== true) {
    throw new Error("Phase 5 React render baseline did not settle for " + tool);
  }
  if (await callPhase5Probe(cdp, "beginPointerMoveWindow", label) !== true) {
    throw new Error("Phase 5 pointermove window could not start for " + tool);
  }
  const batchSize = 32;
  let coalescedSamplesDispatched = 0;
  let coalescedBatchesDispatched = 0;
  for (let offset = 1; offset < count; offset += batchSize) {
    const points = [];
    const batchEnd = Math.min(count, offset + batchSize);
    for (let index = offset; index < batchEnd; index += 1) {
      points.push(phase5FreehandPoint(rect, index));
    }
    coalescedSamplesDispatched += await dispatchPhase5CoalescedPointerMoves(cdp, points);
    coalescedBatchesDispatched += 1;
    await waitNextAnimationFrame(cdp);
  }
  const moveWindow = await callPhase5Probe(cdp, "endPointerMoveWindow");
  if (!moveWindow) throw new Error("Phase 5 pointermove window could not stop for " + tool);
  const liveInkVisibleAtEnd = await callPhase5Probe(
    cdp,
    "readVisibility",
    "live-ink",
  ) === true;
  if (!commit) {
    await dispatchEscape(cdp);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: end.x,
      y: end.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await waitNextAnimationFrame(cdp);
    await waitNextAnimationFrame(cdp);
    const liveInkVisibleAfterCancel = await callPhase5Probe(
      cdp,
      "readVisibility",
      "live-ink",
    ) === true;
    return {
      coalescedSamplesDispatched,
      coalescedBatchesDispatched,
      moveWindow,
      liveInkVisibleAtEnd,
      liveInkVisibleAfterCancel,
    };
  }
  const liveInkVisibleBeforeCommit = await callPhase5Probe(
    cdp,
    "prepareHandoff",
    "live-ink",
    watch[2],
  ) === true;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await callPhase5Probe(cdp, "markCommitted");
  return {
    pointerSamplesDispatched: count,
    moveWindow,
    liveInkVisibleBeforeCommit,
    coalescedSamplesDispatched,
    coalescedBatchesDispatched,
  };
}

async function runPhase5Freehand(cdp, rect, count, tool, storageKey, timeoutMs) {
  const heavy = await runPhase5FreehandGesture(cdp, rect, count, tool, {
    commit: false,
    label: tool + "-heavy-live-ink",
  });
  if (heavy.liveInkVisibleAtEnd !== true || heavy.liveInkVisibleAfterCancel !== false) {
    throw new Error("Phase 5 heavy live ink did not cancel cleanly for " + tool
      + ": " + JSON.stringify(heavy));
  }
  const heavyFixtureSummaryAfterCancel = await readSavedDrawingSummary(cdp, storageKey);
  const heavyFixturePreservedAfterCancel = Boolean(heavyFixtureSummaryAfterCancel
    && heavyFixtureSummaryAfterCancel.entityCount === 64
    && heavyFixtureSummaryAfterCancel.pointCount === 32_768
    && sameTypeCounts(heavyFixtureSummaryAfterCancel.typeCounts, { freehand: 64 }));
  if (!heavyFixturePreservedAfterCancel) {
    throw new Error("Phase 5 heavy fixture changed during cancelled " + tool + " gesture");
  }
  if (!await clickDrawingAction(cdp, "clear")) {
    throw new Error("Phase 5 drawing clear action is unavailable");
  }
  const cleared = await waitForSavedDrawingCount(cdp, storageKey, 0, timeoutMs);
  if (!cleared.matched) throw new Error("Phase 5 heavy fixture did not clear before commit");
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  const committed = await runPhase5FreehandGesture(cdp, rect, count, tool, {
    commit: true,
    label: tool + "-commit-live-ink",
  });
  return {
    pointerSamplesDispatched: count,
    heavyPointerSamplesDispatched: count,
    committedPointerSamplesDispatched: count,
    coalescedSamplesDispatched: heavy.coalescedSamplesDispatched,
    committedCoalescedSamplesDispatched: committed.coalescedSamplesDispatched,
    coalescedBatchesDispatched: heavy.coalescedBatchesDispatched,
    committedCoalescedBatchesDispatched: committed.coalescedBatchesDispatched,
    heavyMoveWindow: heavy.moveWindow,
    committedMoveWindow: committed.moveWindow,
    heavyLiveInkVisibleBeforeCancel: heavy.liveInkVisibleAtEnd,
    heavyLiveInkVisibleAfterCancel: heavy.liveInkVisibleAfterCancel,
    heavyFixtureSummaryAfterCancel,
    heavyFixturePreservedAfterCancel,
    fixtureClearedBeforeCommit: cleared.matched,
    liveInkVisibleBeforeCommit: committed.liveInkVisibleBeforeCommit,
  };
}

async function createPhase5Line(cdp, rect, {
  trackPreviewWindow = false,
  trackHandoff = false,
  label = "two-point-preview",
} = {}) {
  await activatePhase5LineTool(cdp);
  await waitNextAnimationFrame(cdp);
  const geometry = phase5LineGeometry(rect);
  await dispatchLeftClick(cdp, geometry.first, { modifiers: 1 });
  await callPhase5Probe(cdp, "setWatchPoints", "dynamic", [geometry.midpoint]);
  if (trackPreviewWindow) {
    if (await callPhase5Probe(cdp, "settleReactRenders") !== true) {
      throw new Error("Phase 5 React render baseline did not settle for two-point preview");
    }
    if (await callPhase5Probe(cdp, "beginPointerMoveWindow", label) !== true) {
      throw new Error("Phase 5 two-point preview window could not start");
    }
  }
  await dispatchMouseMove(cdp, geometry.second.x, geometry.second.y, 0, 1);
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  const moveWindow = trackPreviewWindow
    ? await callPhase5Probe(cdp, "endPointerMoveWindow")
    : null;
  const handoffVisibleBeforeCommit = trackHandoff
    ? await callPhase5Probe(cdp, "prepareHandoff", "dynamic", geometry.midpoint) === true
    : null;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: geometry.second.x,
    y: geometry.second.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 1,
  });
  if (trackHandoff) await callPhase5Probe(cdp, "markCommitted");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: geometry.second.x,
    y: geometry.second.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: 1,
  });
  return { ...geometry, moveWindow, handoffVisibleBeforeCommit };
}

async function readSavedDrawingRaw(cdp, storageKey) {
  const value = await evaluate(cdp, "localStorage.getItem(" + JSON.stringify(storageKey) + ")");
  return typeof value === "string" ? value : null;
}

async function waitForSavedRawChange(cdp, storageKey, before, timeoutMs) {
  const started = Date.now();
  let current = await readSavedDrawingRaw(cdp, storageKey);
  while (Date.now() - started < timeoutMs && current === before) {
    await wait(25);
    current = await readSavedDrawingRaw(cdp, storageKey);
  }
  return { changed: typeof current === "string" && current !== before, current };
}

function savedLineGeometryFromRaw(raw) {
  if (typeof raw !== "string") return null;
  try {
    const drawings = JSON.parse(raw);
    if (!Array.isArray(drawings)) return null;
    const line = drawings.find((item) => (
      item && typeof item === "object" && item.type === "line"
    ));
    if (!line || !Array.isArray(line.dataPoints) || line.dataPoints.length !== 2) return null;
    const [first, second] = line.dataPoints;
    if (!first || typeof first !== "object" || !second || typeof second !== "object") return null;
    return {
      first: structuredClone(first),
      second: structuredClone(second),
    };
  } catch {
    return null;
  }
}

function sameSavedPoint(left, right) {
  return left !== null
    && right !== null
    && JSON.stringify(left) === JSON.stringify(right);
}

async function dispatchPhase5DragMoves(cdp, from, to, steps) {
  for (let index = 1; index <= steps; index += 1) {
    const point = {
      x: Math.round(from.x + (to.x - from.x) * (index / steps)),
      y: Math.round(from.y + (to.y - from.y) * (index / steps)),
    };
    await dispatchMouseMove(cdp, point.x, point.y, 1, 1);
    if (index % 4 === 0) await waitNextAnimationFrame(cdp);
  }
  return steps;
}

async function runPhase5DragResize(cdp, rect, storageKey, timeoutMs) {
  const line = await createPhase5Line(cdp, rect);
  const persistedLine = await waitForSavedDrawingCount(cdp, storageKey, 1, timeoutMs);
  if (!persistedLine.matched) throw new Error("Phase 5 drag fixture line did not persist");
  const originalRaw = await readSavedDrawingRaw(cdp, storageKey);
  const originalGeometry = savedLineGeometryFromRaw(originalRaw);
  if (!originalGeometry) throw new Error("Phase 5 drag fixture geometry is unavailable");
  // Existing line hit-testing and drag initiation are owned by the line tool
  // branch. Re-select it explicitly because the toolbar may be configured for
  // one-shot drawing; passive cursor mode only preserves an existing selection.
  await activatePhase5LineTool(cdp);
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);

  const dragEnd = { x: line.midpoint.x + 64, y: line.midpoint.y - 30 };
  const draggedFirst = { x: line.first.x + 64, y: line.first.y - 30 };
  const draggedSecond = { x: line.second.x + 64, y: line.second.y - 30 };
  await dispatchMouseMove(cdp, line.midpoint.x, line.midpoint.y, 0, 1);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: line.midpoint.x,
    y: line.midpoint.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 1,
  });
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  await callPhase5Probe(cdp, "setWatchPoints", "dynamic", [dragEnd]);
  if (await callPhase5Probe(cdp, "settleReactRenders") !== true) {
    throw new Error("Phase 5 React render baseline did not settle for line drag");
  }
  if (await callPhase5Probe(cdp, "beginPointerMoveWindow", "line-drag") !== true) {
    throw new Error("Phase 5 line drag window could not start");
  }
  const dragMovesDispatched = await dispatchPhase5DragMoves(
    cdp,
    line.midpoint,
    dragEnd,
    24,
  );
  await callPhase5Probe(cdp, "endPointerMoveWindow");
  const dragOverlayVisibleBeforeCommit = await callPhase5Probe(
    cdp,
    "prepareHandoff",
    "dynamic",
    dragEnd,
  ) === true;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: dragEnd.x,
    y: dragEnd.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: 1,
  });
  await callPhase5Probe(cdp, "markCommitted");
  const afterDrag = await waitForSavedRawChange(cdp, storageKey, originalRaw, timeoutMs);
  const draggedGeometry = savedLineGeometryFromRaw(afterDrag.current);
  const dragGeometryMatched = Boolean(draggedGeometry
    && !sameSavedPoint(originalGeometry.first, draggedGeometry.first)
    && !sameSavedPoint(originalGeometry.second, draggedGeometry.second));

  const resizeEnd = { x: draggedSecond.x + 72, y: draggedSecond.y + 48 };
  const resizeMidpoint = {
    x: Math.round((draggedFirst.x + resizeEnd.x) / 2),
    y: Math.round((draggedFirst.y + resizeEnd.y) / 2),
  };
  await dispatchMouseMove(cdp, draggedSecond.x, draggedSecond.y, 0, 1);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: draggedSecond.x,
    y: draggedSecond.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 1,
  });
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  await callPhase5Probe(cdp, "setWatchPoints", "dynamic", [resizeMidpoint]);
  if (await callPhase5Probe(cdp, "settleReactRenders") !== true) {
    throw new Error("Phase 5 React render baseline did not settle for line resize");
  }
  if (await callPhase5Probe(cdp, "beginPointerMoveWindow", "line-resize") !== true) {
    throw new Error("Phase 5 line resize window could not start");
  }
  const resizeMovesDispatched = await dispatchPhase5DragMoves(
    cdp,
    draggedSecond,
    resizeEnd,
    24,
  );
  await callPhase5Probe(cdp, "endPointerMoveWindow");
  const resizeOverlayVisibleBeforeCommit = await callPhase5Probe(
    cdp,
    "prepareHandoff",
    "dynamic",
    resizeMidpoint,
  ) === true;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: resizeEnd.x,
    y: resizeEnd.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: 1,
  });
  await callPhase5Probe(cdp, "markCommitted");
  const afterResize = await waitForSavedRawChange(
    cdp,
    storageKey,
    afterDrag.current,
    timeoutMs,
  );
  const resizedGeometry = savedLineGeometryFromRaw(afterResize.current);
  const resizeGeometryMatched = Boolean(draggedGeometry && resizedGeometry
    && sameSavedPoint(draggedGeometry.first, resizedGeometry.first)
    && !sameSavedPoint(draggedGeometry.second, resizedGeometry.second));
  return {
    twoPointCommits: 1,
    dragMovesDispatched,
    resizeMovesDispatched,
    dragPersistenceMatched: afterDrag.changed,
    resizePersistenceMatched: afterResize.changed,
    dragGeometryMatched,
    resizeGeometryMatched,
    dragOverlayVisibleBeforeCommit,
    resizeOverlayVisibleBeforeCommit,
  };
}

async function runPhase5TwoPoint(cdp, rect, storageKey, timeoutMs) {
  await createPhase5Line(cdp, rect, {
    trackPreviewWindow: true,
    trackHandoff: true,
  });
  const committed = await waitForSavedDrawingCount(cdp, storageKey, 1, timeoutMs);
  if (!committed.matched) throw new Error("Phase 5 two-point line did not persist");

  const cancelFirst = {
    x: Math.round(rect.x + rect.width * 0.38),
    y: Math.round(rect.y + rect.height * 0.70),
  };
  const cancelSecond = {
    x: Math.round(rect.x + rect.width * 0.74),
    y: Math.round(rect.y + rect.height * 0.30),
  };
  const cancelMidpoint = {
    x: Math.round((cancelFirst.x + cancelSecond.x) / 2),
    y: Math.round((cancelFirst.y + cancelSecond.y) / 2),
  };
  // The successful commit leaves the new line selected. Clear that selection
  // in passive cursor mode before starting the independent cancel gesture;
  // otherwise the first line-tool click is correctly consumed as deselect.
  if (!await clickTool(cdp, "cursor")) throw new Error("Phase 5 cursor tool is unavailable");
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  await dispatchLeftClick(cdp, cancelFirst, { modifiers: 1 });
  await activatePhase5LineTool(cdp);
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  await dispatchLeftClick(cdp, cancelFirst, { modifiers: 1 });
  await callPhase5Probe(
    cdp,
    "setWatchPoints",
    "dynamic",
    [cancelFirst, cancelMidpoint, cancelSecond],
  );
  await dispatchMouseMove(cdp, cancelSecond.x, cancelSecond.y, 0, 1);
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  const previewVisibleBeforeCancel = await callPhase5Probe(cdp, "readVisibility", "dynamic");
  await dispatchEscape(cdp);
  await waitNextAnimationFrame(cdp);
  const previewVisibleAfterCancel = await callPhase5Probe(cdp, "readVisibility", "dynamic");
  const savedCountAfterCancel = await readSavedDrawingCount(cdp, storageKey);
  return {
    twoPointCommits: 1,
    twoPointCancels: 1,
    previewVisibleBeforeCancel,
    previewVisibleAfterCancel,
    savedCountAfterCommit: committed.count,
    savedCountAfterCancel,
  };
}

async function runPhase5EraserCancel(cdp, rect, storageKey, timeoutMs, hoverCount) {
  const line = await createPhase5Line(cdp, rect);
  const committed = await waitForSavedDrawingCount(cdp, storageKey, 1, timeoutMs);
  if (!committed.matched) throw new Error("Phase 5 eraser fixture line did not persist");
  if (!await clickTool(cdp, "eraser")) throw new Error("Phase 5 eraser tool is unavailable");
  await waitNextAnimationFrame(cdp);
  await waitNextAnimationFrame(cdp);
  await callPhase5Probe(
    cdp,
    "setWatchPoints",
    "dynamic",
    [line.first, line.midpoint, line.second],
  );
  if (await callPhase5Probe(cdp, "settleReactRenders") !== true) {
    throw new Error("Phase 5 React render baseline did not settle for eraser hover");
  }
  if (await callPhase5Probe(cdp, "beginPointerMoveWindow", "eraser-hover") !== true) {
    throw new Error("Phase 5 eraser hover window could not start");
  }
  for (let index = 0; index < hoverCount; index += 1) {
    const progress = index / Math.max(1, hoverCount - 1);
    await dispatchMouseMove(
      cdp,
      Math.round(line.first.x + (line.second.x - line.first.x) * progress),
      Math.round(line.first.y + (line.second.y - line.first.y) * progress),
    );
    if (index % 4 === 3) await waitNextAnimationFrame(cdp);
  }
  await callPhase5Probe(cdp, "endPointerMoveWindow");
  const savedCountBeforeCancel = await readSavedDrawingCount(cdp, storageKey);
  const hoverAndReadVisibility = async () => {
    await dispatchMouseMove(cdp, line.midpoint.x, line.midpoint.y);
    await waitNextAnimationFrame(cdp);
    await waitNextAnimationFrame(cdp);
    return await callPhase5Probe(cdp, "readVisibility", "dynamic") === true;
  };
  const overlayVisibleBeforePointerCancel = await callPhase5Probe(
    cdp,
    "readVisibility",
    "dynamic",
  ) === true;
  const pointerCancelEventsDispatched = await evaluateJson(cdp, () => {
    const target = document.querySelector(
      ".chart-pane[data-pane-id=\"main\"] .chart-pane-container, "
        + ".chart-pane[data-pane-id=\"single-chart\"]",
    );
    if (!target) return 0;
    target.dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
    }));
    return 1;
  });
  await waitNextAnimationFrame(cdp);
  const pointerCancelOverlayCleared = await callPhase5Probe(
    cdp,
    "readVisibility",
    "dynamic",
  ) === false;

  const overlayVisibleBeforeWindowBlur = await hoverAndReadVisibility();
  const windowBlurEventsDispatched = await evaluateJson(cdp, () => {
    window.dispatchEvent(new Event("blur"));
    return 1;
  });
  await waitNextAnimationFrame(cdp);
  const windowBlurOverlayCleared = await callPhase5Probe(
    cdp,
    "readVisibility",
    "dynamic",
  ) === false;

  const overlayVisibleBeforeEscape = await hoverAndReadVisibility();
  await dispatchEscape(cdp);
  await waitNextAnimationFrame(cdp);
  const escapeOverlayCleared = await callPhase5Probe(
    cdp,
    "readVisibility",
    "dynamic",
  ) === false;
  return {
    eraserHoverEventsDispatched: hoverCount,
    overlayVisibleBeforePointerCancel,
    pointerCancelOverlayCleared,
    overlayVisibleBeforeWindowBlur,
    windowBlurOverlayCleared,
    overlayVisibleBeforeEscape,
    escapeOverlayCleared,
    savedCountBeforeCancel,
    savedCountAfterCancel: await readSavedDrawingCount(cdp, storageKey),
    pointerCancelEventsDispatched: pointerCancelEventsDispatched ?? 0,
    windowBlurEventsDispatched: windowBlurEventsDispatched ?? 0,
  };
}

async function runScenarioAction(cdp, scenario, fixture, args, rect, runtimeSummary = null) {
  const result = {
    action: scenario.action,
    wheelEventsDispatched: 0,
    hoverEventsDispatched: 0,
    panEventsDispatched: 0,
    pointerSamplesDispatched: 0,
    crosshairMovesDispatched: 0,
    twoPointCommits: 0,
    twoPointCancels: 0,
    dragMovesDispatched: 0,
    resizeMovesDispatched: 0,
    eraserHoverEventsDispatched: 0,
    pointerCancelEventsDispatched: 0,
    windowBlurEventsDispatched: 0,
    hitQueriesRequested: 0,
    workerBackpressureWheelEventsDispatched: 0,
  };
  if (scenario.action === "viewport" || scenario.action === "mixed") {
    result.wheelEventsDispatched = await runWheel(cdp, rect, args.wheelEvents);
    result.panEventsDispatched = await runPan(cdp, rect);
  }
  if (scenario.action === "mixed") {
    result.hoverEventsDispatched = await runHover(cdp, rect, args.hoverEvents);
  }
  if (scenario.action === "active-freehand") {
    result.pointerSamplesDispatched = await runActiveFreehand(cdp, rect, args.pointerSamples);
  }
  if (scenario.action === "crosshair") {
    result.crosshairMovesDispatched = await runCrosshairMoves(
      cdp,
      rect,
      PHASE4_CROSSHAIR_MOVE_COUNT,
    );
  }
  if (scenario.action === "phase5-pen") {
    Object.assign(result, await runPhase5Freehand(
      cdp,
      rect,
      args.pointerSamples,
      "pen",
      fixture.storageKey,
      Math.min(args.timeoutMs, 5_000),
    ));
  }
  if (scenario.action === "phase5-highlighter") {
    Object.assign(
      result,
      await runPhase5Freehand(
        cdp,
        rect,
        args.pointerSamples,
        "highlighter",
        fixture.storageKey,
        Math.min(args.timeoutMs, 5_000),
      ),
    );
  }
  if (scenario.action === "phase5-drag-resize") {
    Object.assign(result, await runPhase5DragResize(
      cdp,
      rect,
      fixture.storageKey,
      Math.min(args.timeoutMs, 5_000),
    ));
  }
  if (scenario.action === "phase5-two-point") {
    Object.assign(result, await runPhase5TwoPoint(
      cdp,
      rect,
      fixture.storageKey,
      Math.min(args.timeoutMs, 5_000),
    ));
  }
  if (scenario.action === "phase5-eraser-cancel") {
    Object.assign(result, await runPhase5EraserCancel(
      cdp,
      rect,
      fixture.storageKey,
      Math.min(args.timeoutMs, 5_000),
      args.hoverEvents,
    ));
  }
  if (scenario.action === "phase6-viewport"
    || scenario.action === "phase6-main-thread-fallback") {
    result.wheelEventsDispatched = await runWheel(cdp, rect, args.wheelEvents);
    result.panEventsDispatched = await runPan(cdp, rect);
  }
  if (scenario.action === "phase6-hit-index") {
    const beforeViewport = await callPhase6Probe(cdp, "snapshot");
    result.wheelEventsDispatched = await runWheelBurst(cdp, rect, 8);
    const mainPanePlotRect = runtimeSummary?.mainPanePlotRect ?? null;
    const paneLocalPlotRect = normalizePhase6PanePlotRect(mainPanePlotRect);
    const points = buildPhase6HitQueryPoints(mainPanePlotRect, PHASE6_HIT_QUERY_COUNT);
    result.hitQueryCoordinateSpace = "pane-local";
    result.hitQueryPlotRect = paneLocalPlotRect;
    result.hitQueryPointsPrepared = points.length;
    const paint = await callPhase6Probe(
      cdp,
      "waitForCurrentPaint",
      beforeViewport?.runtime?.lastRequestedStamp ?? null,
      Math.min(args.timeoutMs, 10_000),
    );
    result.hitQueryPaintWaitPassed = paint?.passed === true;
    result.hitQueryPreviousStamp = paint?.previousStamp ?? null;
    result.hitQueryRequestedStamp = paint?.requestedStamp ?? null;
    result.hitQueryPaintedStamp = paint?.paintedStamp ?? null;
    if (paint?.passed !== true) {
      throw new Error("Phase 6 hit index did not publish the new viewport plan before query: "
        + JSON.stringify(paint));
    }
  }
  if (scenario.action === "phase6-active-finalize") {
    Object.assign(result, await runPhase5Freehand(
      cdp,
      rect,
      args.pointerSamples,
      "pen",
      fixture.storageKey,
      Math.min(args.timeoutMs, 5_000),
    ));
  }
  if (scenario.action === "phase6-worker-backpressure") {
    result.workerBackpressureWheelEventsDispatched = await runWorkerBackpressureWheelCadence(
      cdp,
      rect,
      96,
    );
  }
  return result;
}

async function completePhase6HitOracle(cdp, action, runtimeSummary = null) {
  const mainPanePlotRect = runtimeSummary?.mainPanePlotRect ?? null;
  const points = buildPhase6HitQueryPoints(mainPanePlotRect, PHASE6_HIT_QUERY_COUNT);
  const oracle = await callPhase6Probe(cdp, "runHitOracle", points);
  return {
    ...action,
    hitQueriesRequested: points.length,
    hitOracleSupported: oracle?.supported === true,
    hitOracleQueryCount: oracle?.queryCount ?? null,
    hitOracleMismatchCount: oracle?.mismatchCount ?? null,
    hitOraclePositiveHitCount: oracle?.positiveHitCount ?? null,
    hitOracleCandidateCoverageCount: oracle?.candidateCoverageCount ?? null,
    hitOracleMaxCandidates: oracle?.maxCandidates ?? null,
    hitQueryQueriedStamp: oracle?.queriedStamp ?? null,
    hitQueryOraclePaintedStamp: oracle?.paintedStamp ?? null,
    hitQueryCurrentPainted: oracle?.currentPainted === true,
    hitOracleOutsideMeasurementWindow: true,
  };
}

async function startPhase4FrameProbe(cdp) {
  return evaluateJson(cdp, () => {
    window.__CANDLESCOPE_PHASE4_FRAME_PROBE__?.stop?.();
    const drawingHandle = window.__CANDLESCOPE_DRAWING_PERF__;
    if (!drawingHandle?.report) return { started: false, reason: "drawing-perf-handle-missing" };
    const read = () => {
      const counters = drawingHandle.report()?.counters || {};
      const count = (key) => {
        const value = Number(counters[key]);
        return Number.isFinite(value) && value >= 0 ? value : 0;
      };
      return {
        requestUpdates: count("requestUpdateCount"),
        sceneRebuilds: count("sceneRebuildCount"),
        finalProjections: count("finalProjectionCount"),
      };
    };
    let active = true;
    let frameHandle = null;
    let last = read();
    const baseline = { ...last };
    const state = {
      observedFrameIntervals: 0,
      maxRequestUpdatesPerFrame: 0,
      maxSceneRebuildsPerFrame: 0,
      maxFinalProjectionsPerFrame: 0,
      totalRequestUpdates: 0,
      totalSceneRebuilds: 0,
      totalFinalProjections: 0,
    };
    const capture = () => {
      const current = read();
      const requestUpdates = Math.max(0, current.requestUpdates - last.requestUpdates);
      const sceneRebuilds = Math.max(0, current.sceneRebuilds - last.sceneRebuilds);
      const finalProjections = Math.max(0, current.finalProjections - last.finalProjections);
      state.observedFrameIntervals += 1;
      state.maxRequestUpdatesPerFrame = Math.max(
        state.maxRequestUpdatesPerFrame,
        requestUpdates,
      );
      state.maxSceneRebuildsPerFrame = Math.max(
        state.maxSceneRebuildsPerFrame,
        sceneRebuilds,
      );
      state.maxFinalProjectionsPerFrame = Math.max(
        state.maxFinalProjectionsPerFrame,
        finalProjections,
      );
      state.totalRequestUpdates += requestUpdates;
      state.totalSceneRebuilds += sceneRebuilds;
      state.totalFinalProjections += finalProjections;
      last = current;
    };
    const tick = () => {
      if (!active) return;
      capture();
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
    const controller = {
      stop() {
        if (active) {
          active = false;
          if (frameHandle !== null) cancelAnimationFrame(frameHandle);
          capture();
        }
        return {
          started: true,
          baseline,
          final: { ...last },
          ...state,
        };
      },
    };
    window.__CANDLESCOPE_PHASE4_FRAME_PROBE__ = controller;
    return { started: true, baseline };
  });
}

async function stopPhase4FrameProbe(cdp) {
  return evaluateJson(cdp, () => {
    const controller = window.__CANDLESCOPE_PHASE4_FRAME_PROBE__;
    if (!controller?.stop) return { started: false, reason: "phase4-probe-missing" };
    const result = controller.stop();
    delete window.__CANDLESCOPE_PHASE4_FRAME_PROBE__;
    return result;
  });
}

async function startPhase5Probe(cdp) {
  return evaluateJson(cdp, phase5BrowserProbeBootstrap);
}

async function callPhase5Probe(cdp, method, ...args) {
  const expression = "(async()=>{const controller=window.__CANDLESCOPE_PHASE5_PROBE__;"
    + "if(!controller||typeof controller[" + JSON.stringify(method) + "]!=='function')return null;"
    + "return JSON.stringify(await controller[" + JSON.stringify(method) + "](..."
    + JSON.stringify(args) + "));})()";
  const value = await evaluate(cdp, expression);
  return typeof value === "string" ? JSON.parse(value) : value ?? null;
}

async function stopPhase5Probe(cdp) {
  const result = await callPhase5Probe(cdp, "stop");
  await evaluate(cdp, "delete window.__CANDLESCOPE_PHASE5_PROBE__; true");
  return result;
}

async function startPhase6Probe(cdp) {
  return evaluateJson(cdp, phase6BrowserProbeBootstrap);
}

async function callPhase6Probe(cdp, method, ...args) {
  const expression = "(async()=>{const controller=window.__CANDLESCOPE_PHASE6_PROBE__;"
    + "if(!controller||typeof controller[" + JSON.stringify(method) + "]!=='function')return null;"
    + "return JSON.stringify(await controller[" + JSON.stringify(method) + "](..."
    + JSON.stringify(args) + "));})()";
  const value = await evaluate(cdp, expression);
  return typeof value === "string" ? JSON.parse(value) : value ?? null;
}

async function stopPhase6Probe(cdp) {
  const result = await callPhase6Probe(cdp, "stop");
  await evaluate(cdp, "delete window.__CANDLESCOPE_PHASE6_PROBE__; true");
  return result && typeof result === "object"
    ? { ...result, stopped: true }
    : { started: false, stopped: true, result: result ?? null };
}

const PHASE9_STAMP_KEYS = Object.freeze([
  "scopeKey",
  "documentRevision",
  "surfaceGeneration",
  "dataRevision",
  "projectionRevision",
  "lineageIndexRevision",
  "viewportRevision",
  "themeRevision",
  "widthCssPx",
  "heightCssPx",
  "dpr",
]);

function samePhase9Stamp(left, right) {
  return left !== null
    && right !== null
    && typeof left === "object"
    && typeof right === "object"
    && PHASE9_STAMP_KEYS.every((key) => left[key] === right[key]);
}

function normalizePhase9Runtime(runtime) {
  return normalizeDrawingSoakRuntimeEvidence(runtime);
}

function phase9RuntimeQuiescent(runtime) {
  const normalized = normalizePhase9Runtime(runtime);
  return normalized !== null
    && normalized.queueDepthCurrent === 0
    && normalized.inFlightCurrent === 0
    && normalized.sceneFallbackCount === 0
    && normalized.sceneRuntimeFaultCount === 0
    && normalized.legacyFallbackSucceededCount === 0
    && normalized.sceneFallbackLastReason === null
    && samePhase9Stamp(normalized.lastRequestedStamp, normalized.lastPublishedStamp)
    && samePhase9Stamp(normalized.lastRequestedStamp, normalized.lastPaintedStamp);
}

function normalizeCdpHeap(result) {
  const heap = result?.result ?? result ?? {};
  return {
    usedSize: Number.isFinite(heap.usedSize) ? heap.usedSize : null,
    totalSize: Number.isFinite(heap.totalSize) ? heap.totalSize : null,
    embedderHeapUsedSize: Number.isFinite(heap.embedderHeapUsedSize)
      ? heap.embedderHeapUsedSize
      : null,
    backingStorageSize: Number.isFinite(heap.backingStorageSize)
      ? heap.backingStorageSize
      : null,
  };
}

async function readPhase9Heap(cdp, workerTracker) {
  const [pageResponse, workers] = await Promise.all([
    cdp.send("Runtime.getHeapUsage"),
    workerTracker.readHeap(),
  ]);
  const page = normalizeCdpHeap(pageResponse);
  const aggregate = (key) => {
    const componentSizes = [page[key], ...workers.map((worker) => worker[key])];
    return componentSizes.every(Number.isFinite)
      ? componentSizes.reduce((total, value) => total + value, 0)
      : null;
  };
  return {
    aggregateUsedSize: aggregate("usedSize"),
    aggregateBackingStorageSize: aggregate("backingStorageSize"),
    aggregateEmbedderHeapUsedSize: aggregate("embedderHeapUsedSize"),
    page,
    workers,
  };
}

async function readPhase9Sample(cdp, workerTracker, startedAt) {
  const [heap, domResponse, performanceResponse, probe, visibility, browserTiming] = await Promise.all([
    readPhase9Heap(cdp, workerTracker),
    cdp.send("Memory.getDOMCounters"),
    cdp.send("Performance.getMetrics"),
    callPhase6Probe(cdp, "snapshot"),
    evaluateJson(cdp, () => ({
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    })),
    evaluateJson(cdp, () => (
      window.__CANDLESCOPE_DRAWING_BENCH__?.timingSummary?.() ?? null
    )),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    workerVisible: heap.workers.length > 0,
    heap,
    dom: {
      documents: domResponse.result?.documents ?? null,
      nodes: domResponse.result?.nodes ?? null,
      jsEventListeners: domResponse.result?.jsEventListeners ?? null,
    },
    performance: metricMap(performanceResponse),
    visibility,
    browserTiming,
    runtime: normalizePhase9Runtime(probe?.runtime),
  };
}

async function collectPhase9GcCheckpoint(cdp, workerTracker, startedAt, scheduledAtMs) {
  const before = await readPhase9Heap(cdp, workerTracker);
  const instrumentationName = `phase9-forced-gc:${scheduledAtMs}`;
  const began = await evaluate(cdp, "(() => {"
    + "const bench=window.__CANDLESCOPE_DRAWING_BENCH__;"
    + "return bench?.beginInstrumentation?.(" + JSON.stringify(instrumentationName) + ")===true;"
    + "})()");
  if (began !== true) {
    throw new Error("Phase 9 could not open the forced-GC instrumentation window");
  }
  let gcError = null;
  try {
    await Promise.all([
      cdp.send("HeapProfiler.collectGarbage"),
      workerTracker.collectGarbage(),
    ]);
  } catch (error) {
    gcError = error;
  }
  const ended = await evaluate(cdp, "(() => {"
    + "const bench=window.__CANDLESCOPE_DRAWING_BENCH__;"
    + "return bench?.endInstrumentation?.(" + JSON.stringify(instrumentationName) + ")===true;"
    + "})()");
  if (ended !== true) {
    throw new Error("Phase 9 could not close the forced-GC instrumentation window", {
      cause: gcError ?? undefined,
    });
  }
  if (gcError !== null) throw gcError;
  await wait(50);
  const after = await readPhase9Heap(cdp, workerTracker);
  return {
    capturedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    scheduledAtMs,
    ok: true,
    before,
    after,
  };
}

async function runPhase9WheelChurn(cdp, rect, direction) {
  const x = Math.round(rect.x + rect.width * (direction < 0 ? 0.42 : 0.62));
  const y = Math.round(rect.y + rect.height * 0.48);
  const count = 4;
  for (let index = 0; index < count; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: direction * 72,
    });
    await waitNextAnimationFrame(cdp);
  }
  return count;
}

async function runPhase9PanChurn(cdp, rect, direction) {
  const fromRatio = direction < 0 ? 0.68 : 0.34;
  const toRatio = direction < 0 ? 0.34 : 0.68;
  const fromX = Math.round(rect.x + rect.width * fromRatio);
  const toX = Math.round(rect.x + rect.width * toRatio);
  const y = Math.round(rect.y + rect.height * 0.60);
  await dispatchMouseMove(cdp, fromX, y);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(fromX + (toX - fromX) * (step / steps));
    await dispatchMouseMove(cdp, x, y, 1);
    await wait(8);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return steps;
}

async function waitForPhase9QueueConvergence(cdp, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await callPhase6Probe(cdp, "snapshot");
    latest = normalizePhase9Runtime(snapshot?.runtime);
    if (phase9RuntimeQuiescent(latest)) {
      return { passed: true, runtime: latest, waitedMs: Date.now() - startedAt };
    }
    await wait(25);
  }
  return { passed: false, runtime: latest, waitedMs: Date.now() - startedAt };
}

async function waitForPhase9InputFenceDrain(cdp, timeoutMs) {
  const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, 10_000));
  const browserDrain = evaluate(cdp, "new Promise((resolve) => {"
    + "const deadline=performance.now()+" + boundedTimeoutMs + ";"
    + "const check=()=>{"
    + "const overall=window.__CANDLESCOPE_DRAWING_BENCH__"
      + "?.timingSummary?.()?.inputFenceOverall;"
    + "if(overall&&overall.pendingEventCount===0&&overall.frozenEventCount===0"
      + "&&overall.frameScheduled===false&&overall.frozenFenceCount===0){resolve(true);return;}"
    + "if(performance.now()>=deadline){resolve(false);return;}"
    + "requestAnimationFrame(()=>setTimeout(check,0));"
    + "};"
    + "requestAnimationFrame(()=>setTimeout(check,0));"
    + "})");
  return Promise.race([
    browserDrain,
    wait(boundedTimeoutMs + 250).then(() => false),
  ]);
}

async function runPhase9WorkloadCycle(cdp, rect, args, startedAt, cycleIndex) {
  const cycle = cycleIndex + 1;
  const inputCycleBegan = await evaluate(cdp, "(() => {"
    + "const bench=window.__CANDLESCOPE_DRAWING_BENCH__;"
    + "return bench?.beginInputCycle?.(" + cycle + ")===true;"
    + "})()");
  if (inputCycleBegan !== true) {
    throw new Error(`Phase 9 input attribution cycle ${cycle} could not start`);
  }
  let cycleError = null;
  let result = null;
  try {
    const cycleStartedAt = Date.now();
    const before = await callPhase6Probe(cdp, "snapshot");
    const beforeRuntime = normalizePhase9Runtime(before?.runtime);
    const previousStamp = beforeRuntime?.lastRequestedStamp ?? null;
    const direction = cycleIndex % 2 === 0 ? -1 : 1;
    const wheelEvents = await runPhase9WheelChurn(cdp, rect, direction);
    const panEvents = await runPhase9PanChurn(cdp, rect, direction);
    if (cycleIndex > 0 && cycleIndex % 20 === 0) {
      await resetTimeScaleWarmup(cdp, rect);
    }
    const inputFenceDrained = await waitForPhase9InputFenceDrain(
      cdp,
      Math.min(args.timeoutMs, 2_000),
    );
    if (inputFenceDrained !== true) {
      throw new Error(`Phase 9 input attribution cycle ${cycle} did not drain`);
    }
    const currentPaint = await callPhase6Probe(
      cdp,
      "waitForCurrentPaint",
      previousStamp,
      Math.min(args.timeoutMs, 10_000),
    );
    const convergence = await waitForPhase9QueueConvergence(
      cdp,
      Math.min(args.timeoutMs, 10_000),
    );
    const runtime = convergence.runtime;
    const viewportRevision = runtime?.lastRequestedStamp?.viewportRevision ?? null;
    const workerJobCycleDelta = Number.isFinite(runtime?.workerJobDelta)
      && Number.isFinite(beforeRuntime?.workerJobDelta)
      ? runtime.workerJobDelta - beforeRuntime.workerJobDelta
      : null;
    const workerResultCycleDelta = Number.isFinite(runtime?.workerResultDelta)
      && Number.isFinite(beforeRuntime?.workerResultDelta)
      ? runtime.workerResultDelta - beforeRuntime.workerResultDelta
      : null;
    const stalePublishCycleDelta = Number.isFinite(runtime?.stalePublishDelta)
      && Number.isFinite(beforeRuntime?.stalePublishDelta)
      ? runtime.stalePublishDelta - beforeRuntime.stalePublishDelta
      : null;
    result = {
      cycle,
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      durationMs: Date.now() - cycleStartedAt,
      previousStamp,
      viewportRevision,
      currentPaintPassed: currentPaint?.passed === true,
      currentPaint,
      queueConverged: convergence.passed === true,
      convergenceWaitMs: convergence.waitedMs,
      workerJobCycleDelta,
      workerResultCycleDelta,
      stalePublishCycleDelta,
      runtime,
      wheelEvents,
      panEvents,
      direction,
      passed: currentPaint?.passed === true
        && convergence.passed === true
        && Number.isSafeInteger(viewportRevision)
        && Number.isSafeInteger(workerJobCycleDelta)
        && workerJobCycleDelta > 0
        && Number.isSafeInteger(workerResultCycleDelta)
        && workerResultCycleDelta > 0
        && workerResultCycleDelta <= workerJobCycleDelta
        && stalePublishCycleDelta === 0,
    };
  } catch (error) {
    cycleError = error;
  }
  const inputCycleEnded = await evaluate(cdp, "(() => {"
    + "const bench=window.__CANDLESCOPE_DRAWING_BENCH__;"
    + "return bench?.endInputCycle?.(" + cycle + ")===true;"
    + "})()").catch(() => false);
  if (cycleError !== null) throw cycleError;
  if (inputCycleEnded !== true) {
    throw new Error(`Phase 9 input attribution cycle ${cycle} could not end`);
  }
  return result;
}

async function preparePhase9Soak(
  cdp,
  workerTracker,
  fixture,
  scenario,
  args,
  browserWindowId,
) {
  const bootstrapIdentifier = await installScenarioBootstrap(
    cdp,
    fixture,
    scenario,
    { soak: true },
  );
  try {
    await ensureHeadedBenchmarkWindow(
      cdp,
      browserWindowId,
      args.headless,
    );
    const scenarioUrl = args.url + (args.url.includes("?") ? "&" : "?")
      + "drawingPerf=" + encodeURIComponent("phase9-heavy-soak");
    await navigateToDrawingPerformanceScenario(cdp, args.url, scenarioUrl);
    const ready = await waitForChartReady(
      cdp,
      fixture.metadata.drawingCount,
      args.timeoutMs,
      { requireDrawingEngine: true },
    );
    const drawingEngineDomEvidence = await readDrawingEngineDomEvidence(cdp, args);
    if (!drawingEngineDomEvidence.passed) {
      throw new Error(formatDrawingEngineDomEvidenceFailure(
        drawingEngineDomEvidence,
        "Phase 9 soak",
      ));
    }
    const rect = await getChartRect(cdp);
    if (!rect || rect.width < 200 || rect.height < 120) {
      throw new Error("Phase 9 chart rectangle is unavailable or too small");
    }
    const savedSummary = await readSavedDrawingSummary(cdp, fixture.storageKey);
    const expectedSummary = {
      entityCount: fixture.metadata.drawingCount,
      pointCount: fixture.metadata.pointCount,
      typeCounts: fixture.metadata.drawingTypes,
    };
    if (!runtimeMatchesSavedSummary(ready.runtimeSummary, savedSummary)
      || !runtimeMatchesSavedSummary(ready.runtimeSummary, expectedSummary)) {
      throw new Error("Phase 9 runtime did not restore the heavy-scene fixture exactly");
    }
    await resetTimeScaleWarmup(cdp, rect);
    const phase6Runtime = await waitForPhase6SceneReady(cdp, {
      expectedRawPoints: fixture.metadata.freehandPointCount,
      requireWorker: true,
      timeoutMs: args.timeoutMs,
    });
    if (phase6Runtime?.sceneFallbackCount !== 0
      || phase6Runtime?.sceneRuntimeFaultCount !== 0
      || phase6Runtime?.legacyFallbackSucceededCount !== 0
      || phase6Runtime?.sceneFallbackLastReason !== null) {
      throw new Error("Phase 9 preflight observed a scene fallback before the runtime probe: "
        + JSON.stringify({
          count: phase6Runtime?.sceneFallbackCount ?? null,
          faultCount: phase6Runtime?.sceneRuntimeFaultCount ?? null,
          succeededCount: phase6Runtime?.legacyFallbackSucceededCount ?? null,
          reason: phase6Runtime?.sceneFallbackLastReason ?? null,
        }));
    }
    const workerTargets = await workerTracker.waitForWorker(args.timeoutMs);
    if (workerTargets.length !== 1) {
      throw new Error("Phase 9 requires exactly one named drawing worker during preflight: "
        + JSON.stringify(workerTargets));
    }
    const browserWindowInitial = await ensureHeadedBenchmarkWindow(
      cdp,
      browserWindowId,
      args.headless,
    );
    if (browserWindowInitial.devicePixelRatio !== args.dpr) {
      throw new Error("Phase 9 browser DPR did not match the fixed configuration: "
        + JSON.stringify(browserWindowInitial));
    }
    await clickTool(cdp, "cursor");
    await evaluate(cdp, "(() => {"
      + "window.__CANDLESCOPE_DRAWING_BENCH__?.reset?.();"
      + "window.__CANDLESCOPE_DRAWING_PERF__?.reset?.();"
      + "return true;"
      + "})()");
    await wait(2_000);
    const refreshRatePreflight = await evaluateJson(cdp, () => (
      window.__CANDLESCOPE_DRAWING_BENCH__?.timingSummary?.() ?? null
    ));
    const preflightFrameMedianMs = refreshRatePreflight?.metrics?.frameIntervalMs?.p50Ms;
    const preflightRefreshRateHz = Number.isFinite(preflightFrameMedianMs)
      && preflightFrameMedianMs > 0
      ? 1_000 / preflightFrameMedianMs
      : null;
    if (preflightRefreshRateHz === null
      || preflightRefreshRateHz < DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMin
      || preflightRefreshRateHz > DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMax) {
      throw new Error("Phase 9 requires a stable 60Hz headed profile before the soak window: "
        + JSON.stringify({
          observedHz: preflightRefreshRateHz,
          minimumHz: DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMin,
          maximumHz: DRAWING_SOAK_FIXED_CONTRACT.refreshRateHzMax,
        }));
    }
    await evaluate(cdp, "(() => {"
      + "window.__CANDLESCOPE_DRAWING_BENCH__?.reset?.();"
      + "window.__CANDLESCOPE_DRAWING_PERF__?.reset?.();"
      + "return true;"
      + "})()");
    const startedProbe = await startPhase6Probe(cdp);
    if (startedProbe?.started !== true) {
      throw new Error("Phase 9 runtime probe could not start: " + JSON.stringify(startedProbe));
    }
    const baseline = await callPhase6Probe(cdp, "snapshot");
    if (!phase9RuntimeQuiescent(baseline?.runtime)) {
      throw new Error("Phase 9 baseline runtime was not quiescent/current: "
        + JSON.stringify(baseline));
    }
    return {
      bootstrapIdentifier,
      ready,
      rect,
      drawingEngineDomEvidence,
      phase6Runtime,
      workerTargets,
      baselineRuntime: normalizePhase9Runtime(baseline.runtime),
      browserWindowInitial,
      refreshRatePreflight: {
        frameMedianMs: preflightFrameMedianMs,
        refreshRateHz: preflightRefreshRateHz,
        timing: refreshRatePreflight,
      },
    };
  } catch (error) {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: bootstrapIdentifier,
    }).catch(() => {});
    throw error;
  }
}

function advancePhase9Deadline(previous, intervalMs, elapsedMs) {
  let next = previous + intervalMs;
  while (next <= elapsedMs) next += intervalMs;
  return next;
}

function phase9ReportOutputPath(args, git, generatedAt) {
  if (args.out) return path.resolve(process.cwd(), args.out);
  const generatedStamp = generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.resolve(
    FRONTEND_ROOT,
    "..",
    "docs",
    "perf-baselines",
    "drawing-engine-v2",
    "phase9-soak-" + git.shortCommit + "-" + generatedStamp + "-bars"
      + args.bars + "-dpr1_5.json",
  );
}

function writePhase9Report(args, git, report) {
  const outputPath = phase9ReportOutputPath(args, git, report.generatedAt);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, stableStringify(report, 2) + "\n", "utf8");
  return outputPath;
}

async function runPhase9Soak({
  cdp,
  workerTracker,
  fixture,
  scenario,
  args,
  browserWindowId,
  diagnostics,
  git,
  browserVersion,
  servers,
  buildEnvironment,
}) {
  const configuration = args.soakConfiguration;
  const samples = [];
  const gcCheckpoints = [];
  const cycles = [];
  const sampleErrors = [];
  let prepared = null;
  let probeStopped = null;
  try {
    prepared = await preparePhase9Soak(
      cdp,
      workerTracker,
      fixture,
      scenario,
      args,
      browserWindowId,
    );
    const startedAt = Date.now();
    let nextSampleAtMs = configuration.warmupMs + configuration.sampleIntervalMs;
    let nextGcAtMs = configuration.warmupMs;
    let nextWorkloadAtMs = 0;
    let cycleIndex = 0;
    let timingMeasurementStarted = false;
    console.log("[phase9-soak] heavy scene started; duration="
      + configuration.durationMs + "ms; warmup=" + configuration.warmupMs + "ms");

    while (Date.now() - startedAt < configuration.durationMs) {
      let elapsedMs = Date.now() - startedAt;
      let handled = false;
      if (!timingMeasurementStarted && elapsedMs >= configuration.warmupMs) {
        const reset = await evaluate(cdp, "(() => {"
          + "const bench=window.__CANDLESCOPE_DRAWING_BENCH__;"
          + "if(!bench||typeof bench.reset!=='function')return false;"
          + "bench.reset();return true;"
          + "})()");
        if (reset !== true) {
          throw new Error("Phase 9 browser timing window could not reset after warmup");
        }
        timingMeasurementStarted = true;
        elapsedMs = Date.now() - startedAt;
        // The timing reset discards warmup input evidence. Force one workload
        // cycle into the measured epoch before any sample can be accepted.
        nextWorkloadAtMs = phase9MeasuredWorkloadDeadline(elapsedMs);
        handled = true;
      }
      let dueAction = selectPhase9SoakDueAction({
        elapsedMs,
        nextWorkloadAtMs,
        nextSampleAtMs,
        nextGcAtMs,
      });
      if (dueAction === "workload") {
        try {
          cycles.push(await runPhase9WorkloadCycle(
            cdp,
            prepared.rect,
            args,
            startedAt,
            cycleIndex,
          ));
        } catch (error) {
          const failure = {
            kind: "workload",
            cycle: cycleIndex + 1,
            elapsedMs: Date.now() - startedAt,
            passed: false,
            message: error instanceof Error ? error.message : String(error),
          };
          sampleErrors.push(failure);
          cycles.push(failure);
          throw new Error("Phase 9 workload cycle failed; aborting the formal window: "
            + failure.message, { cause: error });
        }
        cycleIndex += 1;
        elapsedMs = Date.now() - startedAt;
        nextWorkloadAtMs = advancePhase9Deadline(
          nextWorkloadAtMs,
          configuration.workloadIntervalMs,
          elapsedMs,
        );
        handled = true;
      }
      dueAction = selectPhase9SoakDueAction({
        elapsedMs,
        nextWorkloadAtMs,
        nextSampleAtMs,
        nextGcAtMs,
      });
      if (dueAction === "sample") {
        const scheduledAtMs = nextSampleAtMs;
        try {
          samples.push(await readPhase9Sample(cdp, workerTracker, startedAt));
        } catch (error) {
          const failure = {
            kind: "sample",
            elapsedMs: Date.now() - startedAt,
            scheduledAtMs,
            message: error instanceof Error ? error.message : String(error),
          };
          sampleErrors.push(failure);
          samples.push({ ...failure, workerVisible: false, heap: null, runtime: null });
          throw new Error("Phase 9 sample failed; aborting the formal window: " + failure.message, {
            cause: error,
          });
        }
        elapsedMs = Date.now() - startedAt;
        nextSampleAtMs = advancePhase9Deadline(
          nextSampleAtMs,
          configuration.sampleIntervalMs,
          elapsedMs,
        );
        handled = true;
      }
      dueAction = selectPhase9SoakDueAction({
        elapsedMs,
        nextWorkloadAtMs,
        nextSampleAtMs,
        nextGcAtMs,
      });
      if (dueAction === "gc") {
        const scheduledAtMs = nextGcAtMs;
        try {
          gcCheckpoints.push(await collectPhase9GcCheckpoint(
            cdp,
            workerTracker,
            startedAt,
            scheduledAtMs,
          ));
        } catch (error) {
          const failure = {
            kind: "gc",
            elapsedMs: Date.now() - startedAt,
            scheduledAtMs,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
          sampleErrors.push(failure);
          gcCheckpoints.push(failure);
          throw new Error("Phase 9 GC checkpoint failed; aborting the formal window: "
            + failure.message, { cause: error });
        }
        elapsedMs = Date.now() - startedAt;
        nextGcAtMs = advancePhase9Deadline(
          nextGcAtMs,
          configuration.gcIntervalMs,
          elapsedMs,
        );
        handled = true;
      }
      if (!handled) {
        const nextDeadline = Math.min(nextSampleAtMs, nextGcAtMs, nextWorkloadAtMs);
        await wait(Math.max(10, Math.min(100, nextDeadline - elapsedMs)));
      }
    }

    try {
      samples.push(await readPhase9Sample(cdp, workerTracker, startedAt));
    } catch (error) {
      const failure = {
        kind: "final-sample",
        elapsedMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      };
      sampleErrors.push(failure);
      samples.push({ ...failure, workerVisible: false, heap: null, runtime: null });
      throw new Error("Phase 9 final sample failed: " + failure.message, { cause: error });
    }
    try {
      gcCheckpoints.push(await collectPhase9GcCheckpoint(
        cdp,
        workerTracker,
        startedAt,
        configuration.durationMs,
      ));
    } catch (error) {
      const failure = {
        kind: "final-gc",
        elapsedMs: Date.now() - startedAt,
        scheduledAtMs: configuration.durationMs,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
      sampleErrors.push(failure);
      gcCheckpoints.push(failure);
      throw new Error("Phase 9 final GC checkpoint failed: " + failure.message, { cause: error });
    }

    const [bench, finalDomEvidence, browserWindowFinal] = await Promise.all([
      evaluateJson(cdp, () => window.__CANDLESCOPE_DRAWING_BENCH__?.report?.() || null),
      readDrawingEngineDomEvidence(cdp, args),
      ensureHeadedBenchmarkWindow(cdp, browserWindowId, args.headless),
    ]);
    const formalWindowEndedAt = new Date().toISOString();
    const frozenDiagnostics = structuredClone({
      sampleErrors,
      consoleErrors: diagnostics.consoleErrors,
      runtimeExceptions: diagnostics.runtimeExceptions,
      networkFailures: diagnostics.networkFailures,
      longTasks: Array.isArray(bench?.attributableLongTasks)
        ? bench.attributableLongTasks
        : null,
    });
    const workerTargetsFinal = structuredClone(workerTracker.targets());
    probeStopped = await stopPhase6Probe(cdp);
    const fixtureRawSha256 = createHash("sha256").update(fixture.raw, "utf8").digest("hex");
    const eventLatencyCalibration = await runDrawingEventLatencyCalibration({
      cdp,
      rect: prepared.rect,
      waitForAnimationFrame: () => waitNextAnimationFrame(cdp),
      provenance: {
        gitCommit: git.commit,
        buildInputFingerprint: git.buildInputFingerprint,
        productionBuildVerification: "managed-vite-preview",
        browserProduct: browserVersion.result?.product || null,
        userAgent: browserVersion.result?.userAgent || null,
        fixtureRawSha256,
        scenarioId: scenario.id,
        viewport: { ...DEFAULT_VIEWPORT },
        dpr: args.dpr,
        formalWindowEndedAt,
      },
    });
    const formalEligible = isFormalDrawingSoakConfiguration(configuration);
    const frameMedianMs = bench?.timingSummary?.metrics?.frameIntervalMs?.p50Ms;
    const refreshRateHz = Number.isFinite(frameMedianMs) && frameMedianMs > 0
      ? 1_000 / frameMedianMs
      : null;
    const report = {
      generatedAt: new Date().toISOString(),
      phase: "phase9",
      context: {
        git,
        browser: {
          name: browserVersion.result?.product || "Chromium",
          version: browserVersion.result?.product || null,
          userAgent: browserVersion.result?.userAgent || null,
        },
        machine: machineContext(),
        mode: args.engineMode,
      },
      environment: {
        viewport: DEFAULT_VIEWPORT,
        dpr: args.dpr,
        refreshRateHz,
        productionBuild: true,
        productionBuildVerification: "managed-vite-preview",
        mock: servers?.mockMeta ?? null,
        buildEnvironment,
      },
      configuration: {
        ...configuration,
        url: args.url,
        serverMode: "managed-preview",
        headless: args.headless,
        bars: args.bars,
        dpr: args.dpr,
        seed: args.seed,
        intervalSeconds: args.intervalSeconds,
        mockEndTime: args.mockEndTime,
        drawingCoordinateProjectorMode: buildEnvironment?.VITE_DRAWING_COORDINATE_PROJECTOR
          ?? null,
        drawingDocumentAuthority: buildEnvironment?.VITE_DRAWING_DOCUMENT_AUTHORITY ?? null,
        drawingEngineMode: args.engineMode,
        drawingInteractionSurfaceMode: args.interactionSurfaceMode,
        drawingRasterBackend: args.rasterBackend,
        formalEligible,
        smokeOnly: !formalEligible,
      },
      fixture: {
        name: fixture.metadata.name,
        entities: fixture.metadata.drawingCount,
        points: fixture.metadata.pointCount,
        freehandPoints: fixture.metadata.freehandPointCount,
        spans: fixture.metadata.freehandSpanCount,
        bars: args.bars,
        seed: fixture.metadata.seed,
        startTime: fixture.metadata.startTime,
        intervalSeconds: fixture.metadata.intervalSeconds,
        storageChars: fixture.metadata.storageChars,
        rawSha256: fixtureRawSha256,
        storageKey: fixture.storageKey,
      },
      readiness: {
        chart: prepared.ready,
        drawingEngineDomEvidenceInitial: prepared.drawingEngineDomEvidence,
        drawingEngineDomEvidenceFinal: finalDomEvidence,
        phase6Runtime: prepared.phase6Runtime,
        baselineRuntime: prepared.baselineRuntime,
        browserWindowInitial: prepared.browserWindowInitial,
        refreshRatePreflight: prepared.refreshRatePreflight,
        browserWindowFinal,
        workerTargetsInitial: prepared.workerTargets,
        workerTargetsFinal,
        probeStopped,
      },
      samples,
      gcCheckpoints,
      cycles,
      diagnostics: frozenDiagnostics,
      eventLatencyCalibration,
      browserTiming: {
        timingSchemaVersion: bench?.timingSummary?.timingSchemaVersion ?? null,
        windowDurationMs: bench?.timingSummary?.windowDurationMs ?? null,
        refreshRateHz,
        longTaskSupported: bench?.longTaskSupported ?? null,
        longTaskCounts: {
          total: Number.isSafeInteger(bench?.totalLongTaskCount)
            ? bench.totalLongTaskCount
            : null,
          retained: Number.isSafeInteger(bench?.retainedLongTaskCount)
            ? bench.retainedLongTaskCount
            : null,
          dropped: Number.isSafeInteger(bench?.droppedLongTaskCount)
            ? bench.droppedLongTaskCount
            : null,
          excluded: Number.isSafeInteger(bench?.excludedLongTaskCount)
            ? bench.excludedLongTaskCount
            : null,
          attributable: Array.isArray(bench?.attributableLongTasks)
            ? bench.attributableLongTasks.length
            : null,
        },
        instrumentationWindows: Array.isArray(bench?.instrumentationWindows)
          ? bench.instrumentationWindows
          : null,
        rawLongTasks: Array.isArray(bench?.longTasks) ? bench.longTasks : null,
        eventTimingSupported: bench?.eventTimingSupported ?? null,
        inputEvents: bench?.inputEvents ?? null,
        inputEventCounts: bench?.timingSummary?.inputEventCounts ?? null,
        inputPaintFenceStats: bench?.timingSummary?.inputPaintFenceStats ?? null,
        inputFenceOverall: bench?.timingSummary?.inputFenceOverall ?? null,
        slowInputPostRafTaskFences: bench?.slowInputPostRafTaskFences ?? null,
        slowInputPaintFences: bench?.slowInputPaintFences ?? null,
        inputToNextPaintByType: bench?.timingSummary?.inputToNextPaintByType ?? null,
        eventTimingByType: bench?.timingSummary?.eventTimingByType ?? null,
        captureStats: bench?.captureStats ?? null,
        metrics: bench?.timingSummary?.metrics ?? null,
      },
      runMode: {
        name: formalEligible ? "phase9-soak-formal" : "phase9-soak-smoke",
        formalEligible,
        smokeOnly: !formalEligible,
      },
    };
    report.acceptance = assessDrawingSoak(report);
    return report;
  } catch (error) {
    if (!probeStopped) probeStopped = await stopPhase6Probe(cdp).catch(() => null);
    const generatedAt = new Date().toISOString();
    const failure = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : null,
      capturedAt: generatedAt,
    };
    const partialReport = {
      generatedAt,
      phase: "phase9",
      context: {
        git,
        browser: {
          name: browserVersion.result?.product || "Chromium",
          version: browserVersion.result?.product || null,
          userAgent: browserVersion.result?.userAgent || null,
        },
        machine: machineContext(),
        mode: args.engineMode,
      },
      environment: {
        viewport: DEFAULT_VIEWPORT,
        dpr: args.dpr,
        productionBuild: true,
        productionBuildVerification: "managed-vite-preview",
        mock: servers?.mockMeta ?? null,
        buildEnvironment,
      },
      configuration: {
        ...configuration,
        url: args.url,
        serverMode: "managed-preview",
        headless: args.headless,
        bars: args.bars,
        dpr: args.dpr,
        seed: args.seed,
        intervalSeconds: args.intervalSeconds,
        mockEndTime: args.mockEndTime,
        drawingCoordinateProjectorMode: buildEnvironment?.VITE_DRAWING_COORDINATE_PROJECTOR
          ?? null,
        drawingDocumentAuthority: buildEnvironment?.VITE_DRAWING_DOCUMENT_AUTHORITY ?? null,
        drawingEngineMode: args.engineMode,
        drawingInteractionSurfaceMode: args.interactionSurfaceMode,
        drawingRasterBackend: args.rasterBackend,
      },
      fixture: {
        name: fixture.metadata.name,
        entities: fixture.metadata.drawingCount,
        points: fixture.metadata.pointCount,
        freehandPoints: fixture.metadata.freehandPointCount,
        spans: fixture.metadata.freehandSpanCount,
        bars: args.bars,
        seed: fixture.metadata.seed,
        startTime: fixture.metadata.startTime,
        intervalSeconds: fixture.metadata.intervalSeconds,
        storageChars: fixture.metadata.storageChars,
        rawSha256: createHash("sha256").update(fixture.raw, "utf8").digest("hex"),
        storageKey: fixture.storageKey,
      },
      readiness: {
        chart: prepared?.ready ?? null,
        drawingEngineDomEvidenceInitial: prepared?.drawingEngineDomEvidence ?? null,
        phase6Runtime: prepared?.phase6Runtime ?? null,
        baselineRuntime: prepared?.baselineRuntime ?? null,
        browserWindowInitial: prepared?.browserWindowInitial ?? null,
        refreshRatePreflight: prepared?.refreshRatePreflight ?? null,
        workerTargetsInitial: prepared?.workerTargets ?? null,
        workerTargetsFinal: workerTracker.targets(),
        probeStopped,
      },
      samples,
      gcCheckpoints,
      cycles,
      diagnostics: {
        sampleErrors,
        consoleErrors: diagnostics.consoleErrors,
        runtimeExceptions: diagnostics.runtimeExceptions,
        networkFailures: diagnostics.networkFailures,
        longTasks: null,
      },
      failure,
      acceptance: {
        passed: false,
        formalEligible: false,
        formalAcceptance: { passed: false, eligible: false },
        smokeAcceptance: { passed: false, formalEligible: false },
        failureReasons: ["runnerFailure"],
      },
      runMode: {
        name: "phase9-soak-failed",
        formalEligible: false,
        smokeOnly: false,
      },
    };
    const outputPath = writePhase9Report(args, git, partialReport);
    throw new Error(failure.message + "\nWrote partial Phase 9 report to " + outputPath, {
      cause: error,
    });
  } finally {
    if (!probeStopped) await stopPhase6Probe(cdp).catch(() => {});
    if (prepared?.bootstrapIdentifier) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: prepared.bootstrapIdentifier,
      }).catch(() => {});
    }
  }
}

function durationSamples(snapshot, key) {
  const samples = snapshot?.durations?.[key]?.samples;
  return Array.isArray(samples) ? samples.filter(Number.isFinite) : [];
}

function durationCapture(rawCapture, snapshot, key) {
  const captured = rawCapture?.enabled ? rawCapture?.metrics?.[key] : null;
  if (captured && Array.isArray(captured.samples)) {
    const samples = captured.samples.filter(Number.isFinite);
    const observed = Number(captured.observedCount);
    const dropped = Number(captured.droppedCount);
    return {
      samples,
      completeness: {
        complete: Number.isFinite(observed)
          && Number.isFinite(dropped)
          && dropped === 0
          && samples.length === observed,
        observed,
        retained: samples.length,
        dropped,
        source: "drawing-perf-raw-capture",
      },
    };
  }
  const histogram = snapshot?.durations?.[key];
  const samples = durationSamples(snapshot, key);
  const observed = Number(histogram?.totalCount);
  return {
    samples,
    completeness: {
      complete: Number.isFinite(observed) && samples.length === observed,
      observed,
      retained: samples.length,
      dropped: Number.isFinite(observed) ? Math.max(0, observed - samples.length) : null,
      source: "rolling-histogram-fallback",
    },
  };
}

function browserCapture(bench, key) {
  const samples = Array.isArray(bench?.[key]) ? bench[key].filter(Number.isFinite) : [];
  const stats = bench?.captureStats?.[key];
  const observed = Number(stats?.observed);
  const dropped = Number(stats?.dropped);
  return {
    samples,
    completeness: {
      complete: Number.isFinite(observed)
        && Number.isFinite(dropped)
        && dropped === 0
        && samples.length === observed,
      observed,
      retained: samples.length,
      dropped,
      source: "browser-observer",
    },
  };
}

function maxCounter(snapshot, key) {
  const maximum = Number(snapshot?.counterMaxima?.[key]);
  const current = Number(snapshot?.counters?.[key]);
  if (Number.isFinite(maximum)) return maximum;
  return Number.isFinite(current) ? current : null;
}

function maxGauge(snapshot, key) {
  const maximum = Number(snapshot?.gaugeMaxima?.[key]);
  const current = Number(snapshot?.gauges?.[key]);
  if (Number.isFinite(maximum)) return maximum;
  return Number.isFinite(current) ? current : null;
}

async function readSavedDrawingCount(cdp, storageKey) {
  const expression = "(() => {try {const raw=localStorage.getItem("
    + JSON.stringify(storageKey) + ");const value=raw?JSON.parse(raw):[];"
    + "return Array.isArray(value)?value.length:-1;}catch{return -1;}})()";
  return Number(await evaluate(cdp, expression));
}

async function readSavedDrawingSummary(cdp, storageKey) {
  const expression = "(() => {try {const raw=localStorage.getItem("
    + JSON.stringify(storageKey) + ");const drawings=raw?JSON.parse(raw):[];"
    + "if(!Array.isArray(drawings))return null;let pointCount=0;const typeCounts={};"
    + "for(const drawing of drawings){if(!drawing||typeof drawing!=='object')continue;"
    + "const type=typeof drawing.type==='string'?drawing.type:'unknown';"
    + "typeCounts[type]=(typeCounts[type]||0)+1;"
    + "if(Array.isArray(drawing.stroke?.points))pointCount+=drawing.stroke.points.length;"
    + "else if(Array.isArray(drawing.dataPoints))pointCount+=drawing.dataPoints.length;"
    + "else if(drawing.dataPoint)pointCount+=1;}"
    + "return JSON.stringify({entityCount:drawings.length,pointCount,typeCounts});"
    + "}catch{return null;}})()";
  const value = await evaluate(cdp, expression);
  return typeof value === "string" ? JSON.parse(value) : null;
}

function sameTypeCounts(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function runtimeMatchesSavedSummary(runtimeSummary, savedSummary) {
  return Boolean(runtimeSummary && savedSummary
    && runtimeSummary.entityCount === savedSummary.entityCount
    && runtimeSummary.pointCount === savedSummary.pointCount
    && sameTypeCounts(runtimeSummary.typeCounts, savedSummary.typeCounts));
}

async function waitForSavedDrawingCount(cdp, storageKey, expectedCount, timeoutMs) {
  const started = Date.now();
  let count = -1;
  let lastError = null;
  do {
    try {
      count = await readSavedDrawingCount(cdp, storageKey);
      lastError = null;
      if (count === expectedCount) {
        return {
          expectedCount,
          count,
          matched: true,
          waitedMs: Date.now() - started,
          error: null,
        };
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  } while (Date.now() - started < timeoutMs);

  return {
    expectedCount,
    count,
    matched: false,
    waitedMs: Date.now() - started,
    error: lastError?.message || null,
  };
}

function expectedDrawingCountAfterAction(scenario, fixture) {
  const configuredDelta = Number(scenario?.expectedEntityDelta);
  const entityDelta = Number.isSafeInteger(configuredDelta)
    ? configuredDelta
    : scenario.action === "active-freehand" ? 1 : 0;
  return Math.max(0, fixture.metadata.drawingCount + entityDelta);
}

function expectedDrawingTypesAfterAction(scenario, fixture) {
  const typeCounts = { ...(fixture.metadata.drawingTypes || {}) };
  const configured = scenario?.expectedTypeDeltas;
  const deltas = configured && typeof configured === "object" && !Array.isArray(configured)
    ? configured
    : scenario.action === "active-freehand" ? { freehand: 1 } : {};
  for (const [type, rawDelta] of Object.entries(deltas)) {
    const delta = Number(rawDelta);
    if (!Number.isSafeInteger(delta)) return null;
    typeCounts[type] = (typeCounts[type] || 0) + delta;
    if (typeCounts[type] === 0) delete typeCounts[type];
  }
  return typeCounts;
}

function createReloadRestoreResult(expectedCount, persisted, persistedSummary = null) {
  const reloadedCount = persisted.count >= 0 ? persisted.count : expectedCount;
  return {
    attempted: false,
    fixtureBootstrapRemovedBeforeReload: false,
    fixtureWriteBlockedOnReload: false,
    expectedSavedDrawingCount: expectedCount,
    savedDrawingCountBeforeReload: persisted.count,
    persistenceMatchedBeforeReload: persisted.matched,
    persistenceWaitedMs: persisted.waitedMs,
    savedSummaryBeforeReload: persistedSummary,
    reloadExpectedDrawingCount: reloadedCount,
    reloadDocumentGeneration: null,
    savedDrawingCountAfterReload: null,
    loadedDrawingCountAfterReload: null,
    runtimeSummaryAfterReload: null,
    runtimeSummaryMatchesSaved: false,
    drawingEngineDomEvidenceAfterReload: null,
    chartReadyAfterReload: false,
    drawingEngineReadyAfterReload: false,
    drawingEngineExpectedAfterReload: expectedCount > 0,
    drawingEngineRequirementSatisfiedAfterReload: false,
    drawingPerfHandleReadyAfterReload: false,
    reloadWaitedMs: null,
    durationMs: null,
    passed: false,
    error: null,
  };
}

async function verifyReloadRestore(
  cdp,
  fixture,
  expectedCount,
  persisted,
  persistedSummary,
  args,
) {
  const started = Date.now();
  const result = createReloadRestoreResult(expectedCount, persisted, persistedSummary);
  result.fixtureBootstrapRemovedBeforeReload = true;
  result.fixtureWriteBlockedOnReload = true;

  try {
    result.attempted = true;
    result.reloadDocumentGeneration = await reloadFreshDrawingPerformanceDocument(cdp, {
      timeoutMs: args.timeoutMs,
    });
    let ready = await waitForChartReady(cdp, result.reloadExpectedDrawingCount, args.timeoutMs);
    const evidenceRequired = shouldRequireDrawingEngineDomEvidenceForPerformance(args);
    if (evidenceRequired && ready.drawingReady !== true) {
      const activated = await selectToolVariantFromCandidates(
        cdp,
        ["pen", "highlighter"],
        "pen",
      );
      if (!activated) {
        throw new Error("Phase 8 reload could not activate the lazy drawing host for DOM evidence");
      }
      ready = await waitForChartReady(
        cdp,
        result.reloadExpectedDrawingCount,
        args.timeoutMs,
        { requireDrawingEngine: true },
      );
    }
    result.drawingEngineDomEvidenceAfterReload = await readDrawingEngineDomEvidence(cdp, args);
    const savedDrawingCountAfterReload = await readSavedDrawingCount(cdp, fixture.storageKey);
    result.savedDrawingCountAfterReload = savedDrawingCountAfterReload;
    result.loadedDrawingCountAfterReload = ready.loadedDrawingCount;
    result.runtimeSummaryAfterReload = ready.runtimeSummary;
    result.runtimeSummaryMatchesSaved = runtimeMatchesSavedSummary(
      ready.runtimeSummary,
      persistedSummary,
    );
    result.chartReadyAfterReload = ready.chartReady && ready.chartPresent;
    result.drawingEngineReadyAfterReload = ready.drawingReady;
    result.drawingEngineRequirementSatisfiedAfterReload = expectedCount === 0
      || ready.drawingReady;
    result.drawingPerfHandleReadyAfterReload = ready.drawingHandlePresent;
    result.reloadWaitedMs = ready.waitedMs;
    result.passed = result.persistenceMatchedBeforeReload
      && savedDrawingCountAfterReload === expectedCount
      && ready.loadedDrawingCount === expectedCount
      && result.runtimeSummaryMatchesSaved
      && result.chartReadyAfterReload
      && result.drawingEngineRequirementSatisfiedAfterReload
      && result.drawingPerfHandleReadyAfterReload
      && result.drawingEngineDomEvidenceAfterReload.passed;
    if (!result.passed) {
      result.error = result.drawingEngineDomEvidenceAfterReload.passed
        ? "Reload completed but persisted and restored drawing evidence did not match"
        : formatDrawingEngineDomEvidenceFailure(
            result.drawingEngineDomEvidenceAfterReload,
            "Drawing performance reload",
          );
    }
  } catch (error) {
    result.error = error.message;
  }
  result.durationMs = Date.now() - started;
  return result;
}

async function readDrawingSnapshots(cdp) {
  return evaluateJson(cdp, () => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const flushed = handle?.flush?.("benchmark-end") || null;
    const snapshot = handle?.report?.() || flushed?.snapshot || null;
    const rawCapture = handle?.drainRawCapture?.() || null;
    const runtimeSummary = handle?.readRuntimeSummary?.() || null;
    const bench = window.__CANDLESCOPE_DRAWING_BENCH__?.report?.() || null;
    const perf = window.__CANDLESCOPE_PERF__?.report?.() || null;
    return { snapshot, rawCapture, runtimeSummary, bench, perf };
  });
}

async function waitForPhase6SceneReady(cdp, {
  expectedRawPoints,
  requireWorker,
  timeoutMs,
}) {
  const started = Date.now();
  let latest = null;
  let stableKey = null;
  let stableSince = null;
  while (Date.now() - started < timeoutMs) {
    latest = await evaluateJson(cdp, () => {
      const runtime = window.__CANDLESCOPE_DRAWING_PERF__?.readPhase6Runtime?.() || null;
      if (!runtime) return null;
      const requested = runtime.lastRequestedStamp;
      const published = runtime.lastPublishedStamp;
      return {
        ...runtime,
        stampCurrent: Boolean(requested && published
        && requested.scopeKey === published.scopeKey
        && requested.documentRevision === published.documentRevision
        && requested.surfaceGeneration === published.surfaceGeneration
        && requested.dataRevision === published.dataRevision
        && requested.projectionRevision === published.projectionRevision
        && requested.lineageIndexRevision === published.lineageIndexRevision
        && requested.viewportRevision === published.viewportRevision
        && requested.themeRevision === published.themeRevision
        && requested.widthCssPx === published.widthCssPx
        && requested.heightCssPx === published.heightCssPx
        && requested.dpr === published.dpr),
      };
    });
    const ready = phase6SceneReadiness(latest, { expectedRawPoints, requireWorker });
    if (ready) {
      const nextStableKey = JSON.stringify({
        backend: latest.backend,
        renderedPoints: latest.renderedPoints,
        requested: latest.lastRequestedStamp,
        published: latest.lastPublishedStamp,
        workerJobs: latest.workerJobDelta,
        workerResults: latest.workerResultDelta,
      });
      if (nextStableKey !== stableKey) {
        stableKey = nextStableKey;
        stableSince = Date.now();
      } else if (stableSince !== null && Date.now() - stableSince >= 250) {
        await waitNextAnimationFrame(cdp);
        return latest;
      }
    } else {
      stableKey = null;
      stableSince = null;
    }
    await wait(25);
  }
  throw new Error("Phase 6 restored scene did not reach a painted current stamp: "
    + JSON.stringify(latest));
}

async function runOneScenario(
  cdp,
  scenario,
  fixture,
  args,
  iteration,
  warmup,
  diagnostics,
  browserWindowId,
) {
  let bootstrapIdentifier = await installScenarioBootstrap(cdp, fixture, scenario);
  const runStartedAt = Date.now();
  const consoleStart = diagnostics.consoleErrors.length;
  const exceptionStart = diagnostics.runtimeExceptions.length;
  const networkStart = diagnostics.networkFailures.length;
  try {
    await ensureHeadedBenchmarkWindow(cdp, browserWindowId, args.headless);
    // Every iteration uses the same temporary browser profile and drawing
    // scope. Clear both persistence authorities before navigation so the
    // next-document bootstrap is the only fixture source. In particular, a
    // canonical IDB record produced by a prior mutating run must not shadow
    // the newly seeded legacy compatibility snapshot.
    const scenarioUrl = args.url + (args.url.includes("?") ? "&" : "?")
      + "drawingPerf=" + encodeURIComponent(scenario.id + "-" + iteration);
    await navigateToDrawingPerformanceScenario(cdp, args.url, scenarioUrl);
    let ready = await waitForChartReady(
      cdp,
      fixture.metadata.drawingCount,
      args.timeoutMs,
    );
    if ((args.phase === "phase5" || args.phase === "phase6")
      && ready.drawingReady !== true) {
      // The production app intentionally lazy-mounts DrawingEngineHost when
      // an empty document has no active drawing tool. Activate a real tool
      // outside the measured window, then require the full host and overlay
      // surfaces before resetting counters or dispatching scenario input.
      const activated = await selectToolVariantFromCandidates(
        cdp,
        ["pen", "highlighter"],
        "pen",
      );
      if (!activated) throw new Error("Phase 5 could not activate the lazy drawing host");
      ready = await waitForChartReady(
        cdp,
        fixture.metadata.drawingCount,
        args.timeoutMs,
        { requireDrawingEngine: true },
      );
    }
    const drawingEngineDomEvidence = await readDrawingEngineDomEvidence(cdp, args);
    if (drawingEngineDomEvidence.required && !drawingEngineDomEvidence.passed) {
      throw new Error(formatDrawingEngineDomEvidenceFailure(
        drawingEngineDomEvidence,
        "Drawing performance",
      ));
    }
    const rect = await getChartRect(cdp);
    if (!rect || rect.width < 200 || rect.height < 120) {
      throw new Error("Chart rectangle is unavailable or too small");
    }
    const initialRestoredCount = await readSavedDrawingCount(cdp, fixture.storageKey);
    if (initialRestoredCount !== fixture.metadata.drawingCount) {
      throw new Error("Expected " + fixture.metadata.drawingCount
        + " restored drawings, observed " + initialRestoredCount);
    }
    const initialSavedSummary = await readSavedDrawingSummary(cdp, fixture.storageKey);
    const expectedFixtureSummary = {
      entityCount: fixture.metadata.drawingCount,
      pointCount: fixture.metadata.pointCount,
      typeCounts: fixture.metadata.drawingTypes,
    };
    if (!runtimeMatchesSavedSummary(ready.runtimeSummary, initialSavedSummary)
      || !runtimeMatchesSavedSummary(ready.runtimeSummary, expectedFixtureSummary)) {
      throw new Error("The application runtime did not restore the fixture entity/type/point summary");
    }

    if (fixture.metadata.drawingCount > 0) {
      // The drawing host can become ready before Lightweight Charts has
      // painted every restored legacy primitive. Reset the time scale outside
      // the measured window so every scenario starts from the same visible
      // range and publishes a coherent last-paint snapshot.
      await resetTimeScaleWarmup(cdp, rect);
    }
    if (scenario.action === "phase6-active-finalize") {
      await activatePhase5FreehandTool(cdp, "pen");
      await waitNextAnimationFrame(cdp);
      await waitNextAnimationFrame(cdp);
    }
    if (args.phase === "phase6") {
      const hasFreehandFixture = fixture.metadata.freehandPointCount > 0;
      await waitForPhase6SceneReady(cdp, {
        expectedRawPoints: fixture.metadata.freehandPointCount,
        requireWorker: hasFreehandFixture
          && scenario.id !== PHASE6_SCENARIO_IDS.mainThreadFallback,
        timeoutMs: args.timeoutMs,
      });
    }
    const browserWindow = await ensureHeadedBenchmarkWindow(
      cdp,
      browserWindowId,
      args.headless,
    );
    await wait(100);
    const shadowParityRequested = Boolean(await evaluate(cdp, "(() => {"
      + "window.__CANDLESCOPE_DRAWING_BENCH__?.reset?.();"
      + "const handle=window.__CANDLESCOPE_DRAWING_PERF__;"
      + "handle?.reset?.();"
      + "return handle?.requestShadowParity?.()===true;"
      + "})()"));
    if (args.engineMode === "shadow" && fixture.metadata.drawingCount > 0) {
      if (!shadowParityRequested) {
        throw new Error("Shadow scene was not active after the benchmark counter reset");
      }
      const parityEvidence = await waitForShadowParityCoverage(
        cdp,
        Math.min(args.timeoutMs, 10_000),
      );
      if (!parityEvidence?.passed) {
        throw new Error("Shadow parity did not cover a visible entity and hit after reset: "
          + JSON.stringify(parityEvidence?.evidence || null));
      }
    }
    // Initial parity is a fixture/readiness assertion, not part of the user
    // action window. Keep its drawing counters as coverage evidence, but reset
    // browser timing so its low-frequency full parity probe cannot be counted
    // as a new action Long Task in the formal legacy/shadow comparison.
    await evaluate(cdp, "window.__CANDLESCOPE_DRAWING_BENCH__?.reset?.(); true");
    let phase4Probe = null;
    let phase5Probe = null;
    let phase6Probe = null;
    let phase6CurrentPaintBaseline = null;
    if (args.phase === "phase4") {
      const startedProbe = await startPhase4FrameProbe(cdp);
      if (startedProbe?.started !== true) {
        throw new Error("Phase 4 frame probe could not start: " + JSON.stringify(startedProbe));
      }
    }
    const phase5ProbeRequired = args.phase === "phase5"
      || scenario.action === "phase6-active-finalize";
    if (phase5ProbeRequired) {
      const startedProbe = await startPhase5Probe(cdp);
      if (startedProbe?.started !== true) {
        throw new Error("Phase 5 interaction probe could not start: " + JSON.stringify(startedProbe));
      }
    }
    if (args.phase === "phase6") {
      const startedProbe = await startPhase6Probe(cdp);
      if (startedProbe?.started !== true) {
        throw new Error("Phase 6 runtime probe could not start: " + JSON.stringify(startedProbe));
      }
      if (phase6ActionRequiresCurrentPaint(scenario.action)) {
        const baseline = await callPhase6Probe(cdp, "snapshot");
        phase6CurrentPaintBaseline = baseline?.runtime?.lastRequestedStamp ?? null;
        if (!phase6CurrentPaintBaseline) {
          throw new Error("Phase 6 " + scenario.action
            + " current-paint baseline stamp is missing: " + JSON.stringify(baseline));
        }
      }
    }
    const beforeMetrics = metricMap(await cdp.send("Performance.getMetrics"));
    const beforeHeap = await cdp.send("Runtime.getHeapUsage");
    const actionStartedAt = Number(await evaluate(cdp, "performance.now()"));
    let action = await runScenarioAction(
      cdp,
      scenario,
      fixture,
      args,
      rect,
      ready.runtimeSummary,
    );
    const actionEndedAt = Number(await evaluate(cdp, "performance.now()"));
    await wait(args.settleMs);
    if (args.phase === "phase6" && phase6ActionRequiresCurrentPaint(scenario.action)) {
      const paintWait = await waitForPhase6ActionCurrentPaint({
        action: scenario.action,
        previousStamp: phase6CurrentPaintBaseline,
        timeoutMs: args.timeoutMs,
        waitForCurrentPaint: (previousStamp, timeoutMs) => callPhase6Probe(
          cdp,
          "waitForCurrentPaint",
          previousStamp,
          timeoutMs,
        ),
      });
      const paint = paintWait.result;
      action = {
        ...action,
        currentPaintWaitPassed: paint?.passed === true,
        currentPaintPreviousStamp: paint?.previousStamp ?? null,
        currentPaintRequestedStamp: paint?.requestedStamp ?? null,
        currentPaintedStamp: paint?.paintedStamp ?? null,
      };
    }
    if (args.phase === "phase4") {
      phase4Probe = await stopPhase4FrameProbe(cdp);
      if (phase4Probe?.started !== true) {
        throw new Error("Phase 4 frame probe could not stop: " + JSON.stringify(phase4Probe));
      }
    }
    if (phase5ProbeRequired) {
      phase5Probe = await stopPhase5Probe(cdp);
      if (phase5Probe?.started !== true) {
        throw new Error("Phase 5 interaction probe could not stop: " + JSON.stringify(phase5Probe));
      }
    }
    let measurementEndedAt = null;
    let measurementBench = null;
    if (scenario.action === "phase6-hit-index") {
      // The provider intentionally computes both indexed and brute-force
      // answers. Close the production action/Long-Task window first, retain
      // its browser timing snapshot, then collect parity and the indexed-only
      // hitQueryMs samples without charging brute-force oracle CPU to the gate.
      measurementEndedAt = Number(await evaluate(cdp, "performance.now()"));
      measurementBench = await evaluateJson(
        cdp,
        () => window.__CANDLESCOPE_DRAWING_BENCH__?.report?.() || null,
      );
      action = await completePhase6HitOracle(cdp, action, ready.runtimeSummary);
    }
    if (args.phase === "phase6") {
      phase6Probe = await stopPhase6Probe(cdp);
      if (phase6Probe?.started !== true) {
        throw new Error("Phase 6 runtime probe could not stop: " + JSON.stringify(phase6Probe));
      }
    }
    if (args.engineMode === "shadow" && fixture.metadata.drawingCount > 0) {
      const finalParity = await requestFinalShadowParity(
        cdp,
        Math.min(args.timeoutMs, 10_000),
      );
      if (!finalParity.passed) {
        throw new Error("Final shadow parity did not complete cleanly after the scenario action: "
          + JSON.stringify(finalParity.evidence || null));
      }
    }
    measurementEndedAt ??= Number(await evaluate(cdp, "performance.now()"));
    const snapshots = await readDrawingSnapshots(cdp);
    const afterMetrics = metricMap(await cdp.send("Performance.getMetrics"));
    const afterHeap = await cdp.send("Runtime.getHeapUsage");
    const drawing = snapshots?.snapshot;
    const bench = measurementBench ?? snapshots?.bench;
    const rawCapture = snapshots?.rawCapture;
    const runtimeSummary = snapshots?.runtimeSummary;
    const captures = {
      drawingMainThreadMs: durationCapture(rawCapture, drawing, "drawingMainThreadMs"),
      sceneProjectPaintMs: durationCapture(rawCapture, drawing, "sceneProjectPaintMs"),
      hitQueryMs: durationCapture(rawCapture, drawing, "hitQueryMs"),
      mouseupSyncMs: durationCapture(rawCapture, drawing, "mouseupSyncMs"),
      mouseupFinalizeMs: durationCapture(rawCapture, drawing, "mouseupFinalizeMs"),
      mouseupCommandMs: durationCapture(rawCapture, drawing, "mouseupCommandMs"),
      mouseupCommitMs: durationCapture(rawCapture, drawing, "mouseupCommitMs"),
      persistenceMs: durationCapture(rawCapture, drawing, "persistenceMs"),
      activeOverlayCpuMs: durationCapture(rawCapture, drawing, "activeOverlayCpuMs"),
      workerFinalizeMs: durationCapture(rawCapture, drawing, "workerFinalizeMs"),
      exactRenderMs: durationCapture(rawCapture, drawing, "exactRenderMs"),
      frameIntervalMs: browserCapture(bench, "rafIntervalsMs"),
      inputToNextPaintMs: browserCapture(bench, "inputToNextPaintMs"),
      eventTimingMs: browserCapture(bench, "eventTimingMs"),
    };
    const counters = {
      rawPoints: maxGauge(drawing, "rawPoints"),
      renderedPoints: maxGauge(drawing, "renderedPoints"),
      visibleEntities: maxGauge(drawing, "visibleEntities"),
      culledEntities: maxGauge(drawing, "culledEntities"),
      lodRatio: maxGauge(drawing, "lodRatio"),
      anchorResolveCount: maxCounter(drawing, "anchorResolveCount"),
      finalProjectionCount: maxCounter(drawing, "finalProjectionCount"),
      sceneRebuildCount: maxCounter(drawing, "sceneRebuildCount"),
      staticProjectionCount: phase4Probe?.totalFinalProjections ?? null,
      shadowCompareCount: maxCounter(drawing, "shadowCompareCount"),
      shadowParityMismatchCount: maxCounter(drawing, "shadowParityMismatchCount"),
      shadowSkippedCount: maxCounter(drawing, "shadowSkippedCount"),
      shadowErrorCount: maxCounter(drawing, "shadowErrorCount"),
      shadowComparedEntities: maxGauge(drawing, "shadowComparedEntities"),
      shadowComparedHits: maxGauge(drawing, "shadowComparedHits"),
      shadowGapProjectionMs: maxGauge(drawing, "shadowGapProjectionMs"),
      shadowLegacyProbeMs: maxGauge(drawing, "shadowLegacyProbeMs"),
      shadowMismatchItems: maxGauge(drawing, "shadowMismatchItems"),
      shadowParityCompareMs: maxGauge(drawing, "shadowParityCompareMs"),
      shadowParityMs: maxGauge(drawing, "shadowParityMs"),
      shadowSceneBuildMs: maxGauge(drawing, "shadowSceneBuildMs"),
      requestUpdateCount: maxCounter(drawing, "requestUpdateCount"),
      requestUpdatePerFrame: phase4Probe?.maxRequestUpdatesPerFrame ?? null,
      surfacePrimitiveCount: Number.isSafeInteger(runtimeSummary?.attachedPrimitiveCount)
        ? runtimeSummary.attachedPrimitiveCount
        : null,
      workerQueueDepth: maxGauge(drawing, "workerQueue"),
      workerInFlight: maxGauge(drawing, "workerInFlight"),
      staleWorkerPublishCount: maxCounter(drawing, "staleWorkerPublishCount"),
    };
    const actionEvidence = {
      ...action,
      processedInputCount: maxCounter(drawing, "inputCount"),
    };

    const expectedSavedDrawingCount = expectedDrawingCountAfterAction(scenario, fixture);
    const persisted = await waitForSavedDrawingCount(
      cdp,
      fixture.storageKey,
      expectedSavedDrawingCount,
      Math.min(args.timeoutMs, 5_000),
    );
    const persistedSummary = await readSavedDrawingSummary(cdp, fixture.storageKey);
    const expectedTypeCounts = expectedDrawingTypesAfterAction(scenario, fixture);
    const configuredPointDelta = Number(scenario?.minimumPointDelta);
    const minimumPointDelta = Number.isSafeInteger(configuredPointDelta)
      && configuredPointDelta >= 0
      ? configuredPointDelta
      : scenario.action === "active-freehand" ? 1 : 0;
    const configuredMinimumFinalPointCount = Number(scenario?.minimumFinalPointCount);
    const minimumFinalPointCount = Number.isSafeInteger(configuredMinimumFinalPointCount)
      && configuredMinimumFinalPointCount >= 0
      ? configuredMinimumFinalPointCount
      : fixture.metadata.pointCount + minimumPointDelta;
    if (!persistedSummary
      || persistedSummary.entityCount !== expectedSavedDrawingCount
      || !expectedTypeCounts
      || !sameTypeCounts(persistedSummary.typeCounts, expectedTypeCounts)
      || persistedSummary.pointCount < minimumFinalPointCount) {
      persisted.matched = false;
      persisted.error = "Persisted drawing entity/type/point summary did not match the action";
    }
    let restore;
    try {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: bootstrapIdentifier,
      });
      bootstrapIdentifier = null;
      restore = await verifyReloadRestore(
        cdp,
        fixture,
        expectedSavedDrawingCount,
        persisted,
        persistedSummary,
        args,
      );
    } catch (error) {
      restore = createReloadRestoreResult(expectedSavedDrawingCount, persisted, persistedSummary);
      restore.error = "Fixture bootstrap could not be removed before reload: " + error.message;
      restore.durationMs = 0;
    }

    return {
      id: scenario.id + "-" + iteration,
      iteration,
      warmup,
      samples: {
        drawingMainThreadMs: captures.drawingMainThreadMs.samples,
        inputToNextPaintMs: captures.inputToNextPaintMs.samples,
        eventTimingMs: captures.eventTimingMs.samples,
        sceneProjectPaintMs: captures.sceneProjectPaintMs.samples,
        frameIntervalMs: captures.frameIntervalMs.samples,
        hitQueryMs: captures.hitQueryMs.samples,
        mouseupSyncMs: captures.mouseupSyncMs.samples,
        mouseupFinalizeMs: captures.mouseupFinalizeMs.samples,
        mouseupCommandMs: captures.mouseupCommandMs.samples,
        mouseupCommitMs: captures.mouseupCommitMs.samples,
        workerFinalizeMs: captures.workerFinalizeMs.samples,
        persistenceMs: captures.persistenceMs.samples,
        exactRenderMs: captures.exactRenderMs.samples,
        activeOverlayCpuMs: captures.activeOverlayCpuMs.samples,
      },
      sampleCompleteness: Object.fromEntries(Object.entries(captures)
        .map(([key, capture]) => [key, capture.completeness])),
      counters,
      longTasks: bench?.longTasks || [],
      drawingWindows: [{
        startTime: actionStartedAt,
        endTime: measurementEndedAt,
        name: scenario.action,
      }],
      scriptDurationMs: metricDelta(beforeMetrics, afterMetrics, "ScriptDuration"),
      heap: {
        before: beforeHeap.result || null,
        after: afterHeap.result || null,
        usedSizeDelta: Number(afterHeap.result?.usedSize) - Number(beforeHeap.result?.usedSize),
      },
      worker: {
        queueDepthMax: counters.workerQueueDepth,
        inFlightMax: counters.workerInFlight,
        staleResultPublishCount: maxCounter(drawing, "staleWorkerResultCount"),
        staleWorkerPublishCount: counters.staleWorkerPublishCount,
      },
      fixture: fixture.metadata,
      ready,
      restoredCount: initialRestoredCount,
      initialRestoredCount,
      initialSavedSummary,
      initialRuntimeSummary: ready.runtimeSummary,
      drawingEngineDomEvidence,
      restore,
      action: actionEvidence,
      phase4Probe,
      phase5Probe,
      phase6Probe,
      measurementWindow: {
        actionStartedAt,
        actionEndedAt,
        measurementEndedAt,
        settleMs: args.settleMs,
      },
      bench: {
        inputEvents: bench?.inputEvents ?? 0,
        eventTimingSupported: bench?.eventTimingSupported === true,
        longTaskSupported: bench?.longTaskSupported === true,
        devicePixelRatio: bench?.devicePixelRatio ?? null,
        viewport: bench?.viewport ?? null,
        captureStats: bench?.captureStats ?? null,
      },
      browserWindow,
      drawingSnapshot: drawing,
      drawingRawCapture: rawCapture,
      runtimeSummary,
      perfReport: snapshots?.perf,
      diagnostics: {
        consoleErrors: diagnostics.consoleErrors.slice(consoleStart),
        runtimeExceptions: diagnostics.runtimeExceptions.slice(exceptionStart),
        networkFailures: diagnostics.networkFailures.slice(networkStart),
      },
      durationMs: Date.now() - runStartedAt,
    };
  } finally {
    if (bootstrapIdentifier) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: bootstrapIdentifier,
      }).catch(() => {});
    }
  }
}

function readGitContext() {
  const run = (args) => execFileSync("git", args, {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const buildInputPathspecs = [
    "public",
    "src",
    "scripts",
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ];
  try {
    const commit = run(["rev-parse", "HEAD"]);
    const status = run(["status", "--short"]);
    const buildInputStatus = run([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ...buildInputPathspecs,
    ]);
    return {
      commit,
      shortCommit: commit.slice(0, 8),
      dirty: status.length > 0,
      status: status ? status.split(/\r?\n/) : [],
      buildInputsDirty: buildInputStatus.length > 0,
      buildInputStatus: buildInputStatus ? buildInputStatus.split(/\r?\n/) : [],
      buildInputFingerprint: hashBuildInputs(),
    };
  } catch {
    return {
      commit: null,
      shortCommit: "unknown",
      dirty: null,
      status: [],
      buildInputsDirty: null,
      buildInputStatus: [],
      buildInputFingerprint: hashBuildInputs(),
    };
  }
}

function hashBuildInputs() {
  const hash = createHash("sha256");
  const roots = ["public", "src", "scripts"];
  const rootFiles = [
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
  ];
  const viteEnvironmentFiles = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ];
  const files = [];
  const visit = (absolute, relative) => {
    if (!fs.existsSync(absolute)) return;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, name), path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) files.push({ absolute, relative: relative.replaceAll("\\", "/") });
  };
  for (const root of roots) visit(path.join(FRONTEND_ROOT, root), root);
  for (const file of [...rootFiles, ...viteEnvironmentFiles]) {
    visit(path.join(FRONTEND_ROOT, file), file);
  }
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function machineContext() {
  const cpu = os.cpus()?.[0]?.model || null;
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu,
    logicalCores: os.cpus()?.length || null,
    memoryBytes: os.totalmem(),
  };
}

function assertFixtureOverlapsMockPriceRange(fixture, mockMeta) {
  if (fixture.metadata.priceRange?.min == null || fixture.metadata.priceRange?.max == null) return;
  const fixtureMin = Number(fixture.metadata.priceRange?.min);
  const fixtureMax = Number(fixture.metadata.priceRange?.max);
  if (!Number.isFinite(fixtureMin) || !Number.isFinite(fixtureMax)) return;
  const mockMin = Number(mockMeta?.price_min);
  const mockMax = Number(mockMeta?.price_max);
  if (!Number.isFinite(mockMin) || !Number.isFinite(mockMax)) {
    throw new Error("Managed mock did not publish a finite price range");
  }
  if (fixtureMax < mockMin || fixtureMin > mockMax) {
    throw new Error("Fixture price range does not overlap the deterministic mock candles");
  }
}

function estimateRefreshRateHz(allScenarioRuns) {
  const intervals = allScenarioRuns.flatMap(({ runs }) => runs
    .filter((run) => !run.warmup)
    .flatMap((run) => run.samples.frameIntervalMs))
    .filter((value) => Number.isFinite(value) && value >= 5 && value <= 50)
    .sort((left, right) => left - right);
  if (intervals.length === 0) return null;
  const median = intervals[Math.floor(intervals.length / 2)];
  return Number.isFinite(median) && median > 0
    ? Number((1_000 / median).toFixed(2))
    : null;
}

function applicableHardGates(scenarioSummary) {
  const definition = DEFAULT_SCENARIOS.find((scenario) => scenario.id === scenarioSummary.id);
  const targetMetrics = new Set(definition?.targetMetrics || []);
  const targetCounters = new Set(definition?.targetCounters || []);
  return DRAWING_PERFORMANCE_HARD_GATES.filter((gate) => {
    const metricMatch = String(gate.path || "").match(/^metrics\.([^.]+)\./);
    if (metricMatch) return targetMetrics.has(metricMatch[1]);
    const counterMatch = String(gate.path || "").match(/^counters\.([^.]+)\./);
    if (counterMatch) return targetCounters.has(counterMatch[1]);
    if (String(gate.path || "").startsWith("longTasks.")) return true;
    return false;
  });
}

function applyRestoreValidity(report, args) {
  const expectedChecksPerScenario = args.runs + args.warmupRuns;
  for (const scenario of report.scenarios) {
    const runs = Array.isArray(scenario.rawRuns) ? scenario.rawRuns : [];
    const restoreChecks = runs.map((run) => run?.restore).filter(Boolean);
    const restoreChecksComplete = runs.length === expectedChecksPerScenario
      && restoreChecks.length === expectedChecksPerScenario;
    const failedRunIds = runs
      .filter((run) => !run?.restore?.passed)
      .map((run) => run?.id ?? null);
    const restoreChecksPassed = restoreChecksComplete && failedRunIds.length === 0;
    const metricsValid = scenario.repetitions.valid;
    scenario.repetitions.metricsValid = metricsValid;
    scenario.repetitions.restoreChecksExpected = expectedChecksPerScenario;
    scenario.repetitions.restoreChecksObserved = restoreChecks.length;
    scenario.repetitions.restoreChecksComplete = restoreChecksComplete;
    scenario.repetitions.restoreChecksPassed = restoreChecksPassed;
    scenario.repetitions.failedRestoreRunIds = failedRunIds;
    scenario.repetitions.valid = metricsValid && restoreChecksPassed;
    scenario.passed = scenario.repetitions.valid && scenario.gates.passed;
  }

  const failedScenarioIds = report.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => scenario.id);
  const invalidScenarioIds = report.scenarios
    .filter((scenario) => !scenario.repetitions.valid)
    .map((scenario) => scenario.id);
  report.acceptance = {
    ...report.acceptance,
    passed: report.scenarios.length > 0 && failedScenarioIds.length === 0,
    scenarioCount: report.scenarios.length,
    passedScenarioCount: report.scenarios.length - failedScenarioIds.length,
    failedScenarioIds,
    invalidScenarioIds,
    restoreChecksRequired: true,
  };
}

function buildDrawingEngineDomEvidenceAcceptance(report, args) {
  const records = report.scenarios.flatMap((scenario) => (
    (scenario.rawRuns || []).map((run) => ({
      id: run?.id ?? `${scenario.id}:unknown-run`,
      initial: run?.drawingEngineDomEvidence ?? null,
      reload: run?.restore?.drawingEngineDomEvidenceAfterReload ?? null,
    }))
  ));
  return summarizeDrawingEngineDomEvidenceAssessments(records, {
    required: shouldRequireDrawingEngineDomEvidenceForPerformance(args),
  });
}

function buildPhase0Acceptance(report, args) {
  const heavy = report.scenarios.find((scenario) => scenario.id === "freehand-64x512-viewport");
  const active = report.scenarios.find((scenario) => scenario.id === "active-freehand-4096");
  const presentScenarioIds = new Set(report.scenarios.map((scenario) => scenario.id));
  const missingRequiredScenarioIds = PHASE0_REQUIRED_SCENARIO_IDS
    .filter((scenarioId) => !presentScenarioIds.has(scenarioId));
  const requiredScenarioCoveragePassed = missingRequiredScenarioIds.length === 0;
  const measuredRunCoveragePassed = args.runs >= PHASE0_MIN_MEASURED_RUNS
    && report.scenarios.every((scenario) => (
      scenario.repetitions.measuredRuns >= PHASE0_MIN_MEASURED_RUNS
    ));
  const warmupCoveragePassed = args.warmupRuns >= PHASE0_MIN_WARMUP_RUNS
    && report.scenarios.every((scenario) => (
      scenario.repetitions.warmupRuns >= PHASE0_MIN_WARMUP_RUNS
    ));
  const executionPassed = report.executionAcceptance?.passed === true;
  const phase0Runs = report.scenarios.flatMap((scenario) => scenario.rawRuns || []);
  const instrumentationCoveragePassed = phase0Runs.length > 0 && phase0Runs.every((run) => (
    run.drawingRawCapture?.enabled === true
    && run.bench?.eventTimingSupported === true
    && run.sampleCompleteness?.eventTimingMs?.complete === true
    && Number(run.sampleCompleteness?.eventTimingMs?.observed) > 0
    && Number(run.sampleCompleteness?.eventTimingMs?.dropped) === 0
    && run.bench?.longTaskSupported === true
    && Number.isFinite(run.scriptDurationMs)
    && Number.isFinite(run.heap?.before?.usedSize)
    && Number.isFinite(run.heap?.after?.usedSize)
    && Number.isFinite(run.worker?.queueDepthMax)
  ));
  const restoreChecksPassed = report.scenarios.length > 0
    && report.scenarios.every((scenario) => scenario.repetitions.restoreChecksPassed);
  const geometryCounterCoveragePassed = report.scenarios
    .filter((scenario) => Number(scenario.fixture?.entities) > 0)
    .every((scenario) => (scenario.rawRuns || []).every((run) => (
      Number(run.counters?.rawPoints) >= Number(scenario.fixture.points)
      && Number(run.counters?.renderedPoints) > 0
      && Number(run.counters?.visibleEntities) > 0
      && typeof run.counters?.culledEntities === "number"
      && Number.isFinite(run.counters.culledEntities)
      && run.counters.culledEntities >= 0
      && Number(run.counters?.lodRatio) > 0
      && Number(run.counters?.anchorResolveCount) > 0
      && Number(run.counters?.finalProjectionCount) > 0
      && Number(run.counters?.sceneRebuildCount) > 0
    )));
  const heavyFixturePassed = heavy?.fixture?.entities === 64
    && heavy?.fixture?.points === 32_768;
  const activeFixturePassed = active?.fixture?.entities === 200
    && active?.fixture?.points === 400;
  const heavyReproduced = Boolean(heavy && heavyFixturePassed && (
    (heavy.metrics.frameIntervalMs.p95 ?? 0) > 33.4
    || heavy.longTasks.attributableCount > 0
  ));
  const activeMeasuredRuns = active?.rawRuns?.filter((run) => !run.warmup) ?? [];
  const activeRunCoverage = args.pointerSamples === PHASE0_POINTER_SAMPLES
    && activeFixturePassed
    && activeMeasuredRuns.length >= PHASE0_MIN_MEASURED_RUNS
    && activeMeasuredRuns.every((run) => (
      run.action?.pointerSamplesDispatched === PHASE0_POINTER_SAMPLES
      && run.action?.processedInputCount >= PHASE0_POINTER_SAMPLES
      && Number(run.counters?.rawPoints) > Number(active.fixture.points)
      && Number(run.counters?.visibleEntities) > Number(active.fixture.entities)
      && Number(run.counters?.requestUpdateCount) > 0
      && run.restore?.runtimeSummaryMatchesSaved === true
    ));
  const activeReproduced = Boolean(active && activeFixturePassed && (
    (active.metrics.frameIntervalMs.p99 ?? 0) > 33.4
    || active.longTasks.attributableCount > 0
  ));
  const productionBuildPassed = report.environment?.productionBuild === true
    && report.environment?.productionBuildVerification === "managed-vite-preview";
  const phase0Eligible = !args.smoke && productionBuildPassed;
  const passed = phase0Eligible
    && requiredScenarioCoveragePassed
    && measuredRunCoveragePassed
    && warmupCoveragePassed
    && executionPassed
    && instrumentationCoveragePassed
    && geometryCounterCoveragePassed
    && restoreChecksPassed
    && heavyReproduced
    && activeRunCoverage
    && activeReproduced;
  const failureReasons = [];
  if (args.smoke) failureReasons.push("smoke-only-run");
  if (!productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!requiredScenarioCoveragePassed) failureReasons.push("missing-required-scenarios");
  if (!measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!instrumentationCoveragePassed) failureReasons.push("instrumentation-coverage-incomplete");
  if (!geometryCounterCoveragePassed) failureReasons.push("geometry-counter-coverage-incomplete");
  if (!restoreChecksPassed) failureReasons.push("reload-restore-check-failed");
  if (!heavyReproduced) failureReasons.push("heavy-stall-not-reproduced");
  if (!activeRunCoverage) failureReasons.push("active-4096-coverage-failed");
  if (!activeReproduced) failureReasons.push("active-stall-not-reproduced");
  return {
    passed,
    smokeOnly: args.smoke,
    phase0Eligible,
    productionBuildPassed,
    requiredScenarioIds: [...PHASE0_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds,
    requiredScenarioCoveragePassed,
    minimumMeasuredRuns: PHASE0_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE0_MIN_WARMUP_RUNS,
    warmupCoveragePassed,
    executionPassed,
    instrumentationCoveragePassed,
    geometryCounterCoveragePassed,
    restoreChecksPassed,
    heavyFixturePassed,
    heavyReproduced,
    activeFixturePassed,
    activeRunCoverage,
    activeReproduced,
    expectedLegacyTargetMiss: true,
    failureReasons,
  };
}

function buildSmokeAcceptance(report, args) {
  const executionPassed = report.executionAcceptance?.passed === true;
  const phase3RequirementsPassed = args.phase !== "phase3"
    || (report.phase3Acceptance?.engineModePassed === true
      && report.phase3Acceptance?.parityPassed === true
      && report.phase3Acceptance?.sceneBuildBudgetPassed === true);
  const phase4RequirementsPassed = args.phase !== "phase4"
    || (report.phase4Acceptance?.engineModePassed === true
      && report.phase4Acceptance?.migratedFixturePassed === true
      && report.phase4Acceptance?.mixedFixturePassed === true
      && report.phase4Acceptance?.crosshairRebuildPassed === true
      && report.phase4Acceptance?.viewportRequestUpdatePassed === true
      && report.phase4Acceptance?.freehandViewUpdateFanoutPassed === true);
  return {
    applicable: args.smoke,
    smokeOnly: args.smoke,
    passed: args.smoke
      && executionPassed
      && phase3RequirementsPassed
      && phase4RequirementsPassed,
    executionPassed,
    phase3RequirementsPassed,
    phase4RequirementsPassed,
    scenarioCount: report.scenarios.length,
    invalidScenarioIds: [...(report.executionAcceptance?.invalidScenarioIds ?? [])],
    note: args.smoke
      ? "Smoke reports never satisfy Phase 0 acceptance."
      : "Use --smoke explicitly for a non-Phase-0 subset run.",
  };
}

function buildPhase1Acceptance(report, args) {
  const phase0Structure = buildPhase0Acceptance(report, args);
  const viewportScenarioIds = new Set([
    "single-freehand-4096-viewport",
    "freehand-64x512-viewport",
  ]);
  const viewportScenarios = report.scenarios
    .filter((scenario) => viewportScenarioIds.has(scenario.id));
  const viewportAnchorCachePassed = viewportScenarios.length === viewportScenarioIds.size
    && viewportScenarios.every((scenario) => {
      const measuredRuns = (scenario.rawRuns || []).filter((run) => !run.warmup);
      return measuredRuns.length >= PHASE0_MIN_MEASURED_RUNS
        && measuredRuns.every((run) => Number(run.counters?.anchorResolveCount) === 0);
    });
  const geometryProjectionCoveragePassed = report.scenarios
    .filter((scenario) => Number(scenario.fixture?.entities) > 0)
    .every((scenario) => (scenario.rawRuns || []).every((run) => (
      Number(run.counters?.rawPoints) >= Number(scenario.fixture.points)
      && Number(run.counters?.renderedPoints) > 0
      && Number(run.counters?.visibleEntities) > 0
      && Number(run.counters?.finalProjectionCount) > 0
      && Number(run.counters?.sceneRebuildCount) > 0
    )));
  const projectorMode = report.configuration?.drawingCoordinateProjectorMode;
  const batchProjectorPassed = projectorMode === "batch";
  const performanceComparisonPassed = report.phase1Comparison?.passed === true;
  const phase1Eligible = !args.smoke && phase0Structure.productionBuildPassed;
  const passed = phase1Eligible
    && batchProjectorPassed
    && phase0Structure.requiredScenarioCoveragePassed
    && phase0Structure.measuredRunCoveragePassed
    && phase0Structure.warmupCoveragePassed
    && phase0Structure.executionPassed
    && phase0Structure.instrumentationCoveragePassed
    && phase0Structure.restoreChecksPassed
    && phase0Structure.heavyFixturePassed
    && phase0Structure.activeFixturePassed
    && phase0Structure.activeRunCoverage
    && geometryProjectionCoveragePassed
    && viewportAnchorCachePassed
    && performanceComparisonPassed;
  const failureReasons = [];
  if (args.smoke) failureReasons.push("smoke-only-run");
  if (!phase0Structure.productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!batchProjectorPassed) failureReasons.push("batch-projector-not-selected");
  if (!phase0Structure.requiredScenarioCoveragePassed) failureReasons.push("missing-required-scenarios");
  if (!phase0Structure.measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!phase0Structure.warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!phase0Structure.executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!phase0Structure.instrumentationCoveragePassed) {
    failureReasons.push("instrumentation-coverage-incomplete");
  }
  if (!phase0Structure.restoreChecksPassed) failureReasons.push("reload-restore-check-failed");
  if (!phase0Structure.heavyFixturePassed) failureReasons.push("heavy-fixture-mismatch");
  if (!phase0Structure.activeFixturePassed) failureReasons.push("active-fixture-mismatch");
  if (!phase0Structure.activeRunCoverage) failureReasons.push("active-4096-coverage-failed");
  if (!geometryProjectionCoveragePassed) failureReasons.push("geometry-projection-coverage-incomplete");
  if (!viewportAnchorCachePassed) failureReasons.push("viewport-anchor-cache-miss");
  if (!performanceComparisonPassed) failureReasons.push("performance-comparison-failed");
  return {
    passed,
    smokeOnly: args.smoke,
    phase1Eligible,
    productionBuildPassed: phase0Structure.productionBuildPassed,
    projectorMode,
    batchProjectorPassed,
    requiredScenarioIds: [...PHASE0_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds: phase0Structure.missingRequiredScenarioIds,
    requiredScenarioCoveragePassed: phase0Structure.requiredScenarioCoveragePassed,
    minimumMeasuredRuns: PHASE0_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed: phase0Structure.measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE0_MIN_WARMUP_RUNS,
    warmupCoveragePassed: phase0Structure.warmupCoveragePassed,
    executionPassed: phase0Structure.executionPassed,
    instrumentationCoveragePassed: phase0Structure.instrumentationCoveragePassed,
    restoreChecksPassed: phase0Structure.restoreChecksPassed,
    geometryProjectionCoveragePassed,
    viewportAnchorCachePassed,
    performanceComparisonPassed,
    activeRunCoverage: phase0Structure.activeRunCoverage,
    failureReasons,
  };
}

function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function phase3MachineIdentity(machine) {
  return {
    platform: machine?.platform ?? null,
    release: machine?.release ?? null,
    arch: machine?.arch ?? null,
    cpu: machine?.cpu ?? null,
    logicalCores: machine?.logicalCores ?? null,
  };
}

function comparablePhase3BuildEnvironment(environment) {
  if (!environment || typeof environment !== "object") return null;
  const { VITE_DRAWING_ENGINE_MODE: _engineMode, ...sharedEnvironment } = environment;
  return sharedEnvironment;
}

function assessFormalPhase3Report(candidate, mode) {
  const scenarios = Array.isArray(candidate?.scenarios) ? candidate.scenarios : [];
  const ids = new Set(scenarios.map((scenario) => scenario?.id));
  const gitCommit = candidate?.context?.git?.commit;
  const buildInputFingerprint = candidate?.context?.git?.buildInputFingerprint;
  const machine = phase3MachineIdentity(candidate?.context?.machine);
  const scenarioCoverage = scenarios.length === PHASE0_REQUIRED_SCENARIO_IDS.length
    && PHASE0_REQUIRED_SCENARIO_IDS.every((id) => ids.has(id));
  const repetitionCoverage = scenarioCoverage && scenarios.every((scenario) => {
    const rawRuns = Array.isArray(scenario?.rawRuns) ? scenario.rawRuns : [];
    const measuredRuns = rawRuns.filter((run) => !run?.warmup);
    const warmupRuns = rawRuns.filter((run) => run?.warmup);
    return measuredRuns.length >= PHASE0_MIN_MEASURED_RUNS
      && warmupRuns.length >= PHASE0_MIN_WARMUP_RUNS
      && Number(scenario?.repetitions?.measuredRuns) === measuredRuns.length
      && Number(scenario?.repetitions?.warmupRuns) === warmupRuns.length;
  });
  const longTaskInstrumentation = repetitionCoverage && scenarios.every((scenario) => (
    scenario.rawRuns.filter((run) => !run?.warmup)
      .every((run) => run?.bench?.longTaskSupported === true)
  ));
  const machineIdentityPresent = Object.entries(machine).every(([key, value]) => (
    key === "logicalCores"
      ? Number.isSafeInteger(value) && value > 0
      : typeof value === "string" && value.length > 0
  ));
  const checks = {
    mode: candidate?.context?.mode === mode
      && candidate?.configuration?.drawingEngineMode === mode,
    phase: candidate?.runMode?.name === "phase3",
    formalRun: candidate?.runMode?.smokeOnly === false,
    productionBuild: candidate?.environment?.productionBuild === true
      && candidate?.environment?.productionBuildVerification === "managed-vite-preview",
    execution: candidate?.executionAcceptance?.passed === true,
    scenarioCoverage,
    repetitionCoverage,
    longTaskInstrumentation,
    gitCommit: typeof gitCommit === "string" && GIT_COMMIT_PATTERN.test(gitCommit),
    buildInputFingerprint: typeof buildInputFingerprint === "string"
      && SHA256_PATTERN.test(buildInputFingerprint),
    machineIdentity: machineIdentityPresent,
    browserVersion: typeof candidate?.context?.browser?.version === "string"
      && candidate.context.browser.version.length > 0,
    buildEnvironment: stableStringify(candidate?.configuration?.buildEnvironment)
      === stableStringify(managedBuildEnvironment(mode)),
  };
  const failureReasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    passed: failureReasons.length === 0,
    checks,
    failureReasons,
  };
}

function buildPhase3LegacyBaselineAcceptance(report, args) {
  const applicable = args.phase === "phase3" && args.engineMode === "legacy" && !args.smoke;
  const eligibility = assessFormalPhase3Report(report, "legacy");
  return {
    applicable,
    passed: applicable && eligibility.passed,
    eligibility,
    failureReasons: applicable
      ? eligibility.failureReasons
      : ["not-a-formal-phase3-legacy-run"],
  };
}

function buildPhase1Comparison(report, compareBefore) {
  if (!compareBefore) {
    return {
      applicable: false,
      passed: false,
      failureReasons: ["before-baseline-not-provided"],
    };
  }
  const baselinePath = path.resolve(process.cwd(), compareBefore);
  let before = null;
  try {
    before = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return {
      applicable: true,
      baselinePath,
      passed: false,
      failureReasons: ["before-baseline-unreadable"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const scenarioId = "freehand-64x512-viewport";
  const beforeScenario = before.scenarios?.find?.((scenario) => scenario?.id === scenarioId);
  const afterScenario = report.scenarios?.find?.((scenario) => scenario?.id === scenarioId);
  const beforeScriptP95 = finiteMetric(beforeScenario?.metrics?.scriptDurationMs?.p95);
  const afterScriptP95 = finiteMetric(afterScenario?.metrics?.scriptDurationMs?.p95);
  const beforeDrawingP95 = finiteMetric(beforeScenario?.metrics?.drawingMainThreadMs?.p95);
  const afterDrawingP95 = finiteMetric(afterScenario?.metrics?.drawingMainThreadMs?.p95);
  const scriptReductionRatio = beforeScriptP95 && afterScriptP95 !== null
    ? 1 - afterScriptP95 / beforeScriptP95
    : null;
  const drawingReductionRatio = beforeDrawingP95 && afterDrawingP95 !== null
    ? 1 - afterDrawingP95 / beforeDrawingP95
    : null;
  const contextChecks = {
    bars: beforeScenario?.fixture?.bars === afterScenario?.fixture?.bars,
    browser: before.context?.browser?.version === report.context?.browser?.version,
    dpr: before.environment?.dpr === report.environment?.dpr,
    entities: beforeScenario?.fixture?.entities === afterScenario?.fixture?.entities,
    fixtureDpr: beforeScenario?.fixture?.dpr === afterScenario?.fixture?.dpr,
    points: beforeScenario?.fixture?.points === afterScenario?.fixture?.points,
    seed: before.configuration?.seed === report.configuration?.seed,
    viewportHeight: before.environment?.viewport?.height === report.environment?.viewport?.height,
    viewportWidth: before.environment?.viewport?.width === report.environment?.viewport?.width,
  };
  const comparable = Object.values(contextChecks).every(Boolean);
  const scriptDurationClearlyDown = scriptReductionRatio !== null
    && scriptReductionRatio >= 0.5;
  const drawingMainClearlyDown = drawingReductionRatio !== null
    && drawingReductionRatio >= 0.5;
  const failureReasons = [];
  if (!beforeScenario || !afterScenario) failureReasons.push("heavy-scenario-missing");
  if (!comparable) failureReasons.push("baseline-context-mismatch");
  if (!scriptDurationClearlyDown) failureReasons.push("script-duration-not-clearly-down");
  if (!drawingMainClearlyDown) failureReasons.push("drawing-main-not-clearly-down");
  return {
    applicable: true,
    baselinePath,
    scenarioId,
    comparable,
    contextChecks,
    minimumReductionRatio: 0.5,
    scriptDurationMs: {
      beforeP95: beforeScriptP95,
      afterP95: afterScriptP95,
      reductionRatio: scriptReductionRatio,
      clearlyDown: scriptDurationClearlyDown,
    },
    drawingMainThreadMs: {
      beforeP95: beforeDrawingP95,
      afterP95: afterDrawingP95,
      reductionRatio: drawingReductionRatio,
      clearlyDown: drawingMainClearlyDown,
    },
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

function buildPhase3Comparison(report, compareBefore) {
  if (!compareBefore) {
    return { applicable: false, passed: false, failureReasons: ["legacy-baseline-not-provided"] };
  }
  const baselinePath = path.resolve(process.cwd(), compareBefore);
  let before = null;
  try {
    before = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return {
      applicable: true,
      baselinePath,
      passed: false,
      failureReasons: ["legacy-baseline-unreadable"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const beforeEligibility = assessFormalPhase3Report(before, "legacy");
  const afterEligibility = assessFormalPhase3Report(report, "shadow");
  const beforeEligible = beforeEligibility.passed;
  const afterEligible = afterEligibility.passed;
  const scenarioResults = report.scenarios.map((afterScenario) => {
    const beforeScenario = before.scenarios?.find?.((item) => item?.id === afterScenario.id);
    const beforeCount = Number(beforeScenario?.longTasks?.overThresholdCount);
    const afterCount = Number(afterScenario?.longTasks?.overThresholdCount);
    const beforeMeasuredRuns = Number(beforeScenario?.repetitions?.measuredRuns);
    const afterMeasuredRuns = Number(afterScenario?.repetitions?.measuredRuns);
    const beforeWarmupRuns = Number(beforeScenario?.repetitions?.warmupRuns);
    const afterWarmupRuns = Number(afterScenario?.repetitions?.warmupRuns);
    const comparable = Boolean(beforeScenario)
      && beforeScenario.fixture?.bars === afterScenario.fixture?.bars
      && beforeScenario.fixture?.entities === afterScenario.fixture?.entities
      && beforeScenario.fixture?.points === afterScenario.fixture?.points
      && beforeScenario.fixture?.dpr === afterScenario.fixture?.dpr
      && beforeMeasuredRuns === afterMeasuredRuns
      && beforeWarmupRuns === afterWarmupRuns;
    return {
      id: afterScenario.id,
      comparable,
      beforeLongTaskCount: Number.isFinite(beforeCount) ? beforeCount : null,
      afterLongTaskCount: Number.isFinite(afterCount) ? afterCount : null,
      beforeMeasuredRuns: Number.isFinite(beforeMeasuredRuns) ? beforeMeasuredRuns : null,
      afterMeasuredRuns: Number.isFinite(afterMeasuredRuns) ? afterMeasuredRuns : null,
      noNewLongTasks: comparable
        && Number.isFinite(beforeCount)
        && Number.isFinite(afterCount)
        && afterCount <= beforeCount,
    };
  });
  const contextChecks = {
    bars: before.configuration?.bars === report.configuration?.bars,
    browser: before.context?.browser?.version === report.context?.browser?.version,
    buildEnvironment: stableStringify(comparablePhase3BuildEnvironment(
      before.configuration?.buildEnvironment,
    )) === stableStringify(comparablePhase3BuildEnvironment(
      report.configuration?.buildEnvironment,
    )),
    buildInputFingerprint: SHA256_PATTERN.test(before.context?.git?.buildInputFingerprint || "")
      && SHA256_PATTERN.test(report.context?.git?.buildInputFingerprint || "")
      && before.context.git.buildInputFingerprint === report.context.git.buildInputFingerprint,
    commit: GIT_COMMIT_PATTERN.test(before.context?.git?.commit || "")
      && GIT_COMMIT_PATTERN.test(report.context?.git?.commit || "")
      && before.context.git.commit === report.context.git.commit,
    coordinateProjector: before.configuration?.drawingCoordinateProjectorMode
      === report.configuration?.drawingCoordinateProjectorMode,
    dpr: before.environment?.dpr === report.environment?.dpr,
    headless: before.configuration?.headless === report.configuration?.headless,
    hoverEvents: before.configuration?.hoverEvents === report.configuration?.hoverEvents,
    intervalSeconds: before.configuration?.intervalSeconds
      === report.configuration?.intervalSeconds,
    longTaskThreshold: before.configuration?.longTaskThresholdMs
      === report.configuration?.longTaskThresholdMs,
    machine: stableStringify(phase3MachineIdentity(before.context?.machine))
      === stableStringify(phase3MachineIdentity(report.context?.machine)),
    mock: stableStringify(before.environment?.mock) === stableStringify(report.environment?.mock),
    mockEndTime: before.configuration?.mockEndTime === report.configuration?.mockEndTime,
    pointerSamples: before.configuration?.pointerSamples === report.configuration?.pointerSamples,
    scenarios: stableStringify(before.configuration?.scenarios)
      === stableStringify(report.configuration?.scenarios),
    seed: before.configuration?.seed === report.configuration?.seed,
    serverMode: before.configuration?.serverMode === report.configuration?.serverMode,
    settleMs: before.configuration?.settleMs === report.configuration?.settleMs,
    viewportHeight: before.environment?.viewport?.height === report.environment?.viewport?.height,
    viewportWidth: before.environment?.viewport?.width === report.environment?.viewport?.width,
    wheelEvents: before.configuration?.wheelEvents === report.configuration?.wheelEvents,
  };
  const contextComparable = Object.values(contextChecks).every(Boolean);
  const modesPassed = before.context?.mode === "legacy" && report.context?.mode === "shadow";
  const passed = beforeEligible
    && afterEligible
    && contextComparable
    && modesPassed
    && scenarioResults.length > 0
    && scenarioResults.every((result) => result.noNewLongTasks);
  const failureReasons = [];
  if (!beforeEligible) failureReasons.push("legacy-baseline-ineligible");
  if (!afterEligible) failureReasons.push("shadow-report-ineligible");
  if (!contextComparable) failureReasons.push("baseline-context-mismatch");
  if (!modesPassed) failureReasons.push("legacy-shadow-mode-mismatch");
  if (scenarioResults.some((result) => !result.comparable)) failureReasons.push("scenario-mismatch");
  if (scenarioResults.some((result) => !result.noNewLongTasks)) failureReasons.push("new-long-task-detected");
  return {
    applicable: true,
    baselinePath,
    beforeEligible,
    afterEligible,
    beforeEligibility,
    afterEligibility,
    contextChecks,
    contextComparable,
    modesPassed,
    scenarioResults,
    passed,
    failureReasons,
  };
}

function buildPhase3Acceptance(report, args) {
  const presentScenarioIds = new Set(report.scenarios.map((scenario) => scenario.id));
  const missingRequiredScenarioIds = PHASE0_REQUIRED_SCENARIO_IDS
    .filter((scenarioId) => !presentScenarioIds.has(scenarioId));
  const measuredRunCoveragePassed = args.runs >= PHASE0_MIN_MEASURED_RUNS
    && report.scenarios.every((scenario) => scenario.repetitions.measuredRuns >= PHASE0_MIN_MEASURED_RUNS);
  const warmupCoveragePassed = args.warmupRuns >= PHASE0_MIN_WARMUP_RUNS
    && report.scenarios.every((scenario) => scenario.repetitions.warmupRuns >= PHASE0_MIN_WARMUP_RUNS);
  const measuredRuns = report.scenarios.flatMap((scenario) => (
    (scenario.rawRuns || []).filter((run) => !run.warmup).map((run) => ({
      entityCount: Number(scenario.fixture?.entities || 0),
      run,
      scenarioId: scenario.id,
    }))
  ));
  const parityCounterPassed = measuredRuns.length > 0 && measuredRuns.every(({ entityCount, run }) => (
    (entityCount === 0 || Number(run.counters?.shadowCompareCount) > 0)
    && Number(run.counters?.shadowParityMismatchCount) === 0
    && Number(run.counters?.shadowErrorCount) === 0
    && Number(run.counters?.shadowMismatchItems) === 0
  ));
  const nonEmptyMeasuredRuns = measuredRuns.filter(({ entityCount }) => entityCount > 0);
  const nonEmptyParityCoveragePassed = nonEmptyMeasuredRuns.length > 0
    && nonEmptyMeasuredRuns
      .every(({ run }) => Number(run.counters?.shadowComparedEntities) > 0);
  const hitParityCoveragePassed = nonEmptyMeasuredRuns.length > 0
    && nonEmptyMeasuredRuns
      .every(({ run }) => Number(run.counters?.shadowComparedHits) > 0);
  const parityPassed = parityCounterPassed
    && nonEmptyParityCoveragePassed
    && hitParityCoveragePassed;
  const longTaskInstrumentationPassed = measuredRuns.length > 0
    && measuredRuns.every(({ run }) => run?.bench?.longTaskSupported === true);
  const sceneBuildBudgetPassed = measuredRuns.every(({ entityCount, run }) => {
    if (entityCount === 0) return true;
    const buildMs = Number(run.counters?.shadowSceneBuildMs);
    return Number.isFinite(buildMs) && buildMs >= 0 && buildMs <= 50;
  });
  const productionBuildPassed = report.environment?.productionBuild === true
    && report.environment?.productionBuildVerification === "managed-vite-preview";
  const engineModePassed = report.configuration?.drawingEngineMode === "shadow"
    && report.context?.mode === "shadow";
  const comparisonPassed = report.phase3Comparison?.passed === true;
  const executionPassed = report.executionAcceptance?.passed === true;
  const phase3Eligible = !args.smoke && productionBuildPassed;
  const passed = phase3Eligible
    && engineModePassed
    && missingRequiredScenarioIds.length === 0
    && measuredRunCoveragePassed
    && warmupCoveragePassed
    && executionPassed
    && parityPassed
    && longTaskInstrumentationPassed
    && sceneBuildBudgetPassed
    && comparisonPassed;
  const failureReasons = [];
  if (args.smoke) failureReasons.push("smoke-only-run");
  if (!productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!engineModePassed) failureReasons.push("shadow-mode-not-selected");
  if (missingRequiredScenarioIds.length > 0) failureReasons.push("missing-required-scenarios");
  if (!measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!parityCounterPassed) failureReasons.push("shadow-parity-counter-failed");
  if (!nonEmptyParityCoveragePassed) failureReasons.push("shadow-visible-entity-coverage-failed");
  if (!hitParityCoveragePassed) failureReasons.push("shadow-hit-coverage-failed");
  if (!longTaskInstrumentationPassed) failureReasons.push("long-task-instrumentation-unavailable");
  if (!sceneBuildBudgetPassed) failureReasons.push("shadow-build-over-50ms");
  if (!comparisonPassed) failureReasons.push("legacy-shadow-long-task-comparison-failed");
  return {
    passed,
    phase3Eligible,
    productionBuildPassed,
    engineModePassed,
    requiredScenarioIds: [...PHASE0_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds,
    minimumMeasuredRuns: PHASE0_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE0_MIN_WARMUP_RUNS,
    warmupCoveragePassed,
    executionPassed,
    parityPassed,
    parityCounterPassed,
    nonEmptyParityCoveragePassed,
    hitParityCoveragePassed,
    longTaskInstrumentationPassed,
    sceneBuildBudgetPassed,
    comparisonPassed,
    failureReasons,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let git = readGitContext();
  if (args.phase === "phase9" && git.buildInputsDirty !== false) {
    throw new Error("Phase 9 requires committed, reproducible build inputs before starting: "
      + JSON.stringify(git.buildInputStatus));
  }
  const selectedScenarios = DEFAULT_SCENARIOS.filter((scenario) => args.scenarios.includes(scenario.id));
  const managed = !args.url;
  const buildEnvironment = managed
    ? managedBuildEnvironment(
      args.engineMode,
      args.interactionSurfaceMode,
      args.rasterBackend,
    )
    : null;
  const configuredProjectorMode = buildEnvironment?.VITE_DRAWING_COORDINATE_PROJECTOR
    ?? process.env.VITE_DRAWING_COORDINATE_PROJECTOR;
  const drawingCoordinateProjectorMode = configuredProjectorMode === "scalar"
    || configuredProjectorMode === "parity"
    || configuredProjectorMode === "batch"
    ? configuredProjectorMode
    : "batch";
  if (managed) ensureProductionBuild(
    args.engineMode,
    args.interactionSurfaceMode,
    args.rasterBackend,
  );
  if (args.phase === "phase9") {
    const postBuildGit = readGitContext();
    if (postBuildGit.buildInputsDirty !== false
      || postBuildGit.commit !== git.commit
      || postBuildGit.buildInputFingerprint !== git.buildInputFingerprint) {
      throw new Error("Phase 9 build inputs changed between provenance preflight and the production build: "
        + JSON.stringify({ before: git, after: postBuildGit }));
    }
    git = postBuildGit;
  }
  const servers = managed ? await startManagedServers(args) : null;
  if (servers) args.url = servers.url;
  if (!args.url.endsWith("/")) args.url += "/";

  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge executable not found. Pass --chrome <path>.");
  const debugPort = await freePort();
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-drawing-perf-"));
  const chromeArgs = [
    "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + profileDirectory,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--enable-precise-memory-info",
    // Codex/CI can keep a headed Chrome window occluded even after
    // Page.bringToFront. Preserve real headed rendering and DPR behavior while
    // preventing Chrome from reducing rAF/timer cadence for that window.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=" + DEFAULT_VIEWPORT.width + "," + DEFAULT_VIEWPORT.height,
  ];
  if (args.headless) chromeArgs.push("--headless=new", "--disable-gpu");
  chromeArgs.push("about:blank");
  const chrome = spawn(chromePath, chromeArgs, {
    stdio: "ignore",
    windowsHide: args.headless,
  });

  let cdp = null;
  let workerTracker = null;
  try {
    const targets = await waitForDebugTarget(debugPort, args.timeoutMs);
    const page = targets.find((target) => target.type === "page") || targets[0];
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    if (args.phase === "phase9") {
      workerTracker = await createDrawingWorkerHeapTracker(cdp);
    }
    const diagnostics = {
      consoleErrors: [],
      runtimeExceptions: [],
      networkFailures: [],
    };
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event?.type !== "error") return;
      diagnostics.consoleErrors.push({
        atMs: Date.now(),
        values: (event.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
      });
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      diagnostics.runtimeExceptions.push({
        atMs: Date.now(),
        text: event?.exceptionDetails?.text || null,
        exception: event?.exceptionDetails?.exception?.description || null,
      });
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (event?.canceled || event?.errorText === "net::ERR_ABORTED") return;
      diagnostics.networkFailures.push({
        atMs: Date.now(),
        type: event?.type || null,
        errorText: event?.errorText || null,
      });
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    if (args.phase === "phase9") await cdp.send("HeapProfiler.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: args.dpr,
      mobile: false,
      screenWidth: DEFAULT_VIEWPORT.width,
      screenHeight: DEFAULT_VIEWPORT.height,
    });
    await cdp.send("Page.bringToFront");
    const browserWindowId = args.headless
      ? null
      : (await cdp.send("Browser.getWindowForTarget", { targetId: page.id })).result?.windowId;
    await ensureHeadedBenchmarkWindow(cdp, browserWindowId, args.headless);
    const browserVersion = await cdp.send("Browser.getVersion");
    const allScenarioRuns = [];
    const totalRuns = args.warmupRuns + args.runs;
    const fixtureStartTime = args.mockEndTime - (args.bars - 1) * args.intervalSeconds;
    const mockBars = buildDrawingPerformanceMockBars({
      barCount: args.bars,
      intervalSeconds: args.intervalSeconds,
      endTime: args.mockEndTime,
    });
    const phase6PriceProfile = args.phase === "phase6" || args.phase === "phase9"
      ? Object.freeze({ start: mockBars[0].close, end: mockBars.at(-1).close })
      : null;
    const mockCloseByTime = new Map(mockBars.map((bar) => [bar.time, bar.close]));
    const lineageContract = selectedScenarios.some(
      (scenario) => scenario.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan,
    ) ? buildPhase6LineageFixtureContract(mockBars) : null;

    if (args.phase === "phase9") {
      const scenario = selectedScenarios[0];
      const fixture = buildDrawingFixture(scenario.fixture, {
        scopeKey: "binance:spot:BTCUSDT__main",
        startTime: fixtureStartTime,
        intervalSeconds: (args.intervalSeconds * Math.max(1, args.bars - 1))
          / fixtureTimeOffsetDenominator(scenario.fixture),
        seed: args.seed,
        priceProfile: phase6PriceProfile,
      });
      assertFixtureOverlapsMockPriceRange(fixture, servers?.mockMeta);
      const report = await runPhase9Soak({
        cdp,
        workerTracker,
        fixture,
        scenario,
        args,
        browserWindowId,
        diagnostics,
        git,
        browserVersion,
        servers,
        buildEnvironment,
      });
      const generatedStamp = report.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const defaultOut = path.resolve(
        FRONTEND_ROOT,
        "..",
        "docs",
        "perf-baselines",
        "drawing-engine-v2",
        "phase9-soak-" + git.shortCommit + "-" + generatedStamp + "-bars"
          + args.bars + "-dpr1_5.json",
      );
      const outputPath = args.out ? path.resolve(process.cwd(), args.out) : defaultOut;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, stableStringify(report, 2) + "\n", "utf8");
      console.log("Wrote Phase 9 drawing soak report to " + outputPath);
      console.log(JSON.stringify(report.acceptance, null, 2));
      const runPassed = report.acceptance.formalEligible
        ? report.acceptance.passed === true
        : report.acceptance.smokeAcceptance?.passed === true;
      if (!runPassed) process.exitCode = 1;
      return;
    }

    for (const scenario of selectedScenarios) {
      const scenarioPriceProfile = scenario.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan
        ? Object.freeze({
            start: mockCloseByTime.get(lineageContract.exact.left.time),
            end: mockCloseByTime.get(lineageContract.exact.right.time),
          })
        : phase6PriceProfile;
      const fixture = buildDrawingFixture(scenario.fixture, {
        scopeKey: "binance:spot:BTCUSDT__main",
        startTime: fixtureStartTime,
        intervalSeconds: (args.intervalSeconds * Math.max(1, args.bars - 1))
          / fixtureTimeOffsetDenominator(scenario.fixture),
        seed: args.seed,
        ...(scenarioPriceProfile ? { priceProfile: scenarioPriceProfile } : {}),
        ...(scenario.id === PHASE6_SCENARIO_IDS.freehandLineageZoomPan
          ? { lineageContract }
          : {}),
      });
      if (managed) assertFixtureOverlapsMockPriceRange(fixture, servers?.mockMeta);
      const runs = [];
      for (let iteration = 0; iteration < totalRuns; iteration += 1) {
        const warmup = iteration < args.warmupRuns;
        console.log("[" + scenario.id + "] run " + (iteration + 1) + "/" + totalRuns
          + (warmup ? " (warm-up)" : ""));
        const run = await runOneScenario(
          cdp,
          scenario,
          fixture,
          args,
          iteration + 1,
          warmup,
          diagnostics,
          browserWindowId,
        );
        runs.push(run);
        console.log("  " + run.durationMs + "ms; rAF samples="
          + run.samples.frameIntervalMs.length + "; longTasks=" + run.longTasks.length);
      }
      allScenarioRuns.push({ scenario, fixture, runs });
    }

    const report = buildDrawingPerformanceReport({
      generatedAt: new Date().toISOString(),
      context: {
        commit: git.commit,
        browser: {
          name: browserVersion.result?.product || "Chromium",
          version: browserVersion.result?.product || null,
          userAgent: browserVersion.result?.userAgent || null,
        },
        machine: machineContext(),
        mode: args.engineMode,
      },
      environment: {
        viewport: DEFAULT_VIEWPORT,
        dpr: args.dpr,
        refreshRateHz: estimateRefreshRateHz(allScenarioRuns),
        productionBuild: managed,
      },
      configuration: {
        requiredMeasuredRuns: args.runs,
        warmupRuns: args.warmupRuns,
        longTaskThresholdMs: 50,
        seed: args.seed,
      },
      scenarios: allScenarioRuns.map(({ scenario, fixture, runs }) => ({
        id: scenario.id,
        fixture: {
          name: fixture.metadata.name,
          bars: args.bars,
          entities: fixture.metadata.drawingCount,
          points: fixture.metadata.pointCount,
          spans: fixture.metadata.freehandSpanCount,
          maxFreehandPointsPerDrawing: fixture.metadata.maxFreehandPointsPerDrawing,
          maxFreehandSpansPerDrawing: fixture.metadata.maxFreehandSpansPerDrawing,
          sourceLineage: fixture.metadata.freehandSpanCount > 0,
          sourceProjection: fixture.metadata.sourceProjection ?? null,
          sourceProjectionConfig: fixture.metadata.sourceProjectionConfig ?? null,
          lineageExact: fixture.metadata.lineageExact ?? null,
          lineageFallback: fixture.metadata.lineageFallback ?? null,
          lineageDerivedRowCount: fixture.metadata.lineageDerivedRowCount ?? null,
          mode: args.engineMode,
          dpr: args.dpr,
        },
        runs,
        requiredMetrics: scenario.requiredMetrics,
        gates: [],
      })),
    });
    report.context.git = git;
    report.environment.mock = servers?.mockMeta || null;
    report.environment.productionBuildVerification = managed
      ? "managed-vite-preview"
      : "external-url-unverified";
    report.configuration.url = args.url;
    report.configuration.serverMode = managed ? "managed-preview" : "external-url";
    report.configuration.headless = args.headless;
    report.configuration.smokeOnly = args.smoke;
    report.configuration.scenarios = args.scenarios;
    report.configuration.bars = args.bars;
    report.configuration.intervalSeconds = args.intervalSeconds;
    report.configuration.mockEndTime = args.mockEndTime;
    report.configuration.settleMs = args.settleMs;
    report.configuration.wheelEvents = args.wheelEvents;
    report.configuration.hoverEvents = args.hoverEvents;
    report.configuration.pointerSamples = args.pointerSamples;
    report.configuration.drawingCoordinateProjectorMode = drawingCoordinateProjectorMode;
    report.configuration.drawingDocumentAuthority = buildEnvironment
      ?.VITE_DRAWING_DOCUMENT_AUTHORITY ?? null;
    report.configuration.drawingEngineMode = args.engineMode;
    report.configuration.drawingInteractionSurfaceMode = args.interactionSurfaceMode;
    report.configuration.drawingRasterBackend = args.rasterBackend;
    report.configuration.buildEnvironment = buildEnvironment;
    report.configuration.compareBefore = args.compareBefore || null;
    report.runMode = {
      name: args.smoke ? "smoke" : args.phase,
      smokeOnly: args.smoke,
      phase0Eligible: !args.smoke,
      phase1Eligible: !args.smoke,
      phase3Eligible: !args.smoke,
      phase4Eligible: !args.smoke,
      phase5Eligible: !args.smoke,
      phase6Eligible: !args.smoke,
    };
    applyRestoreValidity(report, args);
    report.drawingEngineDomEvidenceAcceptance = buildDrawingEngineDomEvidenceAcceptance(
      report,
      args,
    );
    report.executionAcceptance = {
      ...report.acceptance,
      failedScenarioIds: [...report.acceptance.failedScenarioIds],
      invalidScenarioIds: [...report.acceptance.invalidScenarioIds],
    };
    report.targetAssessment = Object.fromEntries(report.scenarios.map((scenario) => [
      scenario.id,
      evaluateGates(scenario, applicableHardGates(scenario)),
    ]));
    report.phase3LegacyBaselineAcceptance = buildPhase3LegacyBaselineAcceptance(report, args);
    report.phase1Comparison = buildPhase1Comparison(report, args.compareBefore);
    report.phase3Comparison = buildPhase3Comparison(report, args.compareBefore);
    report.phase0Acceptance = buildPhase0Acceptance(report, args);
    report.phase1Acceptance = buildPhase1Acceptance(report, args);
    report.phase3Acceptance = buildPhase3Acceptance(report, args);
    report.phase4Acceptance = buildPhase4Acceptance(report, args);
    report.phase5Acceptance = buildPhase5Acceptance(report, args);
    report.phase6Acceptance = buildPhase6Acceptance(report, args);
    report.smokeAcceptance = buildSmokeAcceptance(report, args);
    const phaseAcceptance = args.phase === "phase6"
      ? report.phase6Acceptance
      : args.phase === "phase5"
        ? report.phase5Acceptance
      : args.phase === "phase4"
        ? report.phase4Acceptance
        : args.phase === "phase3"
        ? report.phase3Acceptance
        : args.phase === "phase1"
          ? report.phase1Acceptance
          : report.phase0Acceptance;
    const selectedPhaseAcceptance = args.phase === "phase3"
      && args.engineMode === "legacy"
      && !args.smoke
      ? report.phase3LegacyBaselineAcceptance
      : phaseAcceptance;
    report.acceptance = {
      ...report.executionAcceptance,
      kind: selectedPhaseAcceptance === report.phase3LegacyBaselineAcceptance
        ? "phase3-legacy-baseline"
        : args.phase,
      passed: selectedPhaseAcceptance.passed,
      smokeOnly: args.smoke,
      phase0Eligible: !args.smoke,
      phase1Eligible: !args.smoke,
      phase3Eligible: !args.smoke,
      phase4Eligible: !args.smoke,
      phase5Eligible: !args.smoke,
      phase6Eligible: !args.smoke,
      executionPassed: report.executionAcceptance.passed,
    };

    const safeDpr = String(args.dpr).replace(".", "_");
    const generatedStamp = report.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const defaultOut = path.resolve(
      FRONTEND_ROOT,
      "..",
      "docs",
      "perf-baselines",
      "drawing-engine-v2",
      (args.smoke
        ? "smoke-"
        : args.phase === "phase6"
          ? "phase6-" + args.engineMode + "-"
        : args.phase === "phase5"
          ? "phase5-" + args.engineMode + "-"
          : args.phase === "phase4"
          ? "phase4-" + args.engineMode + "-"
          : args.phase === "phase3"
            ? "phase3-" + args.engineMode + "-"
            : args.phase === "phase1"
              ? "baseline-after-"
              : "baseline-before-")
        + git.shortCommit
        + "-" + generatedStamp + "-bars" + args.bars + "-dpr" + safeDpr + ".json",
    );
    const outputPath = args.out ? path.resolve(process.cwd(), args.out) : defaultOut;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, stableStringify(report, 2) + "\n", "utf8");
    console.log("Wrote drawing performance baseline to " + outputPath);
    console.log(JSON.stringify({
      phase0Acceptance: report.phase0Acceptance,
      phase1Acceptance: report.phase1Acceptance,
      phase1Comparison: report.phase1Comparison,
      phase3LegacyBaselineAcceptance: report.phase3LegacyBaselineAcceptance,
      phase3Acceptance: report.phase3Acceptance,
      phase3Comparison: report.phase3Comparison,
      phase4Acceptance: report.phase4Acceptance,
      phase5Acceptance: report.phase5Acceptance,
      phase6Acceptance: report.phase6Acceptance,
      smokeAcceptance: report.smokeAcceptance,
      drawingEngineDomEvidenceAcceptance: report.drawingEngineDomEvidenceAcceptance,
      invalidScenarios: report.acceptance.invalidScenarioIds,
      targetAssessment: Object.fromEntries(Object.entries(report.targetAssessment)
        .map(([id, value]) => [id, { passed: value.passed, failedCount: value.failedCount }])),
    }, null, 2));

    const targetPassed = Object.values(report.targetAssessment).every((assessment) => assessment.passed);
    const selectedModePassed = args.smoke
      ? report.smokeAcceptance.passed
      : selectedPhaseAcceptance.passed;
    if (!selectedModePassed || (args.enforceTargets && !targetPassed)) {
      process.exitCode = 1;
    }
  } finally {
    workerTracker?.dispose?.();
    cdp?.close?.();
    await stopProcess(chrome);
    await removeDirectoryWithRetries(profileDirectory);
    await servers?.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
