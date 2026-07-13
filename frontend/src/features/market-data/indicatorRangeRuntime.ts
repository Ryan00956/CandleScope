import type {
  IndicatorRangeRequest,
  IndicatorWindowMeta,
} from "./klineContracts.js";
import type { EpochSeconds } from "./marketDataTypes.js";
import { toEpochSeconds } from "./marketDataTypes.js";

export type IndicatorRangeRequester = (start: EpochSeconds, end: EpochSeconds) => void;

export function requestIndicatorRangeInChunks(
  requestRange: IndicatorRangeRequester | null | undefined,
  start: unknown,
  end: unknown,
): void {
  if (typeof requestRange !== "function") return;
  const startSec = toEpochSeconds(Math.floor(Number(start)));
  const endSec = toEpochSeconds(Math.floor(Number(end)));
  if (startSec == null || endSec == null || startSec <= 0 || endSec <= 0 || startSec > endSec) {
    return;
  }
  requestRange(startSec, endSec);
}

export function resolveIndicatorRangeFromWindowMeta(
  meta: IndicatorWindowMeta | null | undefined = {},
): IndicatorRangeRequest | null {
  const source = meta || {};
  const type = source.windowDeltaType;
  if (type !== "prepend" && type !== "mid-merge") return null;
  const start = toEpochSeconds(Math.floor(Number(source.incomingFirstTime)));
  const end = toEpochSeconds(Math.floor(Number(source.incomingLastTime)));
  if (start == null || end == null || start <= 0 || end <= 0 || start > end) {
    return null;
  }
  return { start, end, reason: `window-${type}` };
}

export function requestIndicatorRangeForWindowMeta(
  requestRange: IndicatorRangeRequester | null | undefined,
  meta: IndicatorWindowMeta | null | undefined = {},
): boolean {
  const range = resolveIndicatorRangeFromWindowMeta(meta);
  if (!range) return false;
  requestIndicatorRangeInChunks(requestRange, range.start, range.end);
  return true;
}
