import type {
  IndicatorRangeEvent,
  IndicatorRangeRequest,
  IndicatorWindowMeta,
  WindowChangedRange,
} from "./klineContracts.js";
import type { EpochSeconds } from "./marketDataTypes.js";
import { toEpochSeconds } from "./marketDataTypes.js";

export type IndicatorRangeRequester = (
  start: EpochSeconds,
  end: EpochSeconds,
  reason?: IndicatorRangeRequest["reason"],
  metadata?: Pick<IndicatorRangeEvent, "initialSettlementRelease">,
) => unknown;

export function mergeIndicatorWindowChangedRanges(
  ...sources: Array<readonly WindowChangedRange[] | null | undefined>
): WindowChangedRange[] {
  const normalized = sources.flatMap((ranges) => (ranges == null ? [] : Array.from(ranges)))
    .filter((range): range is WindowChangedRange => Boolean(
      range
      && (range.type === "prepend" || range.type === "mid-merge" || range.type === "append")
      && Number.isFinite(Number(range.start))
      && Number.isFinite(Number(range.end))
      && Number(range.start) > 0
      && Number(range.start) <= Number(range.end),
    ))
    .map((range) => ({
      start: toEpochSeconds(Math.floor(Number(range.start))),
      end: toEpochSeconds(Math.floor(Number(range.end))),
      type: range.type,
    }))
    .filter((range): range is WindowChangedRange => range.start != null && range.end != null)
    .sort((left, right) => (
      left.type.localeCompare(right.type)
      || left.start - right.start
      || left.end - right.end
    ));
  const merged: WindowChangedRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && previous.type === range.type && range.start <= previous.end) {
      previous.end = toEpochSeconds(Math.max(previous.end, range.end)) ?? previous.end;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function requestIndicatorRangeInChunks(
  requestRange: IndicatorRangeRequester | null | undefined,
  start: unknown,
  end: unknown,
  reason?: IndicatorRangeRequest["reason"],
  metadata?: Pick<IndicatorRangeEvent, "initialSettlementRelease">,
): void {
  if (typeof requestRange !== "function") return;
  const startSec = toEpochSeconds(Math.floor(Number(start)));
  const endSec = toEpochSeconds(Math.floor(Number(end)));
  if (startSec == null || endSec == null || startSec <= 0 || endSec <= 0 || startSec > endSec) {
    return;
  }
  requestRange(startSec, endSec, reason, metadata);
}

export function resolveIndicatorRangeFromWindowMeta(
  meta: IndicatorWindowMeta | null | undefined = {},
): IndicatorRangeRequest | null {
  return resolveIndicatorRangesFromWindowMeta(meta)[0] || null;
}

export function resolveIndicatorRangesFromWindowMeta(
  meta: IndicatorWindowMeta | null | undefined = {},
): IndicatorRangeRequest[] {
  const source = meta || {};
  const changedRanges = Array.isArray(source.changedRanges) ? source.changedRanges : [];
  const precise = changedRanges.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const range = value as Record<string, unknown>;
    const type = range.type;
    if (type !== "prepend" && type !== "mid-merge") return [];
    const start = toEpochSeconds(Math.floor(Number(range.start)));
    const end = toEpochSeconds(Math.floor(Number(range.end)));
    if (start == null || end == null || start <= 0 || end <= 0 || start > end) return [];
    return [{ start, end, reason: `window-${type}` as const }];
  });
  if (precise.length > 0) return precise;
  const type = source.windowDeltaType;
  if (type !== "prepend" && type !== "mid-merge") return [];
  const start = toEpochSeconds(Math.floor(Number(source.incomingFirstTime)));
  const end = toEpochSeconds(Math.floor(Number(source.incomingLastTime)));
  if (start == null || end == null || start <= 0 || end <= 0 || start > end) {
    return [];
  }
  return [{ start, end, reason: `window-${type}` }];
}

export function requestIndicatorRangeForWindowMeta(
  requestRange: IndicatorRangeRequester | null | undefined,
  meta: IndicatorWindowMeta | null | undefined = {},
): boolean {
  const source = meta || {};
  const ranges = resolveIndicatorRangesFromWindowMeta(source);
  const metadata = source.source === "initial-history-settled"
    ? { initialSettlementRelease: true }
    : undefined;
  for (const range of ranges) {
    requestIndicatorRangeInChunks(
      requestRange,
      range.start,
      range.end,
      range.reason,
      metadata,
    );
  }
  return ranges.length > 0;
}
