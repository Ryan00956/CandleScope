import { resolveRenkoProjectorOptions } from "./renkoProjectionOptions.js";

/**
 * Kagi V1 resolves ATR to one fixed reversal distance when the projection is
 * created. The projector then operates only on deterministic integer ticks.
 */
export function resolveKagiProjectorOptions(rows = [], {
  atrLength = 14,
  mode = "atr",
  reversalAmount = 1,
} = {}) {
  const base = resolveRenkoProjectorOptions(rows, {
    atrLength,
    boxSize: reversalAmount,
    mode,
  });
  const reversalTicks = Math.max(1, Math.round(base.boxSize / base.minTick));
  return Object.freeze({
    atrLength: base.atrLength,
    minTick: base.minTick,
    mode: base.mode,
    reversalAmount: base.boxSize,
    reversalTicks,
    configKey: [
      "kagi",
      base.mode,
      base.atrLength,
      base.boxSize,
      base.minTick,
    ].join(":"),
  });
}
