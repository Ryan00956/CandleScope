import assert from "node:assert/strict";
import test from "node:test";

import { planGapRepairs } from "../feed/gapRepairPlanner.js";
import type { KlineBar } from "../marketDataTypes.js";
import { epochSeconds, mustBeDefined } from "../../../test/testHelpers.js";

function rows(times: number[]): KlineBar[] {
  return times.map((time) => ({ time: epochSeconds(time), close: time }));
}

function utcSeconds(value: string): number {
  return Date.parse(`${value}T00:00:00Z`) / 1_000;
}

test("plans only gaps near the visible window and keeps the scan bounded", () => {
  const data = rows(Array.from({ length: 35 }, (_value, index) => index * 60)
    .filter((time) => time !== 600 && time !== 1_200 && time !== 1_800));

  const plans = planGapRepairs(data, 60, {
    visibleRange: { time: { from: 1_000, to: 1_400 } },
    bufferBars: 1,
    maxScanBars: 10,
  });

  assert.deepEqual(plans, [{ start: 1_200, end: 1_200, missingBars: 1 }]);
});

test("planner subtracts persisted excluded calendar ranges", () => {
  const plans = planGapRepairs(rows([0, 60, 300, 360]), 60, {
    excludedRanges: [{ start_ms: 120_000, end_ms: 180_000, reason: "market_closed" }],
  });

  assert.deepEqual(plans, [{ start: 240, end: 240, missingBars: 1 }]);
});

test("planner retries a temporarily excluded gap once its deadline expires", () => {
  const data = rows([0, 60, 240, 300]);
  const excludedRanges = [{
    start_ms: 120_000,
    end_ms: 180_000,
    reason: "source_empty",
    retry_at_ms: 20_000,
  }];

  assert.deepEqual(planGapRepairs(data, 60, {
    excludedRanges,
    nowMs: 19_999,
  }), []);
  assert.deepEqual(planGapRepairs(data, 60, {
    excludedRanges,
    nowMs: 20_000,
  }), [{ start: 120, end: 180, missingBars: 2 }]);
});

test("planner caps repair count and total requested bars", () => {
  const plans = planGapRepairs(rows([0, 1_000, 2_000]), 10, {
    maxRepairs: 1,
    maxRepairBars: 3,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.missingBars, 3);
  assert.deepEqual(plans[0], { start: 1_970, end: 1_990, missingBars: 3 });
});

test("visible budget plans stay aligned to the candidate candle grid", () => {
  const plans = planGapRepairs(rows([0, 1_200]), 60, {
    visibleRange: { time: { from: 500, to: 620 } },
    maxRepairs: 1,
    maxRepairBars: 3,
  });

  assert.deepEqual(plans, [{ start: 480, end: 600, missingBars: 3 }]);
  assert.equal((mustBeDefined(plans[0]).start - 60) % 60, 0);
});

test("monthly planner emits exact calendar opens instead of fixed 30-day ranges", () => {
  const january = utcSeconds("2026-01-01");
  const february = utcSeconds("2026-02-01");
  const march = utcSeconds("2026-03-01");

  const plans = planGapRepairs(rows([january, march]), 30 * 86_400, {
    interval: "1M",
  });

  assert.deepEqual(plans, [{
    start: epochSeconds(february),
    end: epochSeconds(february),
    missingBars: 1,
  }]);
});

test("multi-month planner advances by calendar month count and respects exclusions", () => {
  const january = utcSeconds("2026-01-01");
  const march = utcSeconds("2026-03-01");
  const may = utcSeconds("2026-05-01");
  const july = utcSeconds("2026-07-01");

  const plans = planGapRepairs(rows([january, july]), 60 * 86_400, {
    interval: "2M",
    excludedRanges: [{
      start_ms: march * 1_000,
      end_ms: march * 1_000,
      reason: "source_unavailable",
    }],
  });

  assert.deepEqual(plans, [{
    start: epochSeconds(may),
    end: epochSeconds(may),
    missingBars: 1,
  }]);
});
