import assert from "node:assert/strict";
import test from "node:test";

import {
  inferFixedIntervalClosedThrough,
  nextIndicatorBarTime,
  planDeferredRightCatchup,
  resolveInitialHostedRange,
} from "../indicatorRangePlanning.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import { mustBeDefined, structuralMock } from "../../../test/testHelpers.js";

function bars(count: number): KlineBar[] {
  return Array.from({ length: count }, (_, index) => structuralMock<KlineBar>({
    time: 1_700_000_000 + index * 60,
  }));
}

function barAt(chartData: readonly KlineBar[], index: number): KlineBar {
  return mustBeDefined(chartData[index]);
}

test("inferFixedIntervalClosedThrough excludes the current forming bar", () => {
  const day = 86_400;
  const chartData = Array.from({ length: 3 }, (_, index) => structuralMock<KlineBar>({
    time: 1_700_006_400 + index * day,
  }));

  assert.equal(
    inferFixedIntervalClosedThrough(
      chartData,
      "1d",
      (barAt(chartData, 2).time + day / 2) * 1_000,
    ),
    barAt(chartData, 1).time,
  );
  assert.equal(
    inferFixedIntervalClosedThrough(
      chartData,
      "1d",
      (barAt(chartData, 2).time + day) * 1_000,
    ),
    barAt(chartData, 2).time,
  );
  assert.equal(inferFixedIntervalClosedThrough(chartData, "1M", Date.now()), null);
});

test("resolveInitialHostedRange prioritizes visible bars with warmup and left padding", () => {
  const chartData = bars(2_000);
  const range = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ma", engineName: "MA", params: { period: 20 } }],
    {
      time: {
        from: barAt(chartData, 1_000).time,
        to: barAt(chartData, 1_099).time,
      },
    },
  ));

  assert.equal(range.visibleStart, barAt(chartData, 1_000).time);
  assert.equal(range.visibleEnd, barAt(chartData, 1_099).time);
  assert.equal(range.warmupBars, 19);
  assert.equal(range.paddingBars, 120);
  assert.equal(range.startIndex, 861);
  assert.equal(range.endIndex, 1_099);
  assert.equal(range.visibleStartIndex, 1_000);
  assert.equal(range.visibleEndIndex, 1_099);
  assert.equal(range.start, barAt(chartData, 861).time);
  assert.equal(range.end, barAt(chartData, 1_099).time);
});

test("resolveInitialHostedRange falls back to the latest viewport-sized slice", () => {
  const chartData = bars(2_000);
  const range = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "vol", engineName: "VOL" }],
    null,
  ));

  assert.equal(range.visibleStart, barAt(chartData, 1_400).time);
  assert.equal(range.visibleEnd, barAt(chartData, 1_999).time);
  assert.equal(range.warmupBars, 0);
  assert.equal(range.paddingBars, 210);
  assert.equal(range.startIndex, 1_190);
  assert.equal(range.endIndex, 1_999);
  assert.equal(range.start, barAt(chartData, 1_190).time);
  assert.equal(range.end, barAt(chartData, 1_999).time);
});

test("resolveInitialHostedRange covers all bars after a full-content fit", () => {
  const chartData = bars(1_501);
  const range = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [
      { id: "boll", engineName: "BOLL", params: { period: 20 } },
      { id: "macd", engineName: "MACD", params: { slow: 26, signal: 9 } },
    ],
    {
      logical: { from: -0.5, to: 1_500.5 },
      time: {
        from: barAt(chartData, 0).time,
        to: barAt(chartData, 1_500).time,
      },
    },
  ));

  assert.equal(range.visibleStartIndex, 0);
  assert.equal(range.visibleEndIndex, 1_500);
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 1_500);
  assert.equal(range.start, barAt(chartData, 0).time);
  assert.equal(range.end, barAt(chartData, 1_500).time);
});

test("resolveInitialHostedRange handles irregular monthly spacing", () => {
  const monthBars: KlineBar[] = [
    structuralMock<KlineBar>({ time: 1_704_067_200 }),
    structuralMock<KlineBar>({ time: 1_706_745_600 }),
    structuralMock<KlineBar>({ time: 1_709_424_000 }),
    structuralMock<KlineBar>({ time: 1_712_016_000 }),
  ];

  const range = mustBeDefined(resolveInitialHostedRange(
    monthBars,
    [{ id: "ma", engineName: "MA", params: { period: 2 } }],
    {
      logical: {
        from: 1,
        to: 3,
      },
    },
  ));

  assert.equal(range.start, barAt(monthBars, 0).time);
  assert.equal(range.end, barAt(monthBars, 3).time);
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 3);
});

test("right catchup advances monthly bars by the calendar instead of median seconds", () => {
  const february = Date.UTC(2024, 1, 1) / 1_000;
  const march = Date.UTC(2024, 2, 1) / 1_000;
  const april = Date.UTC(2024, 3, 1) / 1_000;

  assert.equal(nextIndicatorBarTime(february, "1M", 31 * 86_400), march);
  assert.equal(nextIndicatorBarTime(march, "1M", 29 * 86_400), april);
  assert.equal(nextIndicatorBarTime(february, "47m", null), february + 47 * 60);
  assert.equal(nextIndicatorBarTime(february, "60m", null), february + 60 * 60);
});

test("planDeferredRightCatchup coalesces moving right edge without resetting grace", () => {
  const first = mustBeDefined(planDeferredRightCatchup(null, {
    key: "btc-1m-ma-120",
    signature: "range-120-180",
    range: { start: 120, end: 180 },
  }, 1_000, 1_500));

  const second = mustBeDefined(planDeferredRightCatchup(first, {
    key: "btc-1m-ma-120",
    signature: "range-120-240",
    range: { start: 120, end: 240 },
  }, 1_900, 1_500));

  assert.equal(first.firstSeenAt, 1_000);
  assert.equal(first.delayMs, 1_500);
  assert.equal(second.firstSeenAt, 1_000);
  assert.equal(second.delayMs, 600);
  assert.deepEqual(second.range, { start: 120, end: 240 });
});

test("planDeferredRightCatchup starts a new grace window when gap start changes", () => {
  const previous = {
    key: "btc-1m-ma-120",
    signature: "range-120-180",
    range: { start: 120, end: 180 },
    firstSeenAt: 1_000,
  };
  const next = mustBeDefined(planDeferredRightCatchup(previous, {
    key: "btc-1m-ma-180",
    signature: "range-180-240",
    range: { start: 180, end: 240 },
  }, 2_000, 1_500));

  assert.equal(next.firstSeenAt, 2_000);
  assert.equal(next.delayMs, 1_500);
});
