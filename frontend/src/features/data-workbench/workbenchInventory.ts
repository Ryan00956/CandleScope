import { parseIntervalSeconds } from "../../utils/intervals.js";
import type {
  StorageGapSample,
  StorageInventorySeries,
} from "../../services/storageInventoryApi.js";

export interface InstrumentSeriesGroup {
  key: string;
  exchange: string;
  marketType: string;
  symbol: string;
  series: StorageInventorySeries[];
  totalCount: number;
  earliestOpenMs: number | null;
  latestOpenMs: number | null;
}

export interface InstrumentGapGroup {
  key: string;
  exchange: string;
  marketType: string;
  symbol: string;
  gaps: StorageGapSample[];
  missingBars: number;
}

export function instrumentGroupKey(exchange: string, marketType: string, symbol: string): string {
  return `${exchange.trim().toLowerCase()}:${marketType.trim().toLowerCase()}:${symbol.trim().toUpperCase()}`;
}

export function compareIntervals(left: string, right: string): number {
  const leftSeconds = parseIntervalSeconds(left);
  const rightSeconds = parseIntervalSeconds(right);
  if (leftSeconds != null && rightSeconds != null && leftSeconds !== rightSeconds) {
    return leftSeconds - rightSeconds;
  }
  if (leftSeconds != null && rightSeconds == null) return -1;
  if (leftSeconds == null && rightSeconds != null) return 1;
  return left.localeCompare(right, undefined, { numeric: true });
}

function minTimestamp(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function compareGroups<T extends { symbol: string; exchange: string; marketType: string }>(
  left: T,
  right: T,
): number {
  return left.symbol.localeCompare(right.symbol)
    || left.exchange.localeCompare(right.exchange)
    || left.marketType.localeCompare(right.marketType);
}

export function groupSeriesByInstrument(
  series: readonly StorageInventorySeries[],
): InstrumentSeriesGroup[] {
  const groups = new Map<string, InstrumentSeriesGroup>();
  for (const item of series) {
    const key = instrumentGroupKey(item.exchange, item.marketType, item.symbol);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        exchange: item.exchange,
        marketType: item.marketType,
        symbol: item.symbol,
        series: [item],
        totalCount: item.totalCount,
        earliestOpenMs: item.earliestOpenMs,
        latestOpenMs: item.latestOpenMs,
      });
      continue;
    }
    existing.series.push(item);
    existing.totalCount += item.totalCount;
    existing.earliestOpenMs = minTimestamp(existing.earliestOpenMs, item.earliestOpenMs);
    existing.latestOpenMs = maxTimestamp(existing.latestOpenMs, item.latestOpenMs);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.series.sort((left, right) => compareIntervals(left.interval, right.interval));
  }
  result.sort(compareGroups);
  return result;
}

export function groupGapsByInstrument(gaps: readonly StorageGapSample[]): InstrumentGapGroup[] {
  const groups = new Map<string, InstrumentGapGroup>();
  for (const item of gaps) {
    const key = instrumentGroupKey(item.exchange, item.marketType, item.symbol);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        exchange: item.exchange,
        marketType: item.marketType,
        symbol: item.symbol,
        gaps: [item],
        missingBars: item.missingBars,
      });
      continue;
    }
    existing.gaps.push(item);
    existing.missingBars += item.missingBars;
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.gaps.sort((left, right) => compareIntervals(left.interval, right.interval));
  }
  result.sort(compareGroups);
  return result;
}
