import assert from "node:assert/strict";
import test from "node:test";

import {
  countBackToDays,
  normalizeRangeSec,
  planBarsFetch,
  requestKeyFor,
  rowRange,
  seriesKeyFor,
} from "../feed/fetchPlanner.js";

test("series key normalizes case-sensitive dimensions", () => {
  assert.equal(
    seriesKeyFor({ exchange: "Binance", marketType: "SPOT", symbol: "btcusdt", interval: "1h" }),
    "binance:spot:BTCUSDT:1h",
  );
});

test("series key canonicalizes fixed-duration aliases", () => {
  const base = { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" };
  assert.equal(
    seriesKeyFor({ ...base, interval: "60m" }),
    seriesKeyFor({ ...base, interval: "1h" }),
  );
});

test("request key sorts params for stable dedupe", () => {
  const series = { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1h" };
  assert.equal(
    requestKeyFor("range", series, { end: 20, start: 10 }),
    requestKeyFor("range", series, { start: 10, end: 20 }),
  );
});

test("normalizes valid second ranges and rejects invalid ranges", () => {
  assert.deepEqual(normalizeRangeSec({ start: "10", end: "20" }), { start: 10, end: 20 });
  assert.equal(normalizeRangeSec({ start: 20, end: 10 }), null);
  assert.equal(normalizeRangeSec({ start: null, end: 20 }), null);
});

test("row range ignores invalid rows", () => {
  assert.deepEqual(rowRange([{ time: 30 }, { time: "10" }, { time: null }]), { start: 10, end: 30 });
});

test("countBackToDays keeps sub-day intervals fractional", () => {
  assert.equal(countBackToDays(1500, 60, 7), 1.0416666666666667);
});

test("planBarsFetch routes explicit ranges, before pages, and countBack history", () => {
  assert.deepEqual(planBarsFetch({ from: 10, to: 20 }), {
    type: "range",
    range: { start: 10, end: 20 },
  });
  assert.deepEqual(planBarsFetch({ to: 20, countBack: 500 }), {
    type: "before",
    before: 20,
    bars: 500,
  });
  assert.deepEqual(planBarsFetch({ countBack: 120, intervalSeconds: 60 }), {
    type: "history",
    days: 0.08333333333333333,
    countBack: 120,
  });
});
