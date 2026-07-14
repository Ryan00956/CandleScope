import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_PERFORMANCE_SCHEMA_VERSION,
  attributeLongTasks,
  buildDrawingPerformanceReport,
  discardWarmup,
  evaluateGates,
  percentile,
  stableStringify,
  summarizeSamples,
  summarizeScenarioRuns,
} from "./drawing-performance-metrics.mjs";

function measuredRun(value, extra = {}) {
  return {
    samples: {
      drawingMainThreadMs: [value, value + 1],
      frameIntervalMs: [value + 10, value + 11],
    },
    counters: {
      workerQueueDepth: 2,
    },
    ...extra,
  };
}

test("percentile uses nearest rank without mutating or accepting invalid samples", () => {
  const values = [5, 1, Number.NaN, 3, 2, 4];

  assert.equal(percentile(values, 50), 3);
  assert.equal(percentile(values, 95), 5);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile(values, 101), null);
  assert.deepEqual(values, [5, 1, Number.NaN, 3, 2, 4]);
});

test("sample summary has a stable empty shape and fails closed", () => {
  assert.deepEqual(summarizeSamples([null, Number.NaN]), {
    valid: false,
    samples: 0,
    invalidSamples: 2,
    min: null,
    p50: null,
    p90: null,
    p95: null,
    p99: null,
    max: null,
    mean: null,
    stddev: null,
  });

  const gates = evaluateGates(
    { metrics: { frameIntervalMs: summarizeSamples([]) } },
    [{ id: "frame-p95", path: "metrics.frameIntervalMs.p95", max: 20 }],
  );
  assert.equal(gates.passed, false);
  assert.equal(gates.results[0].reason, "missing-or-non-finite-actual");
});

test("warm-up discard supports run count and elapsed time", () => {
  const samples = [
    { atMs: 100, value: 1 },
    { atMs: 110, value: 2 },
    { atMs: 120, value: 3 },
    { atMs: 130, value: 4 },
  ];

  assert.deepEqual(discardWarmup(samples, 1), samples.slice(1));
  assert.deepEqual(
    discardWarmup(samples, { warmupSamples: 1, warmupMs: 20 }),
    samples.slice(2),
  );
});

test("Long Tasks are strictly over 50ms and attributed by drawing overlap or metadata", () => {
  const summary = attributeLongTasks([
    { startTime: 0, duration: 50 },
    { startTime: 10, duration: 60 },
    { startTime: 100, duration: 70 },
    { startTime: 200, duration: 80, attribution: [{ name: "drawing.finalize" }] },
  ], [
    { startTime: 20, endTime: 30 },
  ]);

  assert.equal(summary.observedCount, 4);
  assert.equal(summary.overThresholdCount, 3);
  assert.equal(summary.attributableCount, 2);
  assert.equal(summary.unattributedCount, 1);
  assert.equal(summary.entries[0].reason, "overlap");
  assert.equal(summary.entries[0].overlapMs, 10);
  assert.equal(summary.entries[2].reason, "attribution");
});

