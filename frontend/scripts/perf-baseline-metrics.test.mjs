import assert from "node:assert/strict";
import test from "node:test";

import { buildHeapAcceptance, summarizeHeapSamples } from "./perf-baseline-metrics.mjs";

function heapSamples({ minutes, start = 1_000_000, valueAt }) {
  return Array.from({ length: minutes + 1 }, (_, minute) => ({
    atMs: start + minute * 60_000,
    usedJSHeapSize: valueAt(minute),
  }));
}

test("heap summary excludes warmup and compares stable window medians", () => {
  const samples = heapSamples({
    minutes: 66,
    valueAt: (minute) => (minute < 5 ? 1_000_000 + minute * 5_000_000 : 30_000_000),
  });
  const summary = summarizeHeapSamples(samples, 66 * 60_000);

  assert.equal(summary.warmupMs, 5 * 60_000);
  assert.equal(summary.observedDurationMs, 61 * 60_000);
  assert.equal(summary.baselineUsedJSHeapSize, 30_000_000);
  assert.equal(summary.lastUsedJSHeapSize, 30_000_000);
  assert.equal(summary.deltaPct, 0);
});

test("heap acceptance uses effective observation duration instead of process duration", () => {
  const summary = summarizeHeapSamples(heapSamples({
    minutes: 60,
    valueAt: () => 30_000_000,
  }), 60 * 60_000);
  const acceptance = buildHeapAcceptance(summary, { requiredDurationMs: 60 * 60_000 });

  assert.equal(summary.observedDurationMs, 55 * 60_000);
  assert.equal(acceptance.evaluated, false);
  assert.equal(acceptance.passed, null);
});

test("heap window medians resist a final GC outlier", () => {
  const samples = heapSamples({
    minutes: 66,
    valueAt: (minute) => {
      if (minute < 5) return 5_000_000;
      if (minute === 66) return 20_000_000;
      return 30_000_000 + (minute - 5) * 100_000;
    },
  });
  const summary = summarizeHeapSamples(samples, 66 * 60_000);
  const acceptance = buildHeapAcceptance(summary, {
    requiredDurationMs: 60 * 60_000,
    maxDeltaPct: 10,
  });

  assert.equal(acceptance.evaluated, true);
  assert.ok(summary.deltaPct > 10);
  assert.equal(acceptance.passed, false);
});
