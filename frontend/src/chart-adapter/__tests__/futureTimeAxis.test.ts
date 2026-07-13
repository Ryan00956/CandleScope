import assert from "node:assert/strict";
import test from "node:test";

import {
  canReuseFutureTimeAxisData,
  countFutureTimeAxisPointsAfter,
  FUTURE_TIME_AXIS_MAX_POINTS,
  FUTURE_TIME_AXIS_ORDINAL_ORDER_START,
  planFutureTimeAxis,
  resolveFutureTimeAxisPointCount as resolveFutureTimeAxisPointCountProduction,
} from "../futureTimeAxis.js";
import type { ChartTime } from "../chartAdapterTypes.js";
import type { OrdinalAxisTime } from "../../features/chart-representation/chartRepresentationTypes.js";
import { mustBeDefined, structuralMock } from "../../test/testHelpers.js";

function ordinalTime(value: ChartTime): OrdinalAxisTime {
  if (value === null || typeof value !== "object" || !("order" in value)) {
    throw new Error("Expected ordinal axis time");
  }
  return structuralMock<OrdinalAxisTime>(value);
}

function resolveFutureTimeAxisPointCount(value: object): number {
  return resolveFutureTimeAxisPointCountProduction(
    structuralMock<NonNullable<Parameters<typeof resolveFutureTimeAxisPointCountProduction>[0]>>(value),
  );
}

test("time-axis carrier builds fixed-interval whitespace without mutating display rows", () => {
  const displayRows = [{ time: 100, close: 1 }, { time: 160, close: 2 }];
  const snapshot = structuredClone(displayRows);
  const plan = planFutureTimeAxis({
    displayRows,
    pointCount: 3,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 160,
  });

  assert.equal(plan.changed, true);
  assert.deepEqual(plan.data, [
    { time: 220 },
    { time: 280 },
    { time: 340 },
  ]);
  assert.deepEqual(displayRows, snapshot);
});

test("time-axis carrier uses UTC calendar months from the original horizon", () => {
  const january31 = Date.UTC(2024, 0, 31, 12) / 1_000;
  const february29 = Date.UTC(2024, 1, 29, 12) / 1_000;
  const march31 = Date.UTC(2024, 2, 31, 12) / 1_000;
  const plan = planFutureTimeAxis({
    displayRows: [{ time: january31 }],
    pointCount: 2,
    sourceInterval: "1M",
    sourceIntervalSeconds: 2_592_000,
    sourceTimeHorizon: january31,
  });

  assert.deepEqual(plan.data, [{ time: february29 }, { time: march31 }]);
});

test("ordinal carrier extends order while labeling cells from the raw source horizon", () => {
  const displayRows = [{
    time: { order: 7, sourceTime: 160, sourceOrdinal: 2 },
    close: 2,
  }];
  const plan = planFutureTimeAxis({
    axisMode: "derived-ordinal",
    displayRows,
    pointCount: 2,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 220,
  });

  assert.deepEqual(plan.data, [
    {
      time: {
        order: FUTURE_TIME_AXIS_ORDINAL_ORDER_START + 1,
        sourceTime: 280,
        sourceOrdinal: 0,
      },
    },
    {
      time: {
        order: FUTURE_TIME_AXIS_ORDINAL_ORDER_START + 2,
        sourceTime: 340,
        sourceOrdinal: 0,
      },
    },
  ]);
  assert.ok(plan.data[0].time.order > displayRows[0].time.order);
});

test("ordinal carrier keeps stable isolated keys when its source horizon advances", () => {
  const first = planFutureTimeAxis({
    axisMode: "derived-ordinal",
    displayRows: [{
      time: { order: 9, sourceTime: 160, sourceOrdinal: 0 },
    }],
    pointCount: 2,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 160,
  });
  const second = planFutureTimeAxis({
    axisMode: "derived-ordinal",
    currentKey: first.key,
    displayRows: [{
      time: { order: 7, sourceTime: 220, sourceOrdinal: 0 },
    }],
    pointCount: 2,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 220,
  });

  assert.equal(second.changed, true);
  assert.deepEqual(
    mustBeDefined(second.data).map((point) => ordinalTime(point.time).order),
    mustBeDefined(first.data).map((point) => ordinalTime(point.time).order),
  );
  assert.deepEqual(
    mustBeDefined(second.data).map((point) => ordinalTime(point.time).sourceTime),
    [280, 340],
  );
  assert.ok(mustBeDefined(second.data).every((point) => ordinalTime(point.time).order > 9));
});

