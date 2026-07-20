import {
  clampHistoryRangeToNow,
  type MarketHistoryRange,
} from "../advanced-market-data/marketHistoryCoverage.js";
import type { LiquidationPositionSide } from "./liquidationTypes.js";

const MINUTE_MS = 60_000;

export interface LiquidationHistoryRequestClaim {
  readonly id: number;
  readonly side: LiquidationPositionSide;
  readonly range: MarketHistoryRange;
}

function normalizedRange(range: MarketHistoryRange): MarketHistoryRange {
  const startMs = Math.max(0, Math.floor(Math.min(range.startMs, range.endMs)));
  const endMs = Math.max(startMs, Math.ceil(Math.max(range.startMs, range.endMs)));
  return { startMs, endMs };
}

/**
 * Convert an inclusive visible range to minute-bucket request bounds without
 * ever manufacturing future coverage. A future-only viewport is deliberately
 * unrequestable; a range crossing `now` keeps the current partial minute but
 * never rounds its end beyond the current clock boundary.
 */
export function normalizeLiquidationHistoryRange(
  range: MarketHistoryRange,
  nowMs: number = Date.now(),
): MarketHistoryRange | null {
  const upperBound = Math.max(0, Math.floor(nowMs));
  const clamped = clampHistoryRangeToNow(range, upperBound);
  if (!clamped) return null;
  const startMs = Math.max(0, Math.floor(clamped.startMs / MINUTE_MS) * MINUTE_MS);
  const roundedEndMs = Math.max(
    0,
    Math.ceil((clamped.endMs + 1) / MINUTE_MS) * MINUTE_MS - 1,
  );
  return {
    startMs,
    endMs: Math.min(roundedEndMs, upperBound),
  };
}

/**
 * Return every inclusive gap in `requested` after subtracting durable and
 * currently-loading coverage. Returning all gaps matters when an in-flight
 * request sits in the middle of a newly requested viewport.
 */
export function subtractLiquidationHistoryCoverage(
  requested: MarketHistoryRange,
  coverage: readonly MarketHistoryRange[],
): MarketHistoryRange[] {
  const target = normalizedRange(requested);
  const occupied = coverage
    .map(normalizedRange)
    .filter((range) => range.endMs >= target.startMs && range.startMs <= target.endMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const gaps: MarketHistoryRange[] = [];
  let cursor = target.startMs;
  for (const range of occupied) {
    if (range.endMs < cursor) continue;
    if (range.startMs > cursor) {
      gaps.push({
        startMs: cursor,
        endMs: Math.min(target.endMs, range.startMs - 1),
      });
    }
    cursor = Math.max(cursor, range.endMs + 1);
    if (cursor > target.endMs) return gaps;
  }
  if (cursor <= target.endMs) gaps.push({ startMs: cursor, endMs: target.endMs });
  return gaps;
}

/**
 * Owns interval claims synchronously, before fetch promises are started. This
 * prevents two viewport notifications in the same frame from launching
 * overlapping REST history requests while still allowing disjoint gaps to be
 * fetched in parallel.
 */
export class LiquidationHistoryRequestCoordinator {
  private nextId = 1;
  private readonly claims = new Map<number, LiquidationHistoryRequestClaim>();

  claim(
    side: LiquidationPositionSide,
    requested: MarketHistoryRange,
    durableCoverage: readonly MarketHistoryRange[],
  ): LiquidationHistoryRequestClaim[] {
    const inFlightCoverage = [...this.claims.values()]
      .filter((claim) => claim.side === side)
      .map((claim) => claim.range);
    const gaps = subtractLiquidationHistoryCoverage(
      requested,
      [...durableCoverage, ...inFlightCoverage],
    );
    return gaps.map((range) => {
      const claim: LiquidationHistoryRequestClaim = {
        id: this.nextId,
        side,
        range,
      };
      this.nextId += 1;
      this.claims.set(claim.id, claim);
      return claim;
    });
  }

  release(claim: LiquidationHistoryRequestClaim): void {
    this.claims.delete(claim.id);
  }

  clear(): void {
    this.claims.clear();
  }

  inFlight(side: LiquidationPositionSide): MarketHistoryRange[] {
    return [...this.claims.values()]
      .filter((claim) => claim.side === side)
      .map((claim) => ({ ...claim.range }))
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  }
}
