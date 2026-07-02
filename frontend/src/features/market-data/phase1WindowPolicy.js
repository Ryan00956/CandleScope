export const MAX_SERIES_BARS = 10_000;
export const VIEWPORT_FETCH_BUFFER_BARS = 1_000;
export const MAX_RANGE_RESPONSE_BARS = 5_000;

export const USER_VISIBLE_BACKFILL_REASONS = new Set([
  "initial_history",
  "visible_range_gap",
  "visible_load_more",
  "visible_seed_gap",
  "tail_gap",
]);

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isUserVisibleBackfillReason(reason) {
  return USER_VISIBLE_BACKFILL_REASONS.has(String(reason || ""));
}

export function intersectRanges(left, right) {
  if (!left || !right) return null;
  const leftStart = finiteNumber(left.start);
  const leftEnd = finiteNumber(left.end);
  const rightStart = finiteNumber(right.start);
  const rightEnd = finiteNumber(right.end);
  if (leftStart == null || leftEnd == null || rightStart == null || rightEnd == null) return null;
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  if (end < start) return null;
  return { start, end };
}

export function trimRowsToMaxBars(rows, maxBars = MAX_SERIES_BARS) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = finiteNumber(maxBars) || MAX_SERIES_BARS;
  if (list.length <= limit) {
    return {
      rows: list,
      trimmedLeft: 0,
      trimmedRight: 0,
      originalBars: list.length,
    };
  }
  const trimmedLeft = list.length - limit;
  return {
    rows: list.slice(trimmedLeft),
    trimmedLeft,
    trimmedRight: 0,
    originalBars: list.length,
  };
}

export function activeCoverageMsFromRows(rows) {
  if (!rows?.length) return null;
  let min = null;
  let max = null;
  for (const row of rows) {
    const time = finiteNumber(row?.time);
    if (time == null) continue;
    if (min == null || time < min) min = time;
    if (max == null || time > max) max = time;
  }
  if (min == null || max == null) return null;
  return {
    start: min * 1000,
    end: max * 1000,
  };
}

export function latestBufferedRangeFromRows(
  rows,
  intervalSeconds,
  bufferBars = VIEWPORT_FETCH_BUFFER_BARS,
) {
  if (!rows?.length || !intervalSeconds || intervalSeconds <= 0) return null;
  const lastTime = finiteNumber(rows[rows.length - 1]?.time);
  if (lastTime == null) return null;
  const bufferSeconds = intervalSeconds * bufferBars;
  return {
    start: Math.max(0, lastTime - bufferSeconds),
    end: lastTime + bufferSeconds,
  };
}

export function clampRangeToMaxBars(range, intervalSeconds, maxBars = MAX_RANGE_RESPONSE_BARS) {
  if (!range || !intervalSeconds || intervalSeconds <= 0) return null;
  const start = finiteNumber(range.start);
  const end = finiteNumber(range.end);
  if (start == null || end == null || end < start) return null;
  const maxSpanSeconds = Math.max(0, (maxBars - 1) * intervalSeconds);
  return {
    start: Math.max(start, end - maxSpanSeconds),
    end,
  };
}
