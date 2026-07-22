import assert from "node:assert/strict";
import test from "node:test";

import {
  inferFixedIntervalClosedThrough,
  nextIndicatorBarTime,
  planDeferredRightCatchup,
  planIndicatorCorrectionRefresh,
  planVisibleIndicatorHydrationRange,
  resolveInitialHostedRange,
  VISIBLE_RANGE_RIGHT_PREFETCH_BUCKET_BARS,
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

test("visible hydration keeps initial and leftward navigation exact", () => {
  const chartData = bars(5_000);
  const initialDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 1_000, to: 1_419 } },
  ));
  const initial = planVisibleIndicatorHydrationRange({
    chartData,
    desired: initialDesired,
    interval: "1m",
    previous: null,
    seriesKey: "session|1m",
  });
  assert.equal(initial.direction, "initial");
  assert.deepEqual(initial.range, {
    start: initialDesired.start,
    end: initialDesired.end,
  });

  const leftDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 500, to: 919 } },
  ));
  const left = planVisibleIndicatorHydrationRange({
    chartData,
    desired: leftDesired,
    interval: "1m",
    previous: initial.nextState,
    seriesKey: "session|1m",
  });
  assert.equal(left.direction, "left");
  assert.equal(left.endIndex, leftDesired.endIndex);
  assert.deepEqual(left.range, { start: leftDesired.start, end: leftDesired.end });
});

test("rightward visible hydration uses a fixed K-line bucket instead of a sliding tail", () => {
  const chartData = bars(5_000);
  const initialDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 0, to: 419 } },
  ));
  const initial = planVisibleIndicatorHydrationRange({
    chartData,
    desired: initialDesired,
    interval: "1m",
    seriesKey: "session|1m",
  });
  const firstRightDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 420, to: 839 } },
  ));
  const firstRight = planVisibleIndicatorHydrationRange({
    chartData,
    desired: firstRightDesired,
    interval: "1m",
    previous: initial.nextState,
    seriesKey: "session|1m",
  });
  assert.equal(firstRight.direction, "right");
  assert.equal(firstRight.endIndex, VISIBLE_RANGE_RIGHT_PREFETCH_BUCKET_BARS - 1);
  assert.equal(firstRight.range.end, barAt(
    chartData,
    VISIBLE_RANGE_RIGHT_PREFETCH_BUCKET_BARS - 1,
  ).time);

  const sameBucketDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 840, to: 1_259 } },
  ));
  const sameBucket = planVisibleIndicatorHydrationRange({
    chartData,
    desired: sameBucketDesired,
    interval: "1m",
    previous: firstRight.nextState,
    seriesKey: "session|1m",
  });
  assert.equal(sameBucket.endIndex, firstRight.endIndex);

  const nextBucketDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 1_260, to: 1_679 } },
  ));
  const nextBucket = planVisibleIndicatorHydrationRange({
    chartData,
    desired: nextBucketDesired,
    interval: "1m",
    previous: sameBucket.nextState,
    seriesKey: "session|1m",
  });
  assert.equal(nextBucket.endIndex, VISIBLE_RANGE_RIGHT_PREFETCH_BUCKET_BARS * 2 - 1);
});

test("visible right prefetch stops at a K-line hole and resets across series", () => {
  const chartData = bars(2_000);
  for (let index = 1_200; index < chartData.length; index += 1) {
    chartData[index] = structuralMock<KlineBar>({
      time: barAt(chartData, index).time + 60,
    });
  }
  const previousDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA" }],
    { logical: { from: 0, to: 419 } },
  ));
  const previous = planVisibleIndicatorHydrationRange({
    chartData,
    desired: previousDesired,
    interval: "1m",
    seriesKey: "session|1m",
  });
  const desired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA" }],
    { logical: { from: 420, to: 839 } },
  ));
  const stopped = planVisibleIndicatorHydrationRange({
    chartData,
    desired,
    interval: "1m",
    previous: previous.nextState,
    seriesKey: "session|1m",
  });
  assert.equal(stopped.endIndex, 1_199);
  assert.equal(stopped.range.end, barAt(chartData, 1_199).time);

  const reset = planVisibleIndicatorHydrationRange({
    chartData,
    desired,
    interval: "1m",
    previous: previous.nextState,
    seriesKey: "session|89m",
  });
  assert.equal(reset.direction, "initial");
  assert.equal(reset.endIndex, desired.endIndex);
  assert.deepEqual(reset.range, { start: desired.start, end: desired.end });
});

