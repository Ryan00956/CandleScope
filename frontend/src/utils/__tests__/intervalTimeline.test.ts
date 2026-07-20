import assert from "node:assert/strict";
import test from "node:test";

import { createIntervalTimeline } from "../intervalTimeline.js";

const utc = (year: number, month: number, day: number, hour = 0) => (
  Date.UTC(year, month - 1, day, hour) / 1_000
);

test("fixed and weekly timelines keep their distinct epoch anchors", () => {
  const sevenDays = createIntervalTimeline("7d");
  const oneWeek = createIntervalTimeline("1w");
  const tuesday = utc(2024, 1, 9, 12);

  assert.equal(sevenDays?.floor(tuesday), utc(2024, 1, 4));
  assert.equal(oneWeek?.floor(tuesday), utc(2024, 1, 8));
  assert.equal(oneWeek?.isSuccessor(utc(2024, 1, 8), utc(2024, 1, 15)), true);
  assert.equal(oneWeek?.isSuccessor(utc(2024, 1, 8), utc(2024, 1, 16)), false);
});

test("calendar month timeline handles leap years and absolute multi-month buckets", () => {
  const monthly = createIntervalTimeline("1M");
  assert.equal(monthly?.floor(utc(2024, 2, 29, 23)), utc(2024, 2, 1));
  assert.equal(monthly?.next(utc(2024, 2, 1)), utc(2024, 3, 1));
  assert.equal(monthly?.previous(utc(2024, 3, 1)), utc(2024, 2, 1));
  assert.equal(monthly?.isSuccessor(utc(2024, 1, 1), utc(2024, 2, 1)), true);

  const quarterly = createIntervalTimeline("3M");
  assert.equal(quarterly?.floor(utc(2024, 2, 29)), utc(2024, 1, 1));
  assert.equal(quarterly?.next(utc(2024, 1, 1)), utc(2024, 4, 1));
  assert.equal(quarterly?.floor(utc(2023, 12, 31)), utc(2023, 10, 1));
});