test("the largest ordinal carrier allocation stays inside safe-integer space", () => {
  const plan = planFutureTimeAxis({
    axisMode: "derived-ordinal",
    displayRows: [{
      time: { order: 1, sourceTime: 100, sourceOrdinal: 0 },
    }],
    pointCount: FUTURE_TIME_AXIS_MAX_POINTS,
    sourceInterval: "1s",
    sourceIntervalSeconds: 1,
    sourceTimeHorizon: 100,
  });

  const lastOrder = ordinalTime(mustBeDefined(mustBeDefined(plan.data).at(-1)).time).order;
  assert.equal(lastOrder, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(lastOrder), true);
});

test("an unchanged carrier plan returns no replacement allocation", () => {
  const options = {
    displayRows: [{ time: 100 }],
    pointCount: 2,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 100,
  };
  const first = planFutureTimeAxis(options);
  const second = planFutureTimeAxis({ ...options, currentKey: first.key });

  assert.deepEqual(second, { changed: false, data: null, key: first.key });
});

test("carrier plan fails closed for invalid intervals and ordinal keys", () => {
  assert.deepEqual(planFutureTimeAxis({
    displayRows: [{ time: 100 }],
    pointCount: 2,
    sourceInterval: "bad",
    sourceIntervalSeconds: null,
    sourceTimeHorizon: 100,
  }).data, []);
  assert.deepEqual(planFutureTimeAxis({
    axisMode: "derived-ordinal",
    displayRows: [{ time: { order: 1.5, sourceTime: 100, sourceOrdinal: 0 } }],
    pointCount: 2,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 100,
  }).data, []);
});

test("numeric carrier is reused across continuous bars until its reserve runs low", () => {
  const currentData = [160, 220, 280, 340].map((time) => ({ time }));
  assert.equal(countFutureTimeAxisPointsAfter(currentData, 220), 2);
  assert.equal(canReuseFutureTimeAxisData({
    currentData,
    displayRows: [{ time: 100 }, { time: 160 }, { time: 220 }],
    reservePoints: 2,
    sourceTimeHorizon: 220,
  }), true);
  assert.equal(canReuseFutureTimeAxisData({
    currentData,
    displayRows: [{ time: 100 }, { time: 220 }],
    reservePoints: 2,
    sourceTimeHorizon: 220,
  }), false);
  assert.equal(canReuseFutureTimeAxisData({
    currentData,
    displayRows: [{ time: 100 }, { time: 160 }, { time: 220 }, { time: 280 }],
    reservePoints: 2,
    sourceTimeHorizon: 280,
  }), false);
  assert.equal(canReuseFutureTimeAxisData({
    axisMode: "derived-ordinal",
    currentData,
    displayRows: [{ time: 100 }, { time: 160 }, { time: 220 }],
    reservePoints: 2,
    sourceTimeHorizon: 220,
  }), false);
});

test("one-second bars reuse the carrier for a bounded batch of live updates", () => {
  const currentData = Array.from({ length: 64 }, (_, index) => ({
    time: index + 1,
  }));
  const displayRows = [{ time: 0 }];

  for (let horizon = 1; horizon <= 32; horizon += 1) {
    displayRows.push({ time: horizon });
    assert.equal(canReuseFutureTimeAxisData({
      currentData,
      displayRows,
      sourceTimeHorizon: horizon,
    }), true);
  }

  displayRows.push({ time: 33 });
  assert.equal(canReuseFutureTimeAxisData({
    currentData,
    displayRows,
    sourceTimeHorizon: 33,
  }), false);
});

test("future-axis capacity grows in chunks ahead of the visible right edge", () => {
  assert.equal(resolveFutureTimeAxisPointCount({
    contentLastLogical: 99,
    currentCount: 64,
    visibleLogicalRange: { from: 20, to: 104 },
  }), 64);
  assert.equal(resolveFutureTimeAxisPointCount({
    contentLastLogical: 99,
    currentCount: 64,
    visibleLogicalRange: { from: 100, to: 220 },
  }), 192);
  assert.equal(resolveFutureTimeAxisPointCount({
    contentLastLogical: 99,
    currentCount: 64,
    visibleLogicalRange: { from: 100, to: 100_000 },
  }), FUTURE_TIME_AXIS_MAX_POINTS);
});

test("future-axis capacity rebuilds consumed reserve and releases large expansions", () => {
  assert.equal(resolveFutureTimeAxisPointCount({
    allocatedCount: 384,
    contentLastLogical: 999,
    currentCount: 250,
    visibleLogicalRange: { from: 900, to: 1_267 },
  }), 384);
  assert.equal(resolveFutureTimeAxisPointCount({
    allocatedCount: 384,
    contentLastLogical: 999,
    currentCount: 384,
    visibleLogicalRange: { from: 900, to: 1_004 },
  }), 64);
  assert.equal(resolveFutureTimeAxisPointCount({
    allocatedCount: 384,
    contentLastLogical: 999,
    currentCount: 384,
    visibleLogicalRange: null,
  }), 384);
});
