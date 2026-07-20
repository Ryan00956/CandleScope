import assert from "node:assert/strict";
import test from "node:test";

import { planFrontendGc } from "../cachePolicy.js";
import type { CacheDiagnostics } from "../cacheGcTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

function diagnostics(overrides: CacheDiagnostics = {}): CacheDiagnostics {
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

  const firstVictim = mustBeDefined(report.victims[0]);
  assert.equal(firstVictim.key, "binance:spot:SOLUSDT::1m");
  assert.equal(firstVictim.tier, "cold");
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
  assert.equal(mustBeDefined(report.victims[0]).reason, "missing-kline-dependency");
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

  const firstVictim = mustBeDefined(report.victims[0]);
  assert.equal(firstVictim.owner, "indicator-result-cache");
  assert.equal(firstVictim.reason, "indicator-points-over-budget");
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

  assert.equal(report.scoringVersion, 2);
  const firstVictim = mustBeDefined(report.victims[0]);
  const secondVictim = mustBeDefined(report.victims[1]);
  assert.equal(firstVictim.key, "cold");
  assert.equal(firstVictim.reuseReason, "no-recent-heat");
  assert.ok(firstVictim.scores.finalEvictScore >= secondVictim.scores.finalEvictScore);
});

test("frontend GC only selects actions that relieve the remaining pressure", () => {
  const report = planFrontendGc({
    estimatedBytes: 2_000,
    indicatorPoints: 100,
    klineBars: 10,
    owners: {
      chart: {
        entries: [{ key: "kline", tier: "warm", bars: 10, estimatedBytes: 1_000 }],
      },
      watchlist: { entries: [] },
      indicators: {
        entries: [{ key: "indicator", tier: "cold", points: 100, estimatedBytes: 1_000 }],
      },
    },
  }, {
    maxEstimatedBytes: 10_000,
    maxIndicatorPoints: 1_000,
    maxKlineBars: 0,
    nowMs: 1_000,
  });

  assert.deepEqual(report.victims.map((entry) => entry.key), ["kline"]);
  assert.equal(report.remainingPressure?.klineBars, 0);
});

test("frontend GC only range-trims a subscribed watchlist tail", () => {
  const report = planFrontendGc({
    estimatedBytes: 160_000,
    indicatorPoints: 0,
    klineBars: 800,
    owners: {
      chart: { entries: [] },
      watchlist: {
        entries: [{
          key: "binance:spot:BTCUSDT::1m",
          tier: "subscribed",
          status: "live",
          bars: 800,
          estimatedBytes: 160_000,
          trimSafety: { safeRangeTrim: true },
          trimPlan: {
            keepStart: 301,
            keepBars: 500,
            removedBars: 300,
            removedEstimatedBytes: 60_000,
          },
        }],
      },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 1_000_000,
    maxIndicatorPoints: 1_000,
    maxKlineBars: 500,
    nowMs: 1_000,
  });

  const victim = mustBeDefined(report.victims[0]);
  assert.equal(report.protectedCount, 0);
  assert.equal(victim.action, "trim-range");
  assert.equal(victim.tier, "subscribed");
  assert.equal(victim.bars, 300);
  assert.equal(victim.estimatedBytes, 60_000);
  assert.equal(report.wouldFreeBars, 300);
});

test("frontend GC uses exact indicator range-trim relief", () => {
  const report = planFrontendGc({
    estimatedBytes: 10_400,
    indicatorPoints: 100,
    klineBars: 0,
    owners: {
      chart: { entries: [] },
      watchlist: { entries: [] },
      indicators: {
        entries: [{
          key: "trim-safe",
          tier: "warm",
          points: 100,
          items: 20,
          estimatedBytes: 10_400,
          trimSafety: { safeRangeTrim: true },
          trimPlan: {
            keepStart: 50,
            removedPoints: 60,
            removedItems: 2,
            removedEstimatedBytes: 5_040,
          },
        }],
      },
    },
  }, {
    maxEstimatedBytes: 100_000,
    maxIndicatorPoints: 50,
    maxKlineBars: 1_000,
    nowMs: 1_000,
  });

  const victim = mustBeDefined(report.victims[0]);
  assert.equal(victim.action, "trim-range");
  assert.equal(victim.points, 60);
  assert.equal(victim.items, 2);
  assert.equal(victim.estimatedBytes, 5_040);
  assert.equal(report.wouldFreeIndicatorPoints, 60);
  assert.equal(report.wouldFreeIndicatorItems, 2);
  assert.equal(report.wouldFreeEstimatedBytes, 5_040);
});

test("frontend GC uses the newest cache timestamp", () => {
  const report = planFrontendGc({
    estimatedBytes: 1_000,
    indicatorPoints: 0,
    klineBars: 1,
    owners: {
      chart: {
        entries: [{
          key: "recent-update",
          bars: 1,
          estimatedBytes: 1_000,
          lastAccessMs: 1,
          lastUpdatedMs: 999_900,
          lastRealtimeMs: 999_800,
        }],
      },
      watchlist: { entries: [] },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 100,
    maxIndicatorPoints: 1_000,
    maxKlineBars: 1_000,
    nowMs: 1_000_000,
  });

  assert.equal(mustBeDefined(report.victims[0]).tier, "warm");
});

test("browser heap pressure triggers only with a real heap limit", () => {
  const pressured = planFrontendGc({
    estimatedBytes: 1_000,
    indicatorPoints: 10,
    klineBars: 0,
    runtimePressure: {
      browserHeap: {
        available: true,
        source: "performance.memory",
        usedJSHeapSize: 95,
        totalJSHeapSize: 98,
        jsHeapSizeLimit: 100,
        usageRatio: 0.95,
      },
    },
    owners: {
      chart: { entries: [] },
      watchlist: { entries: [] },
      indicators: { entries: [{ key: "heap-victim", points: 10, estimatedBytes: 1_000 }] },
    },
  }, {
    maxEstimatedBytes: 10_000,
    maxIndicatorPoints: 1_000,
    maxKlineBars: 1_000,
    nowMs: 1_000,
  });
  const noLimit = planFrontendGc({
    estimatedBytes: 1_000,
    indicatorPoints: 10,
    klineBars: 0,
    runtimePressure: {
      browserHeap: {
        available: true,
        source: "measureUserAgentSpecificMemory",
        usedJSHeapSize: 95,
        totalJSHeapSize: 100,
      },
    },
    owners: {
      chart: { entries: [] },
      watchlist: { entries: [] },
      indicators: { entries: [{ key: "heap-victim", points: 10, estimatedBytes: 1_000 }] },
    },
  }, {
    maxEstimatedBytes: 10_000,
    maxIndicatorPoints: 1_000,
    maxKlineBars: 1_000,
    nowMs: 1_000,
  });

  assert.equal(pressured.pressure.level, "hard");
  assert.equal(pressured.pressure.heapEstimatedBytes, 15);
  assert.equal(mustBeDefined(pressured.victims[0]).reason, "browser-heap-high-watermark");
  assert.equal(noLimit.victims.length, 0);
});
