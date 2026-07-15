import type { MarketHistoryPayload } from "./advancedMarketDataTypes.js";

export interface MarketHistoryRange {
  startMs: number;
  endMs: number;
}

export type MarketHistoryPageDirection = "forward" | "backward";

function normalizedRange(range: MarketHistoryRange): MarketHistoryRange {
  const startMs = Math.max(0, Math.floor(Math.min(range.startMs, range.endMs)));
  const endMs = Math.max(startMs, Math.ceil(Math.max(range.startMs, range.endMs)));
  return { startMs, endMs };
}

export function clampHistoryRangeToNow(
  requested: MarketHistoryRange,
  nowMs: number = Date.now(),
): MarketHistoryRange | null {
  const target = normalizedRange(requested);
  const upperBound = Math.max(0, Math.floor(nowMs));
  if (target.startMs > upperBound) return null;
  return {
    startMs: target.startMs,
    endMs: Math.min(target.endMs, upperBound),
  };
}

export function mergeHistoryCoverage(
  current: readonly MarketHistoryRange[],
  incoming: MarketHistoryRange,
): MarketHistoryRange[] {
  const ranges = [...current.map(normalizedRange), normalizedRange(incoming)]
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: MarketHistoryRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.startMs > previous.endMs + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.endMs = Math.max(previous.endMs, range.endMs);
  }
  return merged;
}

export function nextUncoveredHistoryRange(
  coverage: readonly MarketHistoryRange[],
  requested: MarketHistoryRange,
): MarketHistoryRange | null {
  const target = normalizedRange(requested);
  let cursor = target.startMs;
  for (const range of coverage.map(normalizedRange).sort((a, b) => a.startMs - b.startMs)) {
    if (range.endMs < cursor) continue;
    if (range.startMs > target.endMs) break;
    if (range.startMs > cursor) {
      return {
        startMs: cursor,
        endMs: Math.min(target.endMs, range.startMs - 1),
      };
    }
    cursor = Math.max(cursor, range.endMs + 1);
    if (cursor > target.endMs) return null;
  }
  return cursor <= target.endMs ? { startMs: cursor, endMs: target.endMs } : null;
}

export function coverageForHistoryPage(
  requested: MarketHistoryRange,
  payload: Pick<
    MarketHistoryPayload,
    "count" | "coverage" | "fallback" | "has_more" | "history_state" | "complete" | "retryable"
  >,
  direction: MarketHistoryPageDirection,
): MarketHistoryRange | null {
  const target = normalizedRange(requested);
  const explicitlyResolved = payload.complete === true
    || payload.history_state === "exhausted"
    || (payload.count === 0 && payload.retryable === false);
  if (payload.fallback === true && !explicitlyResolved) return null;
  const earliestMs = payload.coverage.earliest_ms;
  const latestMs = payload.coverage.latest_ms;
  const pageIsExhaustive = payload.coverage.complete
    || payload.has_more === false
    || explicitlyResolved;
  if (pageIsExhaustive) return target;
  if (earliestMs === null || latestMs === null || payload.count === 0) return null;

  if (direction === "forward") {
    // Binance Funding returns the oldest page after startTime. Continue from
    // the page's latest sample toward the requested right edge.
    const coveredEnd = Math.max(target.startMs, Math.min(target.endMs, latestMs));
    return { startMs: target.startMs, endMs: coveredEnd };
  }

  // Binance OI history returns the newest page. Continue backward from the
  // page's earliest sample toward the requested left edge.
  const coveredStart = Math.max(target.startMs, Math.min(target.endMs, earliestMs));
  return { startMs: coveredStart, endMs: target.endMs };
}
