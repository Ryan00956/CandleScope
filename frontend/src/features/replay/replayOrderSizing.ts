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

export interface ReplayOrderSizingAvailability {
  readonly sliderDisabled: boolean;
  readonly quantityExceedsCapacity: boolean;
}

export function replayReduceOnlyUnavailableMessage({
  reduceOnly,
  positionQuantity,
  positionMode,
  targetPositionSide,
}: {
  readonly reduceOnly: boolean;
  readonly positionQuantity: number;
  readonly positionMode: "ONE_WAY" | "HEDGE";
  readonly targetPositionSide: "LONG" | "SHORT";
}): string | null {
  if (!reduceOnly || positionQuantity !== 0) return null;
  if (positionMode !== "HEDGE") return "无持仓可平";
  return targetPositionSide === "LONG" ? "无多仓可平" : "无空仓可平";
}

/**
 * Derive draft validity only from the independent capacity channel. Preview
 * failures intentionally are not an input, so they cannot disable the slider.
 */
export function replayOrderSizingAvailability(
  maxQuantity: string | null,
  draftQuantity: string,
): ReplayOrderSizingAvailability {
  const maximum = maxQuantity === null ? Number.NaN : Number(maxQuantity);
  const quantity = Number(draftQuantity);
  const validMaximum = Number.isFinite(maximum) && maximum > 0;
  return {
    sliderDisabled: !validMaximum,
    quantityExceedsCapacity: validMaximum
      && Number.isFinite(quantity)
      && quantity > maximum,
  };
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function replayOrderPreviewSide(
  positionQuantity: number,
  selectedSide: "BUY" | "SELL",
): "BUY" | "SELL" {
  if (positionQuantity > 0) return "BUY";
  if (positionQuantity < 0) return "SELL";
  return selectedSide;
}

export function replayOrderContextSide(
  positionQuantity: number,
  selectedSide: "BUY" | "SELL",
  reduceOnly: boolean,
): "BUY" | "SELL" {
  if (!reduceOnly) return replayOrderPreviewSide(positionQuantity, selectedSide);
  if (positionQuantity > 0) return "SELL";
  if (positionQuantity < 0) return "BUY";
  return selectedSide;
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
