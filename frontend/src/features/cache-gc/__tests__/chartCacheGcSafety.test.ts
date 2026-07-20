import assert from "node:assert/strict";
import test from "node:test";

import type { GcVictim } from "../cacheGcTypes.js";
import { planFrontendGc } from "../cachePolicy.js";
import {
  type ChartCacheGcSnapshot,
  validateChartCacheGcVictim,
} from "../chartCacheGcSafety.js";

const current: ChartCacheGcSnapshot = {
  key: "binance-spot-ETHUSDT-1m",
  activeKey: "binance-spot-BTCUSDT-1m",
  generation: 7,
  revision: 11,
  metaRevision: 13,
  lastAccessMs: 100,
  lastUpdatedMs: 90,
  bars: 3,
  estimatedBytes: 600,
};

function exactVictim(): GcVictim {
  const plan = planFrontendGc({
    generatedAtMs: 120,
    estimatedBytes: current.estimatedBytes,
    klineBars: current.bars,
    indicatorPoints: 0,
    owners: {
      chart: {
        entries: [{
          owner: "chart-data-cache",
          key: current.key,
          tier: "warm",
          bars: current.bars,
          estimatedBytes: current.estimatedBytes,
          lastAccessMs: current.lastAccessMs,
          lastUpdatedMs: current.lastUpdatedMs,
          generation: current.generation,
          revision: current.revision,
          metaRevision: current.metaRevision,
        }],
      },
      watchlist: { entries: [] },
      indicators: { entries: [] },
    },
  }, {
    maxEstimatedBytes: 1,
    maxKlineBars: 0,
    maxIndicatorPoints: 0,
    nowMs: 120,
  });
  const victim = plan.victims[0];
  assert.ok(victim);
  return victim;
}

test("chart cache GC permits only the exact planned snapshot", () => {
  assert.deepEqual(validateChartCacheGcVictim(exactVictim(), current), {
    allowed: true,
    reason: "exact-planned-snapshot",
  });
});

test("chart cache GC rejects a victim re-accessed after planning", () => {
  assert.deepEqual(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    lastAccessMs: Number(current.lastAccessMs) + 1,
  }), {
    allowed: false,
    reason: "accessed-after-plan",
  });
});

test("chart cache GC rejects same-millisecond access via the monotonic meta revision", () => {
  assert.deepEqual(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    metaRevision: current.metaRevision + 1,
  }), {
    allowed: false,
    reason: "access-or-meta-changed",
  });
});

test("chart cache GC rejects data updates, recreation, and resource growth", () => {
  assert.equal(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    lastUpdatedMs: Number(current.lastUpdatedMs) + 1,
  }).reason, "updated-after-plan");
  assert.equal(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    revision: current.revision + 1,
  }).reason, "revision-changed");
  assert.equal(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    generation: current.generation + 1,
  }).reason, "generation-changed");
  assert.equal(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    bars: current.bars + 1,
    estimatedBytes: current.estimatedBytes + 200,
  }).reason, "resource-totals-changed");
});

test("chart cache GC protects the current series and rejects guardless victims", () => {
  assert.equal(validateChartCacheGcVictim(exactVictim(), {
    ...current,
    activeKey: current.key,
  }).reason, "active-entry-protected");

  const guardless = exactVictim();
  delete guardless.resourceTotals;
  assert.equal(
    validateChartCacheGcVictim(guardless, current).reason,
    "resource-totals-changed",
  );

  const missingMetaGuard = exactVictim();
  delete missingMetaGuard.expectedMetaRevision;
  assert.equal(
    validateChartCacheGcVictim(missingMetaGuard, current).reason,
    "access-or-meta-changed",
  );
});
