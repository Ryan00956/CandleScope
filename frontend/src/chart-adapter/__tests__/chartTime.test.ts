import test from "node:test";
import assert from "node:assert/strict";
import {
  chartTimeKey,
  chartTimesEqual,
  compareChartTimes,
  sourceTimeFromChartTime,
} from "../chartTime.js";
import type { OrdinalAxisTime } from "../../features/chart-representation/chartRepresentationTypes.js";
import type { ChartTime } from "../chartAdapterTypes.js";
import { malformedFixture } from "../../test/testHelpers.js";

function ordinal(order: number, sourceTime = 100, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

test("chart time helpers preserve numeric time behavior", () => {
  assert.equal(chartTimeKey(20), "time:20");
  assert.equal(compareChartTimes(10, 20), -10);
  assert.equal(compareChartTimes(20, 10), 10);
  assert.equal(chartTimesEqual(10, 10), true);
  assert.equal(chartTimesEqual(10, 20), false);
  assert.equal(sourceTimeFromChartTime(20), 20);
});

test("chart time helpers identify and order ordinal time by order", () => {
  const first = ordinal(3, 999, 2);
  const equivalent = ordinal(3, 999, 2);
  const reusedCoordinate = ordinal(3, 123, 0);
  const second = ordinal(4, 100, 0);

  assert.equal(chartTimeKey(first), "order:3:source:999:ordinal:2");
  assert.equal(chartTimeKey(second), "order:4:source:100:ordinal:0");
  assert.equal(chartTimesEqual(first, equivalent), true);
  assert.equal(chartTimesEqual(first, reusedCoordinate), false);
  assert.equal(sourceTimeFromChartTime(first), 999);
  assert.equal(sourceTimeFromChartTime(malformedFixture<ChartTime>({ order: 3 })), null);
  assert.ok(compareChartTimes(first, second) < 0);
  assert.ok(compareChartTimes(second, first) > 0);
});
