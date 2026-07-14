import type { SourceBar } from "./chartRepresentationTypes.js";

export const MAX_PRICE_DECIMALS = 8;

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function decimalPlaces(value: unknown): number {
  const number = positiveNumber(value);
  if (number == null) return 0;
  const [coefficient = "", exponentText] = String(number).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length || 0;
  const exponent = Number(exponentText || 0);
  return Math.min(MAX_PRICE_DECIMALS, Math.max(0, fractionLength - exponent));
}

export function inferPriceMinimumTick(rows: readonly SourceBar[] = [], {
  fields = ["open", "high", "low", "close"],
  preferredValues = [],
}: {
  fields?: readonly string[];
  preferredValues?: readonly unknown[];
} = {}): number {
  let precision = 0;
  for (const value of preferredValues || []) {
    precision = Math.max(precision, decimalPlaces(value));
  }
  for (const row of rows || []) {
    for (const field of fields || []) {
      precision = Math.max(precision, decimalPlaces(row?.[field]));
    }
  }
  return 10 ** -Math.min(MAX_PRICE_DECIMALS, precision);
}
