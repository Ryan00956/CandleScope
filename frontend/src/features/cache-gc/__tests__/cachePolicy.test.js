import assert from "node:assert/strict";
import test from "node:test";

import { planFrontendGc } from "../cachePolicy.js";

function diagnostics(overrides = {}) {
  return {
    estimatedBytes: 1_200,
    indicatorPoints: 0,
    klineBars: 6,
    owners: {
      chart: {
        entries: [
          { key: "binance-spot-BTCUSDT-1m", tier: "active", bars: 3, estimatedBytes: 600 },
          { key: "binance-spot-ETHUSDT-1m", tier: "warm", bars: 2, estimatedBytes: 400 },
        ],
      },
      watchlist: {
        entries: [
          { key: "binance:spot:SOLUSDT::1m", status: "stale", bars: 1, estimatedBytes: 200 },
        ],
      },
      indicators: {
        entries: [],
      },
      ...overrides.owners,
    },
    ...overrides,
  };
}

test("frontend GC dry-run preserves active entries", () => {
  const report = planFrontendGc(diagnostics(), {
    maxEstimatedBytes: 100,
    maxKlineBars: 1,
    nowMs: 1_000,
  });

  assert.equal(
    report.victims.some((entry) => entry.key === "binance-spot-BTCUSDT-1m"),
    false,
  );
  assert.equal(report.protectedCount, 1);
});

test("frontend GC dry-run chooses cold entries before warm entries", () => {
  const report = planFrontendGc(diagnostics(), {
    maxEstimatedBytes: 100,
    maxKlineBars: 1,
    nowMs: 1_000,
  });

  assert.equal(report.victims[0].key, "binance:spot:SOLUSDT::1m");
  assert.equal(report.victims[0].tier, "cold");
});

test("frontend GC dry-run returns no victims while within budget", () => {
  const report = planFrontendGc(diagnostics(), {
    maxEstimatedBytes: 10_000,
    maxIndicatorPoints: 10_000,
    maxKlineBars: 10_000,
    nowMs: 1_000,
  });

  assert.equal(report.victims.length, 0);
  assert.equal(report.wouldFreeEstimatedBytes, 0);
});

test("frontend GC dry-run accepts frontend cache budget field", () => {
  const report = planFrontendGc(diagnostics(), {
    frontendCacheBudgetBytes: 500,
    maxKlineBars: 10_000,
    maxIndicatorPoints: 10_000,
    nowMs: 1_000,
  });

  assert.equal(report.policy.maxEstimatedBytes, 500);
  assert.equal(report.pressure.estimatedBytes, 700);
  assert.equal(report.victims.length > 0, true);
});

test("frontend GC dry-run selects orphan indicator cache without budget pressure", () => {
  const report = planFrontendGc(diagnostics({
    estimatedBytes: 2_000,
    indicatorPoints: 10,
    owners: {
      indicators: {
        entries: [
          {
            key: "ma",
            tier: "warm",
            points: 10,
            items: 0,
            estimatedBytes: 800,
            dependencyState: { orphan: true, missingDependencies: ["binance:spot:BTCUSDT:1m"] },
          },
        ],
      },
    },
  }), {
    maxEstimatedBytes: 10_000,
    maxIndicatorPoints: 10_000,
    maxKlineBars: 10_000,
    nowMs: 1_000,
  });

  assert.equal(report.victims.length, 1);
  assert.equal(report.victims[0].reason, "missing-kline-dependency");
});

test("frontend GC dry-run can pressure indicator point budget", () => {
  const report = planFrontendGc(diagnostics({
    estimatedBytes: 2_000,
    indicatorPoints: 900,
    owners: {
      indicators: {
        entries: [
          { key: "ma", tier: "warm", points: 600, items: 0, estimatedBytes: 1_000 },
          { key: "rsi", tier: "warm", points: 300, items: 0, estimatedBytes: 500 },
        ],
      },
    },
  }), {
    maxEstimatedBytes: 10_000,
    maxIndicatorPoints: 500,
    maxKlineBars: 10_000,
    nowMs: 1_000,
  });

  assert.equal(report.victims[0].owner, "indicator-result-cache");
  assert.equal(report.victims[0].reason, "indicator-points-over-budget");
  assert.equal(report.wouldFreeIndicatorPoints >= 400, true);
});

test("frontend GC dry-run keeps hotter reusable entries longer", () => {
  const report = planFrontendGc(diagnostics({
    estimatedBytes: 2_000,
    owners: {
      watchlist: {
        entries: [
          { key: "hot", status: "stale", bars: 3, estimatedBytes: 600, heatScore: 20 },
          { key: "cold", status: "stale", bars: 3, estimatedBytes: 600, heatScore: 0 },
        ],
      },
    },
  }), {
    maxEstimatedBytes: 100,
    maxKlineBars: 1,
    nowMs: 1_000,
  });

  assert.equal(report.scoringVersion, 1);
  assert.equal(report.victims[0].key, "cold");
  assert.equal(report.victims[0].reuseReason, "no-recent-heat");
  assert.ok(report.victims[0].scores.finalEvictScore >= report.victims[1].scores.finalEvictScore);
});
