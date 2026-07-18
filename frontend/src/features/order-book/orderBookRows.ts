import type { OrderBookLevel } from "./orderBookTypes.js";

export interface DisplayOrderBookLevel {
  slot: number;
  price: number;
  quantity: number;
  cumulative: number;
}

export interface OrderBookRows {
  asks: readonly DisplayOrderBookLevel[];
  bids: readonly DisplayOrderBookLevel[];
  maxCumulative: number;
}

function cumulative(levels: readonly OrderBookLevel[]): DisplayOrderBookLevel[] {
  let total = 0;
  return levels.map(([price, quantity], slot) => {
    total += quantity;
    return { slot, price, quantity, cumulative: total };
  });
}

export function buildOrderBookRows(
  bids: readonly OrderBookLevel[],
  asks: readonly OrderBookLevel[],
): OrderBookRows {
  const bidRows = cumulative(bids);
  const askRows = cumulative(asks);
  const maxCumulative = Math.max(
    0,
    bidRows[bidRows.length - 1]?.cumulative ?? 0,
    askRows[askRows.length - 1]?.cumulative ?? 0,
  );
  return Object.freeze({
    asks: Object.freeze(askRows),
    bids: Object.freeze(bidRows),
    maxCumulative,
  });
}
