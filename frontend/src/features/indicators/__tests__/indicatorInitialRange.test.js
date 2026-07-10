import assert from "node:assert/strict";
import test from "node:test";

import {
  inferFixedIntervalClosedThrough,
  planDeferredRightCatchup,
  resolveInitialHostedRange,
} from "../indicatorRangePlanning.js";

function bars(count) {
  return Array.from({ length: count }, (_, index) => ({ time: 1_700_000_000 + index * 60 }));
}

test("inferFixedIntervalClosedThrough excludes the current forming bar", () => {
  const day = 86_400;
  const chartData = Array.from({ length: 3 }, (_, index) => ({
    time: 1_700_006_400 + index * day,
  }));

  assert.equal(
    inferFixedIntervalClosedThrough(chartData, "1d", (chartData[2].time + day / 2) * 1_000),
    chartData[1].time,
  );
  assert.equal(
    inferFixedIntervalClosedThrough(chartData, "1d", (chartData[2].time + day) * 1_000),
    chartData[2].time,
  );
  assert.equal(inferFixedIntervalClosedThrough(chartData, "1M", Date.now()), null);
});

test("resolveInitialHostedRange prioritizes visible bars with warmup and left padding", () => {
  const chartData = bars(2_000);
  const range = resolveInitialHostedRange(
    chartData,
    [{ id: "ma", engineName: "MA", params: { period: 20 } }],
    {
      time: {
        from: chartData[1_000].time,
        to: chartData[1_099].time,
      },
    },
  );

  assert.equal(range.visibleStart, chartData[1_000].time);
  assert.equal(range.visibleEnd, chartData[1_099].time);
  assert.equal(range.warmupBars, 19);
  assert.equal(range.paddingBars, 120);
  assert.equal(range.startIndex, 861);
  assert.equal(range.endIndex, 1_099);
  assert.equal(range.visibleStartIndex, 1_000);
  assert.equal(range.visibleEndIndex, 1_099);
  assert.equal(range.start, chartData[861].time);
  assert.equal(range.end, chartData[1_099].time);
});

test("resolveInitialHostedRange falls back to the latest viewport-sized slice", () => {
  const chartData = bars(2_000);
  const range = resolveInitialHostedRange(chartData, [{ id: "vol", engineName: "VOL" }], null);

  assert.equal(range.visibleStart, chartData[1_400].time);
  assert.equal(range.visibleEnd, chartData[1_999].time);
  assert.equal(range.warmupBars, 0);
  assert.equal(range.paddingBars, 210);
  assert.equal(range.startIndex, 1_190);
  assert.equal(range.endIndex, 1_999);
  assert.equal(range.start, chartData[1_190].time);
  assert.equal(range.end, chartData[1_999].time);
});

test("resolveInitialHostedRange covers all bars after a full-content fit", () => {
  const chartData = bars(1_501);
  const range = resolveInitialHostedRange(
    chartData,
    [
      { id: "boll", engineName: "BOLL", params: { period: 20 } },
      { id: "macd", engineName: "MACD", params: { slow: 26, signal: 9 } },
    ],
    {
      logical: { from: -0.5, to: 1_500.5 },
      time: { from: chartData[0].time, to: chartData[1_500].time },
    },
  );

  assert.equal(range.visibleStartIndex, 0);
  assert.equal(range.visibleEndIndex, 1_500);
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 1_500);
  assert.equal(range.start, chartData[0].time);
  assert.equal(range.end, chartData[1_500].time);
});

test("resolveInitialHostedRange handles irregular monthly spacing", () => {
  const monthBars = [
    { time: 1_704_067_200 },
    { time: 1_706_745_600 },
    { time: 1_709_424_000 },
    { time: 1_712_016_000 },
  ];

  const range = resolveInitialHostedRange(
    monthBars,
    [{ id: "ma", engineName: "MA", params: { period: 2 } }],
    {
      logical: {
        from: 1,
        to: 3,
      },
    },
  );

  assert.equal(range.start, monthBars[0].time);
  assert.equal(range.end, monthBars[3].time);
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 3);
});

test("planDeferredRightCatchup coalesces moving right edge without resetting grace", () => {
  const first = planDeferredRightCatchup(null, {
    key: "btc-1m-ma-120",
    signature: "range-120-180",
    range: { start: 120, end: 180 },
  }, 1_000, 1_500);

  const second = planDeferredRightCatchup(first, {
    key: "btc-1m-ma-120",
    signature: "range-120-240",
    range: { start: 120, end: 240 },
  }, 1_900, 1_500);

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
  const next = planDeferredRightCatchup(previous, {
    key: "btc-1m-ma-180",
    signature: "range-180-240",
    range: { start: 180, end: 240 },
  }, 2_000, 1_500);

  assert.equal(next.firstSeenAt, 2_000);
  assert.equal(next.delayMs, 1_500);
});
