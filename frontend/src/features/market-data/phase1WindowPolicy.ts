import type {
  KlineBarInput,
  TimeRangeMs,
  TimeRangeSec,
} from "./marketDataTypes.js";
import {
  secondsToMilliseconds,
  toEpochMilliseconds,
  toEpochSeconds,
} from "./marketDataTypes.js";

export const MAX_SERIES_BARS = 10_000;
export const VIEWPORT_FETCH_BUFFER_BARS = 1_000;
export const MAX_RANGE_RESPONSE_BARS = 5_000;

export type SeriesWindowRetention = "newest" | "oldest";

export const USER_VISIBLE_BACKFILL_REASONS: ReadonlySet<string> = new Set([
  "initial_history",
  "visible_range_gap",
  "visible_load_more",
  "visible_seed_gap",
  "tail_gap",
]);

interface RangeInput {
  start?: unknown;
  end?: unknown;
}

export function isUserVisibleBackfillReason(reason: unknown): boolean {
  return USER_VISIBLE_BACKFILL_REASONS.has(String(reason || ""));
}

export function intersectRanges(
  left: RangeInput | null | undefined,
  right: RangeInput | null | undefined,
): TimeRangeMs | null {
  if (!left || !right) return null;
  const leftStart = toEpochMilliseconds(left.start);
  const leftEnd = toEpochMilliseconds(left.end);
  const rightStart = toEpochMilliseconds(right.start);
  const rightEnd = toEpochMilliseconds(right.end);
  if (leftStart == null || leftEnd == null || rightStart == null || rightEnd == null) return null;
  const start = toEpochMilliseconds(Math.max(leftStart, rightStart));
  const end = toEpochMilliseconds(Math.min(leftEnd, rightEnd));
  if (start == null || end == null || end < start) return null;
  return { start, end };
}

export function trimRowsToMaxBars<TRow>(
  rows: TRow[] | null | undefined,
  maxBars: unknown = MAX_SERIES_BARS,
  retain: SeriesWindowRetention = "newest",
): {
  rows: TRow[];
  trimmedLeft: number;
  trimmedRight: number;
  originalBars: number;
} {
  const list = Array.isArray(rows) ? rows : [];
  const parsedLimit = Number(maxBars);
  const finiteLimit = Number.isFinite(parsedLimit) ? parsedLimit : null;
  const limit = finiteLimit || MAX_SERIES_BARS;
  if (list.length <= limit) {
    return {
      rows: list,
      trimmedLeft: 0,
      trimmedRight: 0,
      originalBars: list.length,
    };
  }
  const overflow = list.length - limit;
  if (retain === "oldest") {
    return {
      rows: list.slice(0, limit),
      trimmedLeft: 0,
      trimmedRight: overflow,
      originalBars: list.length,
    };
  }
  return {
    rows: list.slice(overflow),
    trimmedLeft: overflow,
    trimmedRight: 0,
    originalBars: list.length,
  };
}

export function activeCoverageMsFromRows(
  rows: readonly KlineBarInput[] | null | undefined,
): TimeRangeMs | null {
  if (!rows?.length) return null;
  let min = null;
  let max = null;
  for (const row of rows) {
    const time = toEpochSeconds(row?.time);
    if (time == null) continue;
    if (min == null || time < min) min = time;
    if (max == null || time > max) max = time;
  }
  if (min == null || max == null) return null;
  return {
    start: secondsToMilliseconds(min),
    end: secondsToMilliseconds(max),
  };
}

export function latestBufferedRangeFromRows(
  rows: readonly KlineBarInput[] | null | undefined,
  intervalSeconds: number | null | undefined,
  bufferBars = VIEWPORT_FETCH_BUFFER_BARS,
): TimeRangeSec | null {
  if (!rows?.length || !intervalSeconds || intervalSeconds <= 0) return null;
  const lastTime = toEpochSeconds(rows[rows.length - 1]?.time);
  if (lastTime == null) return null;
  const bufferSeconds = intervalSeconds * bufferBars;
  const start = toEpochSeconds(Math.max(0, lastTime - bufferSeconds));
  const end = toEpochSeconds(lastTime + bufferSeconds);
  return start == null || end == null ? null : { start, end };
}

export function clampRangeToMaxBars(
  range: RangeInput | null | undefined,
  intervalSeconds: number | null | undefined,
  maxBars = MAX_RANGE_RESPONSE_BARS,
): TimeRangeSec | null {
  if (!range || !intervalSeconds || intervalSeconds <= 0) return null;
  const start = toEpochSeconds(range.start);
  const end = toEpochSeconds(range.end);
  if (start == null || end == null || end < start) return null;
  const maxSpanSeconds = Math.max(0, (maxBars - 1) * intervalSeconds);
  const clampedStart = toEpochSeconds(Math.max(start, end - maxSpanSeconds));
  return clampedStart == null ? null : { start: clampedStart, end };
}
