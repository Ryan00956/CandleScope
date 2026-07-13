import assert from "node:assert/strict";
import test from "node:test";

import {
  appendFrontendAutoGcAudit,
  buildAutoFrontendGcPlan,
} from "../autoGcPolicy.js";

function diagnostics(entry) {
  return {
    estimatedBytes: 2_000,
    indicatorPoints: entry.points || 0,
    klineBars: entry.bars || 0,
    owners: {
      chart: { entries: [] },
      watchlist: { entries: [] },
      indicators: { entries: [entry] },
    },
  };
}

test("auto frontend GC keeps orphan indicators without pressure", () => {
  const plan = buildAutoFrontendGcPlan(diagnostics({
    key: "orphan-ma",
    tier: "warm",
    points: 10,
    items: 0,
    estimatedBytes: 800,
    dependencyState: { orphan: true },
  }), {
    nowMs: 1_000,
    minFinalEvictScore: 100,
  });

  assert.equal(plan.mode, "auto-plan");
  assert.equal(plan.victims.length, 1);
  assert.equal(plan.victims[0].reason, "missing-kline-dependency");
});

test("auto frontend GC skips low-score non-orphan victims", () => {
  const plan = buildAutoFrontendGcPlan({
    estimatedBytes: 2_000,
    indicatorPoints: 0,
    klineBars: 10,
    owners: {
      chart: {
        entries: [
          { key: "cold-kline", tier: "cold", bars: 10, estimatedBytes: 1_000 },
        ],
      },
      watchlist: { entries: [] },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 100,
    maxKlineBars: 1,
    nowMs: 1_000,
    minFinalEvictScore: 100,
  });

  assert.equal(plan.victims.length, 0);
  assert.equal(plan.autoSkipped[0].reason, "score-below-threshold");
});

test("auto frontend GC audit replaces damaged storage with validated entries", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let written = null;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => "{damaged",
      setItem: (_key, value) => {
        written = value;
      },
    },
  });

  try {
    appendFrontendAutoGcAudit({
      plan: { victims: [], autoSkipped: [] },
      result: { removedCount: 0, removedEstimatedBytes: 0 },
    });
    const stored = JSON.parse(written);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].mode, "auto-gc");
    assert.equal(stored[0].victimCount, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