test("gate evaluation supports bounds and equality with explicit failure reasons", () => {
  const result = evaluateGates({ p95: 4, queue: 3, count: 0 }, [
    { id: "cpu", path: "p95", operator: "<=", expected: 4 },
    { id: "queue", path: "queue", max: 2 },
    { id: "long-task", path: "count", equals: 0 },
    { id: "missing", path: "unknown", max: 1 },
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.passedCount, 2);
  assert.equal(result.failedCount, 2);
  assert.deepEqual(result.results.map((gate) => gate.reason), [
    "passed",
    "comparison-failed",
    "passed",
    "missing-or-non-finite-actual",
  ]);
});

test("five measured repetitions preserve raw samples and report p95 variability", () => {
  const runs = [
    measuredRun(100, { warmup: true }),
    measuredRun(1),
    measuredRun(2),
    measuredRun(3),
    measuredRun(4),
    measuredRun(5),
  ];
  const summary = summarizeScenarioRuns(runs, {
    id: "active-stroke",
    requiredMeasuredRuns: 5,
    requiredMetrics: ["drawingMainThreadMs", "frameIntervalMs"],
    gates: [
      { id: "cpu", path: "metrics.drawingMainThreadMs.p95", max: 8 },
      { id: "queue", path: "counters.workerQueueDepth.max", max: 2 },
    ],
  });

  assert.equal(summary.repetitions.warmupRuns, 1);
  assert.equal(summary.repetitions.measuredRuns, 5);
  assert.equal(summary.repetitions.rawSamplesComplete, true);
  assert.equal(summary.metrics.drawingMainThreadMs.samples, 10);
  assert.equal(summary.metrics.drawingMainThreadMs.p95, 6);
  assert.deepEqual(summary.variability.drawingMainThreadMs.runP95, [2, 3, 4, 5, 6]);
  assert.equal(summary.variability.drawingMainThreadMs.relativeRangePct, 100);
  assert.equal(summary.rawRuns, runs);
  assert.equal(summary.passed, true);
});

test("an absent repeated sample or fewer than five measured runs is invalid", () => {
  const runs = [
    measuredRun(100, { warmup: true }),
    measuredRun(1),
    measuredRun(2),
    measuredRun(3),
    { samples: { drawingMainThreadMs: [] } },
  ];
  const summary = summarizeScenarioRuns(runs, {
    requiredMeasuredRuns: 5,
    requiredMetrics: ["drawingMainThreadMs"],
  });

  assert.equal(summary.repetitions.repetitionsComplete, false);
  assert.equal(summary.repetitions.rawSamplesComplete, false);
  assert.equal(summary.repetitions.valid, false);
  assert.equal(summary.passed, false);
});

test("truncated benchmark capture and dirty diagnostics fail closed", () => {
  const runs = [
    measuredRun(100, { warmup: true }),
    ...Array.from({ length: 5 }, (_, index) => ({
      ...measuredRun(index + 1),
      sampleCompleteness: {
        drawingMainThreadMs: {
          complete: index !== 0,
          observed: index === 0 ? 400 : 2,
          retained: index === 0 ? 240 : 2,
          dropped: index === 0 ? 160 : 0,
        },
      },
      diagnostics: index === 1 ? {
        consoleErrors: [{ message: "boom" }],
        runtimeExceptions: [],
        networkFailures: [],
      } : undefined,
    })),
  ];
  const summary = summarizeScenarioRuns(runs, {
    requiredMetrics: ["drawingMainThreadMs"],
  });

  assert.equal(summary.repetitions.rawSamplesComplete, false);
  assert.equal(summary.repetitions.diagnosticsClean, false);
  assert.equal(summary.repetitions.valid, false);
});

test("warm-up diagnostics fail closed even though warm-up samples are discarded", () => {
  const warmup = measuredRun(100, {
    warmup: true,
    diagnostics: {
      consoleErrors: ["warm-up bootstrap failed"],
      runtimeExceptions: [],
      networkFailures: [],
    },
  });
  const measured = Array.from({ length: 5 }, (_, index) => measuredRun(index + 1));

  const summary = summarizeScenarioRuns([warmup, ...measured], {
    requiredMetrics: ["drawingMainThreadMs"],
    requiredMeasuredRuns: 5,
    warmupRuns: 1,
  });

  assert.equal(summary.repetitions.warmupComplete, true);
  assert.equal(summary.repetitions.diagnosticsClean, false);
  assert.equal(summary.repetitions.valid, false);
});

test("a missing required warm-up run is invalid", () => {
  const summary = summarizeScenarioRuns(
    Array.from({ length: 5 }, (_, index) => measuredRun(index + 1, { warmup: false })),
    { requiredMetrics: ["drawingMainThreadMs"], warmupRuns: 1 },
  );

  assert.equal(summary.repetitions.warmupComplete, false);
  assert.equal(summary.repetitions.valid, false);
});

test("report builder emits a versioned stable structure and fails closed with no scenarios", () => {
  const empty = buildDrawingPerformanceReport({ generatedAt: "2026-07-14T00:00:00.000Z" });
  assert.equal(empty.schemaVersion, DRAWING_PERFORMANCE_SCHEMA_VERSION);
  assert.equal(empty.acceptance.passed, false);
  assert.equal(empty.acceptance.scenarioCount, 0);

  const report = buildDrawingPerformanceReport({
    generatedAt: "2026-07-14T00:00:00.000Z",
    context: {
      commit: "abc123",
      browser: { name: "Chromium", version: "140" },
      machine: { platform: "win32", logicalCores: 8 },
      mode: "legacy",
    },
    environment: {
      viewport: { width: 1440, height: 900 },
      dpr: 1,
      refreshRateHz: 60,
      productionBuild: true,
    },
    configuration: { warmupRuns: 1, requiredMeasuredRuns: 5, seed: 7 },
    scenarios: [{
      id: "zero-drawing",
      fixture: { bars: 1500, entities: 0, points: 0, mode: "legacy", dpr: 1 },
      runs: [measuredRun(100, { warmup: true }), ...Array.from(
        { length: 5 },
        (_, index) => measuredRun(index + 1),
      )],
      requiredMetrics: ["frameIntervalMs"],
      gates: [{ id: "frame", path: "metrics.frameIntervalMs.p95", max: 20 }],
    }],
  });

  assert.equal(report.acceptance.passed, true);
  assert.equal(report.scenarios[0].fixture.entities, 0);
  assert.match(stableStringify(report), /"schemaVersion": "drawing-engine-v2-perf\/v1"/);
});

test("stableStringify sorts object keys while preserving array order", () => {
  assert.equal(
    stableStringify({ z: 1, a: { y: 2, b: 3 }, list: [{ z: 4, a: 5 }] }, 0),
    '{"a":{"b":3,"y":2},"list":[{"a":5,"z":4}],"z":1}',
  );

  const circular = [];
  circular.push(circular);
  assert.throws(() => stableStringify(circular), /circular performance report/);
});
