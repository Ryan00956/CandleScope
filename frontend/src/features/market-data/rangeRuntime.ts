import type { RangeEventDetail } from "./klineContracts.js";
import type {
  KlineBarInput,
  MarketSeries,
  TimeRangeMs,
} from "./marketDataTypes.js";
import {
  secondsToMilliseconds,
  toEpochMilliseconds,
  toEpochSeconds,
} from "./marketDataTypes.js";
import { intervalsSemanticallyEquivalent } from "../../utils/intervals.js";
import { klineSeriesIdentityKey } from "./klineSeriesIdentity.js";

export function numericRange(start: unknown, end: unknown): TimeRangeMs | null {
  const startValue = toEpochMilliseconds(start);
  const endValue = toEpochMilliseconds(end);
  if (startValue == null || endValue == null || endValue < startValue) return null;
  return { start: startValue, end: endValue };
}

export function eventRangeFromDetail(
  detail: RangeEventDetail | null | undefined = {},
): TimeRangeMs | null {
  const source = detail || {};
  return numericRange(
    source.request_start_ms ?? source.range_start_ms,
    source.request_end_ms ?? source.range_end_ms,
  );
}

export function rowRangeMs(
  rows: readonly KlineBarInput[] | null | undefined,
): TimeRangeMs | null {
  if (!rows?.length) return null;
  const times = rows
    .map((row) => toEpochSeconds(row?.time))
    .filter((value) => value != null);
  if (!times.length) return null;
  return {
    start: secondsToMilliseconds(Math.min(...times) as (typeof times)[number]),
    end: secondsToMilliseconds(Math.max(...times) as (typeof times)[number]),
  };
}

export function rangesOverlap(
  a: TimeRangeMs | null | undefined,
  b: TimeRangeMs | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.start <= b.end && b.start <= a.end;
}

export function rangeCovers(
  container: TimeRangeMs | null | undefined,
  target: TimeRangeMs | null | undefined,
  toleranceMs = 0,
): boolean {
  if (!container || !target) return false;
  return (
    container.start <= target.start + toleranceMs
    && container.end >= target.end - toleranceMs
  );
}

export function isSameSeries(
  a: Partial<MarketSeries> | null | undefined,
  b: Partial<MarketSeries> | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    String(a.exchange || "").toLowerCase() === String(b.exchange || "").toLowerCase()
    && String(a.marketType || "").toLowerCase() === String(b.marketType || "").toLowerCase()
    && String(a.symbol || "").toUpperCase() === String(b.symbol || "").toUpperCase()
    && klineSeriesIdentityKey(a.exchange, a) === klineSeriesIdentityKey(b.exchange, b)
    && intervalsSemanticallyEquivalent(a.interval, b.interval)
  );
}
