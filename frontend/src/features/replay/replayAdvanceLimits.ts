import type { ReplayV2AdvanceBasis } from "./replayV2Types.js";

export const SOURCE_EVENT_MAX_MANUAL_COUNT = 128;

export function boundedReplayAdvanceAmount(
  amount: number,
  basis: ReplayV2AdvanceBasis,
  globalMaximum: number,
): number {
  const maximum = basis === "SOURCE_EVENT"
    ? Math.min(globalMaximum, SOURCE_EVENT_MAX_MANUAL_COUNT)
    : globalMaximum;
  return Math.min(maximum, Math.max(1, Math.trunc(amount)));
}
