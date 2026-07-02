import assert from "node:assert/strict";
import test from "node:test";

import { buildAutoFrontendGcPlan } from "../autoGcPolicy.js";

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
