export interface ReplayMaxQuantityRebaseInput {
  readonly previousMaxQuantity: number | null;
  readonly previousReferencePrice: number | null;
  readonly nextReferencePrice: number | null;
  readonly previousAvailableEquity: number | null;
  readonly nextAvailableEquity: number | null;
  readonly previousLeverage: number;
  readonly nextLeverage: number;
  readonly reduceOnly: boolean;
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/**
 * Conservatively carry a server-authoritative quantity cap across a market
 * cursor change. The estimate may shrink immediately, but never grows until a
 * fresh server preview confirms the larger capacity.
 */
export function rebaseReplayMaxQuantity({
  previousMaxQuantity,
  previousReferencePrice,
  nextReferencePrice,
  previousAvailableEquity,
  nextAvailableEquity,
  previousLeverage,
  nextLeverage,
  reduceOnly,
}: ReplayMaxQuantityRebaseInput): number | null {
  if (!positiveFinite(previousMaxQuantity)) return null;
  if (reduceOnly) return previousMaxQuantity;

  let rebased = previousMaxQuantity;
  if (positiveFinite(previousReferencePrice) && positiveFinite(nextReferencePrice)) {
    rebased *= previousReferencePrice / nextReferencePrice;
  }
  if (positiveFinite(previousAvailableEquity) && positiveFinite(nextAvailableEquity)) {
    rebased *= nextAvailableEquity / previousAvailableEquity;
  }
  if (
    Number.isFinite(previousLeverage)
    && previousLeverage > 0
    && Number.isFinite(nextLeverage)
    && nextLeverage > 0
  ) {
    rebased *= nextLeverage / previousLeverage;
  }
  if (!Number.isFinite(rebased) || rebased <= 0) return null;

  return Math.min(previousMaxQuantity, rebased);
}
