import type {
  OrderBookBook,
  OrderBookLevel,
  OrderBookMode,
  PriceGrouping,
} from "./orderBookTypes.js";

export interface OrderBookPresentation {
  bids: readonly OrderBookLevel[];
  asks: readonly OrderBookLevel[];
  priceStep: number | null;
  aggregationApplied: boolean;
}

export function resolvePriceStep(
  priceTickSize: number | null,
  referencePrice: number | null,
  grouping: PriceGrouping,
  maxAutoMultiplier = 1_000,
): number | null {
  if (!priceTickSize || !Number.isFinite(priceTickSize) || priceTickSize <= 0) return null;
  if (grouping === "raw") return priceTickSize;
  if (grouping !== "auto") return priceTickSize * Number(grouping);
  if (!referencePrice || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return priceTickSize;
  }
  const target = referencePrice * 0.00001;
  let multiplier = 1;
  while (multiplier < maxAutoMultiplier && priceTickSize * multiplier < target) {
    multiplier *= 10;
  }
  return priceTickSize * Math.min(multiplier, maxAutoMultiplier);
}

export function aggregateOrderBookLevels(
  levels: readonly OrderBookLevel[],
  side: "bids" | "asks",
  priceStep: number,
): readonly OrderBookLevel[] {
  if (!Number.isFinite(priceStep) || priceStep <= 0 || levels.length === 0) return levels;
  const scale = decimalScale(priceStep, levels);
  const stepUnits = Math.round(priceStep * scale);
  if (!Number.isSafeInteger(stepUnits) || stepUnits <= 0) return levels;

  const buckets = new Map<number, number>();
  for (const [price, quantity] of levels) {
    const priceUnits = Math.round(price * scale);
    if (!Number.isSafeInteger(priceUnits)) return levels;
    const bucketUnits = (side === "bids" ? Math.floor : Math.ceil)(priceUnits / stepUnits)
      * stepUnits;
    buckets.set(bucketUnits, (buckets.get(bucketUnits) ?? 0) + quantity);
  }
  return Object.freeze([...buckets.entries()]
    .sort(([left], [right]) => side === "bids" ? right - left : left - right)
    .map(([priceUnits, quantity]) => (
      Object.freeze([priceUnits / scale, quantity] as const)
    )));
}

export function omitIncompleteOuterBucket(
  levels: readonly OrderBookLevel[],
): readonly OrderBookLevel[] {
  if (levels.length <= 1) return levels;
  return Object.freeze(levels.slice(0, -1));
}

export function orderBookPresentation(
  book: OrderBookBook,
  grouping: PriceGrouping,
): OrderBookPresentation {
  if (book.mode === "full") {
    return {
      bids: book.bids,
      asks: book.asks,
      priceStep: book.priceStep,
      aggregationApplied: book.aggregationApplied,
    };
  }
  const priceStep = resolvePriceStep(
    book.priceTickSize,
    book.midPrice,
    grouping,
    10,
  );
  const aggregationApplied = (
    priceStep !== null
    && book.priceTickSize !== null
    && priceStep > book.priceTickSize * (1 + Number.EPSILON)
  );
  const groupedBids = aggregationApplied
    ? aggregateOrderBookLevels(book.bids, "bids", priceStep)
    : book.bids;
  const groupedAsks = aggregationApplied
    ? aggregateOrderBookLevels(book.asks, "asks", priceStep)
    : book.asks;
  return {
    bids: aggregationApplied
      ? omitIncompleteOuterBucket(groupedBids)
      : groupedBids,
    asks: aggregationApplied
      ? omitIncompleteOuterBucket(groupedAsks)
      : groupedAsks,
    priceStep,
    aggregationApplied,
  };
}

export function groupingPriceStep(
  book: OrderBookBook | null,
  mode: OrderBookMode,
  grouping: PriceGrouping,
): number | null {
  if (!book) return null;
  if (mode === "full" && grouping === book.priceGrouping) return book.priceStep;
  return resolvePriceStep(
    book.priceTickSize,
    book.midPrice,
    grouping,
    mode === "partial" ? 10 : 1_000,
  );
}

function decimalScale(value: number, levels: readonly OrderBookLevel[]): number {
  const decimals = Math.max(
    decimalPlaces(value),
    ...levels.map(([price]) => decimalPlaces(price)),
  );
  return 10 ** Math.min(10, decimals);
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const [coefficient = text, exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  return Math.max(0, fractionLength - exponent);
}
