import assert from "node:assert/strict";
import test from "node:test";

import {
  clampHistoryRangeToNow,
  coverageForHistoryPage,
  mergeHistoryCoverage,
  nextUncoveredHistoryRange,
} from "../marketHistoryCoverage.js";

test("future-only market history ranges are not requested", () => {
  assert.equal(clampHistoryRangeToNow({ startMs: 2_001, endMs: 3_000 }, 2_000), null);
});

test("market history ranges crossing now are clamped to the current time", () => {
  assert.deepEqual(
    clampHistoryRangeToNow({ startMs: 1_000, endMs: 3_000 }, 2_000),
    { startMs: 1_000, endMs: 2_000 },
  );
});

test("a full finite page advances the next request to the older uncovered range", () => {
  const requested = { startMs: 1_000, endMs: 10_000 };
  const first = coverageForHistoryPage(requested, {
    count: 500,
    coverage: { earliest_ms: 6_000, latest_ms: 10_000, complete: false },
    has_more: true,
    fallback: false,
  }, "backward");
  assert.deepEqual(first, { startMs: 6_000, endMs: 10_000 });
  assert.deepEqual(
    nextUncoveredHistoryRange([first], requested),
    { startMs: 1_000, endMs: 5_999 },
  );

  const secondRequest = { startMs: 1_000, endMs: 5_999 };
  const second = coverageForHistoryPage(secondRequest, {
    count: 500,
    coverage: { earliest_ms: 2_000, latest_ms: 5_999, complete: false },
    has_more: true,
    fallback: false,
  }, "backward");
  assert.ok(second);
  const coverage = mergeHistoryCoverage([first], second);
  assert.deepEqual(
    nextUncoveredHistoryRange(coverage, requested),
    { startMs: 1_000, endMs: 1_999 },
  );
});

test("Funding full pages advance forward from the oldest page", () => {
  const requested = { startMs: 1_000, endMs: 10_000 };
  const covered = coverageForHistoryPage(requested, {
    count: 1_000,
    coverage: { earliest_ms: 1_000, latest_ms: 6_000, complete: false },
    has_more: true,
    fallback: false,
  }, "forward");
  assert.deepEqual(covered, { startMs: 1_000, endMs: 6_000 });
  assert.deepEqual(
    nextUncoveredHistoryRange(covered ? [covered] : [], requested),
    { startMs: 6_001, endMs: 10_000 },
  );
});

test("explicitly complete pages close the request while fallback stays retryable", () => {
  const requested = { startMs: 1_000, endMs: 5_000 };
  const shortPage = coverageForHistoryPage(requested, {
    count: 12,
    coverage: { earliest_ms: 2_000, latest_ms: 4_000, complete: true },
    has_more: false,
    fallback: false,
  }, "backward");
  assert.deepEqual(shortPage, requested);
  assert.equal(nextUncoveredHistoryRange(shortPage ? [shortPage] : [], requested), null);

  const fallbackPage = coverageForHistoryPage(requested, {
    count: 12,
    coverage: { earliest_ms: 2_000, latest_ms: 4_000, complete: false },
    has_more: true,
    fallback: true,
  }, "backward");
  assert.equal(fallbackPage, null);
  assert.deepEqual(nextUncoveredHistoryRange([], requested), requested);
});

test("terminal empty pages become resolved coverage instead of a retry loop", () => {
  const requested = { startMs: 1_000, endMs: 5_000 };
  const exhausted = coverageForHistoryPage(requested, {
    count: 0,
    coverage: { earliest_ms: null, latest_ms: null, complete: false },
    fallback: false,
    history_state: "exhausted",
    complete: true,
    retryable: false,
  }, "backward");

  assert.deepEqual(exhausted, requested);
  assert.equal(nextUncoveredHistoryRange(exhausted ? [exhausted] : [], requested), null);

  const exhaustedFallback = coverageForHistoryPage(requested, {
    count: 0,
    coverage: { earliest_ms: null, latest_ms: null, complete: false },
    fallback: true,
    history_state: "exhausted",
    complete: true,
    retryable: false,
  }, "backward");
  assert.deepEqual(exhaustedFallback, requested);

  const pending = coverageForHistoryPage(requested, {
    count: 0,
    coverage: { earliest_ms: null, latest_ms: null, complete: false },
    fallback: false,
    history_state: "pending",
    complete: false,
    retryable: true,
  }, "backward");
  assert.equal(pending, null);
});

test("coverage segments preserve real gaps instead of claiming one broad span", () => {
  const coverage = mergeHistoryCoverage(
    [{ startMs: 1_000, endMs: 2_000 }],
    { startMs: 4_000, endMs: 5_000 },
  );
  assert.deepEqual(
    nextUncoveredHistoryRange(coverage, { startMs: 1_000, endMs: 5_000 }),
    { startMs: 2_001, endMs: 3_999 },
  );
});
