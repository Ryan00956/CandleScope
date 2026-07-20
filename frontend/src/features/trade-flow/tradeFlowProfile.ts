import type { AggregateTrade } from "./tradeFlowTypes.js";

export interface TradeFlowProfileRow {
  key: string;
  price: number;
  buyQuote: number;
  sellQuote: number;
  deltaQuote: number;
  buyCount: number;
  sellCount: number;
  totalQuote: number;
}

export interface TradeFlowProfile {
  rows: readonly TradeFlowProfileRow[];
  priceStep: number;
  maxQuote: number;
  trades: number;
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

function aggregate(records: readonly AggregateTrade[], step: number): TradeFlowProfileRow[] {
  const bins = new Map<number, Omit<TradeFlowProfileRow, "key" | "price" | "deltaQuote" | "totalQuote">>();
  for (const trade of records) {
    const bucket = Math.floor(trade.price / step);
    const current = bins.get(bucket) || { buyQuote: 0, sellQuote: 0, buyCount: 0, sellCount: 0 };
    if (trade.aggressorSide === "buy") {
      current.buyQuote += trade.quoteQuantity;
      current.buyCount += 1;
    } else {
      current.sellQuote += trade.quoteQuantity;
      current.sellCount += 1;
    }
    bins.set(bucket, current);
  }
  return [...bins.entries()].map(([bucket, values]) => ({
    key: `${bucket}:${step}`,
    price: (bucket + 0.5) * step,
    ...values,
    deltaQuote: values.buyQuote - values.sellQuote,
    totalQuote: values.buyQuote + values.sellQuote,
  })).sort((left, right) => right.price - left.price);
}

export function buildTradeFlowProfile(
  records: readonly AggregateTrade[],
  maxRows = 28,
): TradeFlowProfile {
  if (!records.length) return { rows: Object.freeze([]), priceStep: 0, maxQuote: 0, trades: 0 };
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const trade of records) {
    low = Math.min(low, trade.price);
    high = Math.max(high, trade.price);
  }
  const targetRows = Math.max(4, Math.floor(maxRows));
  let step = niceStep((high - low) / Math.max(1, targetRows - 1));
  if (high === low) step = niceStep(Math.max(high * 0.0001, Number.EPSILON));
  let rows = aggregate(records, step);
  while (rows.length > targetRows) {
    step = niceStep(step * 1.5);
    rows = aggregate(records, step);
  }
  return {
    rows,
    priceStep: step,
    maxQuote: rows.reduce((maximum, row) => Math.max(maximum, row.totalQuote), 0),
    trades: records.length,
  };
}
