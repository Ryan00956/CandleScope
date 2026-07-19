import { detectGaps } from "../chartDataRuntime.js";
import type { HistoryExcludedRange } from "../klineContracts.js";
import type {
  EpochSeconds,
  KlineBar,
  TimeRangeSec,
} from "../marketDataTypes.js";
import { toEpochSeconds } from "../marketDataTypes.js";

export const DEFAULT_GAP_SCAN_BARS = 2_500;
export const DEFAULT_GAP_BUFFER_BARS = 250;
export const DEFAULT_MAX_GAP_REPAIRS = 4;
export const DEFAULT_MAX_GAP_REPAIR_BARS = 3_000;

export interface VisibleTimeRangeLike {
  time?: { from?: unknown; to?: unknown } | null;
}

export interface GapRepairPlan extends TimeRangeSec {
  missingBars: number;
}

export interface GapRepairPlanningOptions {
  visibleRange?: VisibleTimeRangeLike | null;
  excludedRanges?: readonly HistoryExcludedRange[] | null;
  interval?: string | null;
  nowMs?: number;
  maxScanBars?: number;
  bufferBars?: number;
  maxRepairs?: number;
  maxRepairBars?: number;
}

interface MonthlyGapCandidate {
  opens: EpochSeconds[];
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}

function normalizeVisibleRange(range: VisibleTimeRangeLike | null | undefined): TimeRangeSec | null {
  const from = toEpochSeconds(range?.time?.from);
  const to = toEpochSeconds(range?.time?.to);
  if (from == null || to == null) return null;
  return from <= to ? { start: from, end: to } : { start: to, end: from };
}

function rowsForBoundedScan(
  rows: readonly KlineBar[],
  intervalSeconds: number,
  visibleRange: TimeRangeSec | null,
  maxScanBars: number,
  bufferBars: number,
): KlineBar[] {
  if (rows.length <= maxScanBars && !visibleRange) return [...rows];
  if (!visibleRange) return rows.slice(-maxScanBars);

  const bufferedStart = visibleRange.start - bufferBars * intervalSeconds;
  const bufferedEnd = visibleRange.end + bufferBars * intervalSeconds;
  let startIndex = rows.findIndex((row) => row.time >= bufferedStart);
  if (startIndex < 0) startIndex = Math.max(0, rows.length - maxScanBars);
  else startIndex = Math.max(0, startIndex - 1);

  let endIndex = rows.length - 1;
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row && row.time > bufferedEnd) {
      endIndex = index;
      break;
    }
  }
  const boundedStart = Math.max(startIndex, endIndex - maxScanBars + 1);
  return rows.slice(boundedStart, endIndex + 1);
}

function excludedSeconds(
  ranges: readonly HistoryExcludedRange[] | null | undefined,
  nowMs: number,
): TimeRangeSec[] {
  if (!ranges?.length) return [];
  return ranges.flatMap((range) => {
    const retryAtMs = Number(range.retry_at_ms);
    if (range.retry_at_ms != null && Number.isFinite(retryAtMs) && retryAtMs <= nowMs) {
      return [];
    }
    const start = toEpochSeconds(Number(range.start_ms) / 1_000);
    const end = toEpochSeconds(Number(range.end_ms) / 1_000);
    return start == null || end == null || end < start ? [] : [{ start, end }];
  });
}

function monthlyIntervalCount(interval: string | null | undefined): number | null {
  const match = /^(\d+)M$/.exec(String(interval || "").trim());
  if (!match?.[1]) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function addUtcMonths(open: EpochSeconds, months: number): EpochSeconds | null {
  const current = new Date(Number(open) * 1_000);
  if (!Number.isFinite(current.getTime()) || current.getUTCDate() !== 1) return null;
  const next = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth() + months,
    1,
    current.getUTCHours(),
    current.getUTCMinutes(),
    current.getUTCSeconds(),
  ) / 1_000;
  return toEpochSeconds(next);
}

