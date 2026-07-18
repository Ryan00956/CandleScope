import assert from "node:assert/strict";
import test from "node:test";

import {
  appendFrontendAutoGcAudit,
  buildAutoFrontendGcPlan,
} from "../autoGcPolicy.js";
import type {
  AutoGcPlan,
  CacheDiagnostics,
  CacheDiagnosticsEntry,
  FrontendGcExecutionResult,
} from "../cacheGcTypes.js";
import { mustBeDefined, partialMock } from "../../../test/testHelpers.js";

function diagnostics(entry: CacheDiagnosticsEntry): CacheDiagnostics {
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
  assert.equal(mustBeDefined(plan.victims[0]).reason, "missing-kline-dependency");
});

test("auto frontend GC uses score only for ordering at a hard watermark", () => {
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

  assert.equal(plan.pressure.level, "hard");
  assert.equal(plan.victims.length, 1);
  assert.equal(plan.autoSkipped.length, 0);
});

test("auto frontend GC keeps the score gate for high but non-hard heap pressure", () => {
  const plan = buildAutoFrontendGcPlan({
    estimatedBytes: 2_000,
    indicatorPoints: 0,
    klineBars: 10,
    runtimePressure: {
      browserHeap: {
        available: true,
        source: "performance.memory",
        usedJSHeapSize: 85,
        jsHeapSizeLimit: 100,
        usageRatio: 0.85,
      },
    },
    owners: {
      chart: {
        entries: [{ key: "cold-kline", tier: "cold", bars: 10, estimatedBytes: 1_000 }],
      },
      watchlist: { entries: [] },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 10_000,
    maxKlineBars: 100,
    nowMs: 1_000,
    minFinalEvictScore: 100,
  });

  assert.equal(plan.pressure.level, "high");
  assert.equal(plan.victims.length, 0);
  assert.equal(mustBeDefined(plan.autoSkipped[0]).reason, "score-below-threshold");
});

test("auto frontend GC continues after filtering a recent candidate", () => {
  const plan = buildAutoFrontendGcPlan({
    estimatedBytes: 2_000,
    indicatorPoints: 0,
    klineBars: 20,
    owners: {
      chart: {
        entries: [
          {
            key: "a-recent",
            tier: "cold",
            bars: 10,
            estimatedBytes: 1_000,
            lastAccessMs: 1,
            lastRealtimeMs: 999_999,
          },
          {
            key: "b-old",
            tier: "cold",
            bars: 10,
            estimatedBytes: 1_000,
            lastAccessMs: 1,
          },
        ],
      },
      watchlist: { entries: [] },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 1_000,
    maxKlineBars: 100,
    nowMs: 1_000_000,
    neverEvictAccessedWithinMs: 2_000,
    minFinalEvictScore: 1_000,
  });

  assert.deepEqual(plan.victims.map((victim) => victim.key), ["b-old"]);
  assert.equal(
    plan.autoSkipped.some((entry) => entry.key === "a-recent" && entry.reason === "recently-accessed"),
    true,
  );
});

test("auto frontend GC enforces max bytes for the first victim and fills with a smaller one", () => {
  const plan = buildAutoFrontendGcPlan({
    estimatedBytes: 1_400,
    indicatorPoints: 0,
    klineBars: 14,
    owners: {
      chart: {
        entries: [
          { key: "large", tier: "cold", bars: 10, estimatedBytes: 1_000 },
          { key: "small", tier: "cold", bars: 4, estimatedBytes: 400 },
        ],
      },
      watchlist: { entries: [] },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 100,
    maxKlineBars: 100,
    maxBytesPerRun: 500,
    nowMs: 1_000,
    minFinalEvictScore: 1_000,
  });

  assert.deepEqual(plan.victims.map((victim) => victim.key), ["small"]);
  assert.equal(plan.wouldFreeEstimatedBytes, 400);
  assert.equal(
    plan.autoSkipped.some((entry) => entry.key === "large" && entry.reason === "per-run-limit"),
    true,
  );
});

test("auto frontend GC allows only exact safe trim for a subscribed watchlist entry", () => {
  const plan = buildAutoFrontendGcPlan({
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
          lastRealtimeMs: 999_999,
          trimSafety: { safeRangeTrim: true },
          trimPlan: {
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
    maxKlineBars: 500,
    maxBytesPerRun: 100_000,
    nowMs: 1_000_000,
  });

  const victim = mustBeDefined(plan.victims[0]);
  assert.equal(victim.action, "trim-range");
  assert.equal(victim.tier, "subscribed");
  assert.equal(victim.bars, 300);
  assert.equal(plan.autoSkipped.length, 0);
});

test("auto frontend GC rejects retired or unknown policy fields without echoing GC fields", () => {
  assert.throws(
    () => buildAutoFrontendGcPlan({}, { neverEvictActiveWithinMs: 10_000 }),
    /Unsupported frontend auto GC policy field: neverEvictActiveWithinMs/,
  );
  assert.throws(
    () => buildAutoFrontendGcPlan({}, { unexpectedPolicyField: true }),
    /Unsupported frontend auto GC policy field: unexpectedPolicyField/,
  );

  const plan = buildAutoFrontendGcPlan({}, {
    enabled: false,
    maxEstimatedBytes: 123_456,
    maxEntriesPerRun: 7,
  });
  assert.equal(plan.autoPolicy.enabled, false);
  assert.equal(plan.autoPolicy.maxEntriesPerRun, 7);
  assert.equal(Object.hasOwn(plan.autoPolicy, "maxEstimatedBytes"), false);
  assert.equal(Object.hasOwn(plan.autoPolicy, "neverEvictActiveWithinMs"), false);
  assert.equal(plan.policy.maxEstimatedBytes, 123_456);
});

test("auto frontend GC audit replaces damaged storage with validated entries", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let written: string | null = null;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => "{damaged",
      setItem: (_key: string, value: string) => {
        written = value;
      },
    },
  });

  try {
    appendFrontendAutoGcAudit({
      plan: partialMock<AutoGcPlan>({ victims: [], autoSkipped: [] }),
      result: partialMock<FrontendGcExecutionResult>({
        removedCount: 0,
        removedEstimatedBytes: 0,
      }),
    });
    assert.equal(typeof written, "string");
    if (written === null) assert.fail("Expected GC audit to write local storage");
    const stored: unknown = JSON.parse(written);
    assert.ok(Array.isArray(stored));
    assert.equal(stored.length, 1);
    const firstEntry: unknown = stored[0];
    assert.ok(firstEntry && typeof firstEntry === "object");
    assert.equal(Reflect.get(firstEntry, "mode"), "auto-gc");
    assert.equal(Reflect.get(firstEntry, "victimCount"), 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
