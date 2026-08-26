import assert from "node:assert/strict";
import test from "node:test";

import {
  planRightWindowPage,
  rightWindowPageReachedLatest,
  rightWindowPageRowsAreBounded,
} from "../rightWindowPagination.js";
import type { KlineBar } from "../marketDataTypes.js";
import { epochSeconds } from "../../../test/testHelpers.js";

function rows(times: number[]): KlineBar[] {
  return times.map((time) => ({ time: epochSeconds(time) }));
}

test("right-window paging plans the exact adjacent fixed-interval page", () => {
  assert.deepEqual(planRightWindowPage("1m", 600, 3), {
    start: 660,
    end: 780,
    bars: 3,
  });
});

test("right-window paging preserves calendar-month boundaries", () => {
  const january = Date.UTC(2024, 0, 1) / 1_000;
  assert.deepEqual(planRightWindowPage("1M", january, 3), {
    start: Date.UTC(2024, 1, 1) / 1_000,
    end: Date.UTC(2024, 3, 1) / 1_000,
    bars: 3,
  });
});

test("right-window paging detects only a server-clipped current tail", () => {
  const plan = { start: 100, end: 300, bars: 3 };
  assert.equal(rightWindowPageReachedLatest({
    data: [],
    effective_end_ms: 300_000,
    reached_latest_closed_bar: true,
  }, plan), true);
  assert.equal(rightWindowPageReachedLatest({
    data: [],
    effective_end_ms: 299_000,
    reached_latest_closed_bar: false,
  }, plan), false);
  assert.equal(rightWindowPageReachedLatest({ data: [], effective_end_ms: 299_000 }, plan), true);
  assert.equal(rightWindowPageReachedLatest({ data: [], effective_end_ms: 300_000 }, plan), false);
  assert.equal(rightWindowPageReachedLatest({ data: [] }, plan), false);
});

test("right-window page rows must stay ordered inside the requested range", () => {
  const plan = { start: 100, end: 300, bars: 3 };
  assert.equal(rightWindowPageRowsAreBounded(rows([100, 200, 300]), plan), true);
  assert.equal(rightWindowPageRowsAreBounded(rows([99, 200]), plan), false);
  assert.equal(rightWindowPageRowsAreBounded(rows([100, 301]), plan), false);
  assert.equal(rightWindowPageRowsAreBounded(rows([200, 100]), plan), false);
});