function isExcludedOpen(open: EpochSeconds, exclusions: readonly TimeRangeSec[]): boolean {
  return exclusions.some((range) => open >= range.start && open <= range.end);
}

function monthlyGapCandidates(
  rows: readonly KlineBar[],
  months: number,
  exclusions: readonly TimeRangeSec[],
  maxGeneratedOpens: number,
): MonthlyGapCandidate[] {
  const candidates: MonthlyGapCandidate[] = [];
  let generated = 0;
  for (let index = 1; index < rows.length && generated < maxGeneratedOpens; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (!previous || !current || current.time <= previous.time) continue;
    let expected = addUtcMonths(previous.time, months);
    let openRun: EpochSeconds[] = [];
    while (expected != null && expected < current.time && generated < maxGeneratedOpens) {
      generated += 1;
      if (isExcludedOpen(expected, exclusions)) {
        if (openRun.length > 0) candidates.push({ opens: openRun });
        openRun = [];
      } else {
        openRun.push(expected);
      }
      const next = addUtcMonths(expected, months);
      if (next == null || next <= expected) break;
      expected = next;
    }
    if (openRun.length > 0) candidates.push({ opens: openRun });
  }
  return candidates;
}

function clampMonthlyCandidateToBudget(
  candidate: MonthlyGapCandidate,
  remainingBars: number,
  visibleRange: TimeRangeSec | null,
): GapRepairPlan | null {
  const allowedBars = Math.min(candidate.opens.length, remainingBars);
  if (allowedBars <= 0) return null;
  let startIndex = candidate.opens.length - allowedBars;
  if (visibleRange) {
    const targetIndex = candidate.opens.findIndex((open) => open >= visibleRange.start);
    startIndex = Math.max(
      0,
      Math.min(
        targetIndex < 0 ? candidate.opens.length - allowedBars : targetIndex,
        candidate.opens.length - allowedBars,
      ),
    );
  }
  const selected = candidate.opens.slice(startIndex, startIndex + allowedBars);
  const start = selected[0];
  const end = selected.at(-1);
  return start == null || end == null
    ? null
    : { start, end, missingBars: selected.length };
}

function subtractExcludedRanges(
  range: TimeRangeSec,
  exclusions: readonly TimeRangeSec[],
  intervalSeconds: number,
): TimeRangeSec[] {
  let segments = [range];
  for (const exclusion of exclusions) {
    const next: TimeRangeSec[] = [];
    for (const segment of segments) {
      if (exclusion.end < segment.start || exclusion.start > segment.end) {
        next.push(segment);
        continue;
      }
      const beforeEnd = exclusion.start - intervalSeconds;
      const afterStart = exclusion.end + intervalSeconds;
      const normalizedBeforeEnd = toEpochSeconds(beforeEnd);
      const normalizedAfterStart = toEpochSeconds(afterStart);
      if (normalizedBeforeEnd != null && normalizedBeforeEnd >= segment.start) {
        next.push({ start: segment.start, end: normalizedBeforeEnd });
      }
      if (normalizedAfterStart != null && normalizedAfterStart <= segment.end) {
        next.push({ start: normalizedAfterStart, end: segment.end });
      }
    }
    segments = next;
    if (segments.length === 0) break;
  }
  return segments;
}

function clampPlanToBudget(
  range: TimeRangeSec,
  intervalSeconds: number,
  remainingBars: number,
  visibleRange: TimeRangeSec | null,
): GapRepairPlan | null {
  const availableBars = Math.floor((range.end - range.start) / intervalSeconds) + 1;
  const allowedBars = Math.min(availableBars, remainingBars);
  if (allowedBars <= 0) return null;
  if (allowedBars === availableBars) {
    return { ...range, missingBars: availableBars };
  }

  let startValue = Number(range.start);
  if (visibleRange) {
    const latestStart = range.end - (allowedBars - 1) * intervalSeconds;
    const targetStart = Math.max(
      Number(range.start),
      Math.min(Number(visibleRange.start), Number(latestStart)),
    );
    const alignedOffset = Math.floor(
      (targetStart - Number(range.start)) / intervalSeconds,
    );
    startValue = Number(range.start) + alignedOffset * intervalSeconds;
  } else {
    startValue = range.end - (allowedBars - 1) * intervalSeconds;
  }
  const start = toEpochSeconds(startValue);
  const end = toEpochSeconds(startValue + (allowedBars - 1) * intervalSeconds);
  if (start == null || end == null) return null;
  return { start, end, missingBars: allowedBars };
}

