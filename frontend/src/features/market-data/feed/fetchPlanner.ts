import type {
  FetchPlan,
  KlineFetchResult,
} from "../klineContracts.js";
import type {
  KlineBar,
  KlineBarInput,
  MarketSeries,
  SeriesKey,
  TimeRangeSec,
} from "../marketDataTypes.js";
import {
  asSeriesKey,
  toEpochSeconds,
} from "../marketDataTypes.js";
import { canonicalizeIntervalValue } from "../../../utils/intervals.js";

interface RangeInput {
  start?: unknown;
  end?: unknown;
  startSec?: unknown;
  endSec?: unknown;
}

interface FetchPlanInput {
  from?: unknown;
  to?: unknown;
  countBack?: unknown;
  days?: unknown;
  intervalSeconds?: unknown;
  fallbackDays?: number | null;
}

export function seriesKeyFor({
  exchange = "binance",
  marketType = "spot",
  symbol = "BTCUSDT",
  interval = "1h",
}: Partial<MarketSeries> = {}): SeriesKey {
  return asSeriesKey([
    String(exchange || "").toLowerCase(),
    String(marketType || "").toLowerCase(),
    String(symbol || "").toUpperCase(),
    canonicalizeIntervalValue(interval) || String(interval || ""),
  ].join(":"));
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRangeSec({
  start,
  end,
  startSec,
  endSec,
}: RangeInput = {}): TimeRangeSec | null {
  const startValue = finiteNumber(startSec ?? start);
  const endValue = finiteNumber(endSec ?? end);
  const normalizedStart = startValue == null ? null : toEpochSeconds(startValue);
  const normalizedEnd = endValue == null ? null : toEpochSeconds(endValue);
  if (normalizedStart == null || normalizedEnd == null || normalizedEnd < normalizedStart) {
    return null;
  }
  return { start: normalizedStart, end: normalizedEnd };
}

export function normalizeCountBack(countBack: unknown): number | null {
  const parsed = finiteNumber(countBack);
  if (parsed == null || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

export function countBackToDays(
  countBack: unknown,
  intervalSeconds: unknown,
  fallbackDays: number | null = 7,
): number | null {
  const normalizedCountBack = normalizeCountBack(countBack);
  const normalizedIntervalSeconds = finiteNumber(intervalSeconds);
  if (!normalizedCountBack || !normalizedIntervalSeconds || normalizedIntervalSeconds <= 0) {
    return fallbackDays;
  }
  return Math.max(0.001, (normalizedCountBack * normalizedIntervalSeconds) / 86_400);
}

export function planBarsFetch({
  from,
  to,
  countBack,
  days,
  intervalSeconds,
  fallbackDays = 7,
}: FetchPlanInput = {}): FetchPlan {
  const range = normalizeRangeSec({ start: from, end: to });
  if (range) {
    return { type: "range", range };
  }

  const toValue = finiteNumber(to);
  const normalizedTo = toValue == null ? null : toEpochSeconds(toValue);
  const normalizedCountBack = normalizeCountBack(countBack);
  if (normalizedTo != null && normalizedCountBack) {
    return {
      type: "before",
      before: normalizedTo,
      bars: normalizedCountBack,
    };
  }

  const plannedDays = finiteNumber(days)
    ?? countBackToDays(normalizedCountBack, intervalSeconds, fallbackDays);
  return {
    type: "history",
    days: plannedDays,
    countBack: normalizedCountBack,
  };
}

export function requestKeyFor(
  type: string,
  series: Partial<MarketSeries>,
  params: Record<string, unknown> = {},
): string {
  const keyParts = [type, seriesKeyFor(series)];
  const sortedEntries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of sortedEntries) {
    keyParts.push(`${key}=${String(value)}`);
  }
  return keyParts.join("|");
}

export function rowsFromResult(
  result: KlineFetchResult | null | undefined,
): KlineBar[] {
  return Array.isArray(result?.data) ? result.data : [];
}

export function rowRange(
  rows: readonly KlineBarInput[] | null | undefined,
): TimeRangeSec | null {
  if (!rows?.length) return null;
  const times = rows
    .map((row) => finiteNumber(row?.time))
    .filter((time) => time != null);
  if (!times.length) return null;
  const start = toEpochSeconds(Math.min(...times));
  const end = toEpochSeconds(Math.max(...times));
  return start == null || end == null ? null : { start, end };
}