test("visible right prefetch follows calendar-month successors", () => {
  const monthBars = Array.from({ length: 24 }, (_, index) => structuralMock<KlineBar>({
    time: Date.UTC(2024, index, 1) / 1_000,
  }));
  const initialDesired = mustBeDefined(resolveInitialHostedRange(
    monthBars,
    [{ id: "ema", engineName: "EMA" }],
    { logical: { from: 0, to: 2 } },
  ));
  const initial = planVisibleIndicatorHydrationRange({
    bucketBars: 12,
    chartData: monthBars,
    desired: initialDesired,
    interval: "1M",
    seriesKey: "session|1M",
  });
  const rightDesired = mustBeDefined(resolveInitialHostedRange(
    monthBars,
    [{ id: "ema", engineName: "EMA" }],
    { logical: { from: 3, to: 5 } },
  ));
  const right = planVisibleIndicatorHydrationRange({
    bucketBars: 12,
    chartData: monthBars,
    desired: rightDesired,
    interval: "1M",
    previous: initial.nextState,
    seriesKey: "session|1M",
  });
  assert.equal(right.direction, "right");
  assert.equal(right.endIndex, 11);
  assert.equal(right.range.end, barAt(monthBars, 11).time);
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

test("89m correction refresh bounds finite rolling indicators but preserves recursive suffixes", () => {
  const step = 89 * 60;
  const dirty = { start: 1_700_000_000, end: 1_700_000_000 + step * 9 };
  const desired = {
    start: dirty.start - step * 100,
    end: dirty.end + step * 500,
  };

  const ma = mustBeDefined(planIndicatorCorrectionRefresh(
    dirty,
    desired,
    { id: "ma", engineName: "MA", params: { period: 20 } },
    "89m",
  ));
  assert.deepEqual(ma.affectedRange, {
    start: dirty.start,
    end: dirty.end + step * 19,
  });
  assert.equal(ma.cascadeRight, false);
  assert.deepEqual(ma.requestRange, ma.affectedRange);

  const ema = mustBeDefined(planIndicatorCorrectionRefresh(
    dirty,
    desired,
    { id: "ema", engineName: "EMA", params: { period: 20 } },
    "89m",
  ));
  assert.deepEqual(ema.affectedRange, dirty);
  assert.equal(ema.cascadeRight, true);
  assert.deepEqual(ema.requestRange, {
    start: dirty.start,
    end: desired.end,
  });

  const macd = mustBeDefined(planIndicatorCorrectionRefresh(
    dirty,
    desired,
    { id: "macd", engineName: "MACD", params: { slow: 26, signal: 9 } },
    "89m",
  ));
  assert.deepEqual(macd.affectedRange, dirty);
  assert.equal(macd.cascadeRight, true);
  assert.deepEqual(macd.requestRange, {
    start: dirty.start,
    end: desired.end,
  });

  const custom = mustBeDefined(planIndicatorCorrectionRefresh(
    dirty,
    desired,
    { id: "custom", engineName: "CUSTOM", script: "state := nz(state[1]) + close" },
    "89m",
  ));
  assert.equal(custom.cascadeRight, true);
  assert.equal(custom.requestRange?.end, desired.end);

  const volume = mustBeDefined(planIndicatorCorrectionRefresh(
    dirty,
    desired,
    { id: "vol", engineName: "VOL" },
    "89m",
  ));
  assert.deepEqual(volume.affectedRange, dirty);
  assert.equal(volume.cascadeRight, false);
});

test("correction outside the desired window rebases coverage without requesting the viewport", () => {
  const plan = mustBeDefined(planIndicatorCorrectionRefresh(
    { start: 1_000, end: 1_100 },
    { start: 10_000, end: 20_000 },
    { id: "vol", engineName: "VOL" },
    "1h",
  ));
  assert.deepEqual(plan.affectedRange, { start: 1_000, end: 1_100 });
  assert.equal(plan.requestRange, null);
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