/**
 * Plans a small number of exact interior repairs for the held/visible window.
 * This deliberately never infers a tail from wall-clock time: exchange calendar
 * semantics stay owned by the backend.
 */
export function planGapRepairs(
  rows: readonly KlineBar[] | null | undefined,
  intervalSeconds: number | null | undefined,
  {
    visibleRange: visibleRangeLike = null,
    excludedRanges = null,
    interval = null,
    nowMs = Date.now(),
    maxScanBars = DEFAULT_GAP_SCAN_BARS,
    bufferBars = DEFAULT_GAP_BUFFER_BARS,
    maxRepairs = DEFAULT_MAX_GAP_REPAIRS,
    maxRepairBars = DEFAULT_MAX_GAP_REPAIR_BARS,
  }: GapRepairPlanningOptions = {},
): GapRepairPlan[] {
  if (!rows || rows.length < 2 || !intervalSeconds || intervalSeconds <= 0) return [];
  const scanLimit = positiveInteger(maxScanBars, DEFAULT_GAP_SCAN_BARS);
  const repairLimit = positiveInteger(maxRepairs, DEFAULT_MAX_GAP_REPAIRS);
  const barBudget = positiveInteger(maxRepairBars, DEFAULT_MAX_GAP_REPAIR_BARS);
  const visibleRange = normalizeVisibleRange(visibleRangeLike);
  const scanRows = rowsForBoundedScan(
    rows,
    intervalSeconds,
    visibleRange,
    scanLimit,
    Math.max(0, Math.floor(Number(bufferBars) || 0)),
  );
  const exclusions = excludedSeconds(excludedRanges, nowMs);
  const monthCount = monthlyIntervalCount(interval);
  if (monthCount != null) {
    const candidates = monthlyGapCandidates(
      scanRows,
      monthCount,
      exclusions,
      Math.max(scanLimit, barBudget, repairLimit),
    );
    if (!visibleRange) {
      candidates.sort((left, right) => (
        Number(right.opens.at(-1) ?? 0) - Number(left.opens.at(-1) ?? 0)
      ));
    }
    const plans: GapRepairPlan[] = [];
    let remainingBars = barBudget;
    for (const candidate of candidates) {
      if (plans.length >= repairLimit || remainingBars <= 0) break;
      const plan = clampMonthlyCandidateToBudget(candidate, remainingBars, visibleRange);
      if (!plan) continue;
      plans.push(plan);
      remainingBars -= plan.missingBars;
    }
    return plans;
  }

  const gaps = detectGaps(scanRows, intervalSeconds);
  const candidates = gaps.flatMap((gap) => {
    const start = toEpochSeconds(gap.from + intervalSeconds);
    const end = toEpochSeconds(gap.to - intervalSeconds);
    if (start == null || end == null || end < start) return [];
    return subtractExcludedRanges({ start, end }, exclusions, intervalSeconds);
  });

  // With no explicit viewport, prefer the most recent holes in the held tail.
  if (!visibleRange) candidates.sort((left, right) => right.end - left.end);

  const plans: GapRepairPlan[] = [];
  let remainingBars = barBudget;
  for (const candidate of candidates) {
    if (plans.length >= repairLimit || remainingBars <= 0) break;
    const plan = clampPlanToBudget(candidate, intervalSeconds, remainingBars, visibleRange);
    if (!plan) continue;
    plans.push(plan);
    remainingBars -= plan.missingBars;
  }
  return plans;
}
