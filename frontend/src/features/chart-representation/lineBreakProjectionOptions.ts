import { inferPriceMinimumTick } from "./priceTick.js";
import type {
  LineBreakProjectionOptions,
  ResolvedLineBreakProjectionOptions,
  SourceBar,
} from "./chartRepresentationTypes.js";

const DEFAULT_NUMBER_OF_LINES = 3;
const MAX_NUMBER_OF_LINES = 50;

export function normalizeLineBreakNumberOfLines(value: unknown): number {
  const numberOfLines = Math.trunc(Number(value));
  return Number.isFinite(numberOfLines)
    && numberOfLines >= 1
    && numberOfLines <= MAX_NUMBER_OF_LINES
    ? numberOfLines
    : DEFAULT_NUMBER_OF_LINES;
}

export function resolveLineBreakProjectorOptions(rows: readonly SourceBar[] = [], {
  numberOfLines = DEFAULT_NUMBER_OF_LINES,
}: LineBreakProjectionOptions = {}): Readonly<ResolvedLineBreakProjectionOptions> {
  const resolvedNumberOfLines = normalizeLineBreakNumberOfLines(numberOfLines);
  const minTick = inferPriceMinimumTick(rows, { fields: ["close"] });
  return Object.freeze({
    numberOfLines: resolvedNumberOfLines,
    minTick,
    configKey: `line-break:${resolvedNumberOfLines}:${minTick}`,
  } satisfies ResolvedLineBreakProjectionOptions);
}
