import assert from "node:assert/strict";
import test from "node:test";

import { planTargetBarRequest } from "../intervalRequestBudget.js";

test("request budget uses the largest exact native base and preserves aliases", () => {
  const nativeIntervals = ["1m", "3m", "5m", "15m", "30m", "1h"];

  assert.deepEqual(planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "60m",
    nativeIntervals,
    sourceRowBudget: 20_000,
  }), {
    baseInterval: "1h",
    blockedReason: null,
    budgetLimited: false,
    derived: false,
    estimatedSourceRows: 1_500,
    sourceFactor: 1,
    targetBars: 1_500,
  });
  assert.equal(planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "45m",
    nativeIntervals,
    sourceRowBudget: 20_000,
  })?.baseInterval, "15m");
});

test("calendar and weekly plans honor the same hard source-row bound as the backend", () => {
  const month = planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "1M",
    nativeIntervals: ["1d"],
    sourceRowBudget: 20_000,
  });
  const twoMonths = planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "2M",
    nativeIntervals: ["1d", "1M"],
    sourceRowBudget: 20_000,
  });
  const twoWeeks = planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "2w",
    nativeIntervals: ["1d"],
    sourceRowBudget: 20_000,
  });

  assert.deepEqual(
    { factor: month?.sourceFactor, rows: month?.estimatedSourceRows, target: month?.targetBars },
    { factor: 31, rows: 19_995, target: 642 },
  );
  assert.deepEqual(
    { base: twoMonths?.baseInterval, factor: twoMonths?.sourceFactor, target: twoMonths?.targetBars },
    { base: "1M", factor: 2, target: 1_500 },
  );
  assert.deepEqual(
    { factor: twoWeeks?.sourceFactor, rows: twoWeeks?.estimatedSourceRows, target: twoWeeks?.targetBars },
    { factor: 14, rows: 19_992, target: 1_425 },
  );
  assert.ok((month?.estimatedSourceRows || Infinity) <= 20_000);
  assert.ok((twoMonths?.estimatedSourceRows || Infinity) <= 20_000);
  assert.ok((twoWeeks?.estimatedSourceRows || Infinity) <= 20_000);
});

test("a valid interval that cannot fit one bounded request is blocked instead of expanded", () => {
  const plan = planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "10001m",
    nativeIntervals: ["1m"],
    sourceRowBudget: 10_000,
  });

  assert.equal(plan?.budgetLimited, true);
  assert.equal(plan?.sourceFactor, 10_001);
  assert.equal(plan?.targetBars, 0);
  assert.equal(plan?.estimatedSourceRows, 0);
});

test("a capped derived request reports that the source budget limited it", () => {
  const plan = planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "89m",
    nativeIntervals: ["1m", "3m", "5m", "15m", "30m", "1h"],
    sourceRowBudget: 20_000,
  });

  assert.equal(plan.budgetLimited, true);
  assert.equal(plan.blockedReason, null);
  assert.equal(plan.sourceFactor, 89);
  assert.equal(plan.targetBars, 221);
  assert.equal(plan.estimatedSourceRows, 19_936);
});

test("an unknown derived route fails closed while native capabilities are unavailable", () => {
  const plan = planTargetBarRequest({
    desiredTargetBars: 1_500,
    interval: "89m",
    nativeIntervals: [],
    sourceRowBudget: 20_000,
  });

  assert.deepEqual(plan, {
    baseInterval: null,
    blockedReason: "unresolved-source",
    budgetLimited: true,
    derived: true,
    estimatedSourceRows: 0,
    sourceFactor: 0,
    targetBars: 0,
  });
});
