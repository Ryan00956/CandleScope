import { inferPriceMinimumTick } from "./priceTick.js";

const DEFAULT_NUMBER_OF_LINES = 3;
const MAX_NUMBER_OF_LINES = 50;

export function normalizeLineBreakNumberOfLines(value) {
  const numberOfLines = Math.trunc(Number(value));
  return Number.isFinite(numberOfLines)
    && numberOfLines >= 1
    && numberOfLines <= MAX_NUMBER_OF_LINES
    ? numberOfLines
    : DEFAULT_NUMBER_OF_LINES;
}

export function resolveLineBreakProjectorOptions(rows = [], {
  numberOfLines = DEFAULT_NUMBER_OF_LINES,
} = {}) {
  const resolvedNumberOfLines = normalizeLineBreakNumberOfLines(numberOfLines);
  const minTick = inferPriceMinimumTick(rows, { fields: ["close"] });
  return Object.freeze({
    numberOfLines: resolvedNumberOfLines,
    minTick,
    configKey: `line-break:${resolvedNumberOfLines}:${minTick}`,
  });
}
