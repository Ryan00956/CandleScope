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
  assert.equal(mustBeDefined(plan.autoSkipped[0]).reason, "score-below-threshold");
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
