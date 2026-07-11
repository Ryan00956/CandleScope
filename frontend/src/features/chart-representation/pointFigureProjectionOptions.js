import { resolveRenkoProjectorOptions } from "./renkoProjectionOptions.js";

const DEFAULT_REVERSAL_AMOUNT = 3;
const MAX_REVERSAL_AMOUNT = 100;

function normalizeReversalAmount(value) {
  const amount = Math.trunc(Number(value));
  return Number.isFinite(amount) && amount >= 1 && amount <= MAX_REVERSAL_AMOUNT
    ? amount
    : DEFAULT_REVERSAL_AMOUNT;
}

/**
 * Point & Figure V1 shares the same fixed-box resolver as Renko. ATR is used
 * only to choose a stable box size when the projection is created; the
 * projector itself always receives deterministic integer-tick parameters.
 */
export function resolvePointFigureProjectorOptions(rows = [], {
  atrLength = 14,
  boxSize = 1,
  mode = "atr",
  reversalAmount = DEFAULT_REVERSAL_AMOUNT,
} = {}) {
  const base = resolveRenkoProjectorOptions(rows, { atrLength, boxSize, mode });
  const resolvedReversalAmount = normalizeReversalAmount(reversalAmount);
  return Object.freeze({
    atrLength: base.atrLength,
    boxSize: base.boxSize,
    minTick: base.minTick,
    mode: base.mode,
    reversalAmount: resolvedReversalAmount,
    configKey: [
      "point-and-figure",
      base.mode,
      base.atrLength,
      base.boxSize,
      base.minTick,
      resolvedReversalAmount,
    ].join(":"),
  });
}
