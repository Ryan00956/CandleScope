import type { IndicatorRangeEvent } from "../market-data/klineContracts.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { createIntervalTimeline } from "../../utils/intervalTimeline.js";
import {
  normalizeIndicatorRange,
  planIndicatorDirtyRefresh,
} from "./indicatorRangeCoverage.js";
import {
  estimateCorrectionPropagationBars,
  planIndicatorCorrectionRefresh,
} from "./indicatorRangePlanning.js";
import type { IndicatorDefinition, IndicatorRange } from "./indicatorTypes.js";

export interface IndicatorWindowDeltaPlan {
  cascadeRight: boolean;
  invalidateRange: IndicatorRange | null;
  requestRange: IndicatorRange | null;
}

export interface IndicatorWindowDeltaRefresh {
  indicator: IndicatorDefinition;
  plan: IndicatorWindowDeltaPlan;
}

export interface IndicatorWindowDeltaRequestGroup {
  indicatorIds: string[];
  range: IndicatorRange;
}

interface IndicatorWindowDeltaPlanOptions {
  cascadeRight?: boolean;
}

export const INDICATOR_WINDOW_CORRECTION_COALESCE_MS = 250;
export const MAX_CONSUMED_INDICATOR_RANGE_REQUEST_IDS = 2_048;

export function canStartIndicatorWindowHydration({
  chartDataLength,
  historyWindowPending,
}: {
  chartDataLength: number;
  historyWindowPending: boolean;
}): boolean {
  return chartDataLength > 0 && !historyWindowPending;
}

export function canStartIndicatorInitialHydration({
  chartDataLength,
  chartDataReady,
  historyWindowPending,
}: {
  chartDataLength: number;
  chartDataReady: boolean;
  historyWindowPending: boolean;
}): boolean {
  return chartDataReady && canStartIndicatorWindowHydration({
    chartDataLength,
    historyWindowPending,
  });
}

export function canStartIndicatorAutoRightCatchup({
  chartDataLength,
  chartDataReady,
  historyWindowPending,
  initialHydrationPending,
}: {
  chartDataLength: number;
  chartDataReady: boolean;
  historyWindowPending: boolean;
  initialHydrationPending: boolean;
}): boolean {
  return canStartIndicatorInitialHydration({
    chartDataLength,
    chartDataReady,
    historyWindowPending,
  }) && !initialHydrationPending;
}

export function canRunHostedIndicatorStream({
  chartDataReady,
  initialHydrationSettled,
  streamStartedForSeries,
}: {
  chartDataReady: boolean;
  initialHydrationSettled: boolean;
  streamStartedForSeries: boolean;
}): boolean {
  return chartDataReady && (initialHydrationSettled || streamStartedForSeries);
}

export function canExecuteHostedHistoricalFallback({
  historyWindowPending,
  initialHydrationSettled,
}: {
  historyWindowPending: boolean;
  initialHydrationSettled: boolean;
}): boolean {
  return !historyWindowPending && initialHydrationSettled;
}

export function canFlushHostedSeedCoverageRefresh({
  acknowledged,
  historyWindowPending,
  refreshPending,
}: {
  acknowledged: boolean;
  historyWindowPending: boolean;
  refreshPending: boolean;
}): boolean {
  return acknowledged && refreshPending && !historyWindowPending;
}

export function reconcileConsumedIndicatorRangeRequestIds(
  consumed: Set<number>,
  requests: readonly IndicatorRangeEvent[],
  sessionKey: string,
  maxEntries = MAX_CONSUMED_INDICATOR_RANGE_REQUEST_IDS,
): void {
  const retainedIds = new Set(
    requests
      .filter((request) => request?.sessionKey === sessionKey)
      .map((request) => request.id),
  );
  for (const id of consumed) {
    if (!retainedIds.has(id)) consumed.delete(id);
  }
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 1));
  while (consumed.size > limit) {
    const oldest = consumed.values().next().value as number | undefined;
    if (oldest === undefined) break;
    consumed.delete(oldest);
  }
}

export function indicatorWindowCorrectionCoalesceDelay(
  request: IndicatorRangeEvent | null | undefined,
  now = Date.now(),
  windowMs = INDICATOR_WINDOW_CORRECTION_COALESCE_MS,
): number {
  if (
    !request
    || (request.reason !== "window-prepend" && request.reason !== "window-mid-merge")
  ) return 0;
  const createdAt = Number(request.createdAt);
  const normalizedWindowMs = Math.max(0, Math.floor(Number(windowMs) || 0));
  if (!Number.isFinite(createdAt) || createdAt <= 0 || normalizedWindowMs === 0) return 0;
  return Math.max(0, Math.ceil(createdAt + normalizedWindowMs - Number(now)));
}

function intersectIndicatorRanges(
  left: IndicatorRange,
  right: IndicatorRange,
): IndicatorRange | null {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  return start <= end ? { start, end } : null;
}

export function clampIndicatorWindowRangeToContinuousSegment(
  requestInput: unknown,
  desiredInput: unknown,
  chartData: readonly KlineBar[] = [],
  interval: string | null = null,
): IndicatorRange | null {
  const request = normalizeIndicatorRange(requestInput);
  const desired = normalizeIndicatorRange(desiredInput);
  const timeline = interval ? createIntervalTimeline(interval) : null;
  if (!request || !desired || !timeline || chartData.length === 0) return desired;
  const times = chartData
    .map((bar) => Number(bar?.time))
    .filter((time) => Number.isFinite(time) && time > 0);
  const anchorIndex = times.findIndex((time) => request.start <= time && time <= request.end);
  if (anchorIndex < 0) return intersectIndicatorRanges(request, desired);
  let left = anchorIndex;
  let right = anchorIndex;
  while (left > 0 && timeline.isSuccessor(times[left - 1], times[left])) left -= 1;
  while (
    right + 1 < times.length
    && timeline.isSuccessor(times[right], times[right + 1])
  ) right += 1;
  const segment = { start: times[left] as number, end: times[right] as number };
  const overlap = intersectIndicatorRanges(desired, segment);
  if (overlap) return overlap;
  // A dirty historical segment may be separated from the current visible
  // segment. Never bridge that K-line hole; refresh only the retained suffix
  // of the segment containing the actual changed rows.
  return {
    start: Math.max(request.start, segment.start),
    end: segment.end,
  };
}

/**
 * A mid-window candle correction can affect later output only when the
 * indicator carries state from one bar to the next.  VOL is the one known
 * hosted pointwise builtin: each value and its color are derived solely from
 * that bar.  Unknown/custom indicators stay conservative and cascade right.
 */
export function requiresIndicatorWindowDeltaRightCascade(
  indicator: IndicatorDefinition | null | undefined,
): boolean {
  return estimateCorrectionPropagationBars(indicator) == null;
}

export function planIndicatorWindowDeltaRequest(
  request: IndicatorRangeEvent | null | undefined,
  desiredRange: unknown = null,
  { cascadeRight = true }: IndicatorWindowDeltaPlanOptions = {},
): IndicatorWindowDeltaPlan | null {
  const requestedRange = normalizeIndicatorRange(request);
  if (!requestedRange || !request) return null;
  if (request.reason !== "window-mid-merge") {
    return {
      cascadeRight: false,
      invalidateRange: null,
      requestRange: requestedRange,
    };
  }
  const desired = normalizeIndicatorRange(desiredRange);
  return {
    cascadeRight,
    invalidateRange: requestedRange,
    requestRange: !desired
      ? requestedRange
      : cascadeRight
        ? planIndicatorDirtyRefresh(requestedRange, desired)
        : intersectIndicatorRanges(requestedRange, desired),
  };
}

export function planIndicatorWindowDeltaRefreshes(
  request: IndicatorRangeEvent | null | undefined,
  desiredRange: unknown = null,
  indicators: Iterable<IndicatorDefinition> = [],
  interval: string | null = null,
  chartData: readonly KlineBar[] = [],
): IndicatorWindowDeltaRefresh[] {
  const planned: IndicatorWindowDeltaRefresh[] = [];
  const continuousDesired = request?.reason === "window-mid-merge"
    ? clampIndicatorWindowRangeToContinuousSegment(request, desiredRange, chartData, interval)
    : normalizeIndicatorRange(desiredRange);
  for (const indicator of indicators) {
    if (request?.reason === "window-mid-merge" && interval) {
      const correction = planIndicatorCorrectionRefresh(
        request,
        continuousDesired,
        indicator,
        interval,
      );
      if (correction) {
        planned.push({
          indicator,
          plan: {
            cascadeRight: correction.cascadeRight,
            invalidateRange: correction.affectedRange,
            requestRange: correction.requestRange
              || (!continuousDesired ? correction.affectedRange : null),
          },
        });
        continue;
      }
    }
    const plan = planIndicatorWindowDeltaRequest(request, continuousDesired, {
      cascadeRight: requiresIndicatorWindowDeltaRightCascade(indicator),
    });
    if (plan) planned.push({ indicator, plan });
  }
  return planned;
}

export function groupIndicatorWindowDeltaRefreshes(
  refreshes: Iterable<IndicatorWindowDeltaRefresh>,
): IndicatorWindowDeltaRequestGroup[] {
  const grouped = new Map<string, IndicatorWindowDeltaRequestGroup>();
  for (const { indicator, plan } of refreshes) {
    if (!plan.requestRange) continue;
    const rangeKey = `${plan.requestRange.start}:${plan.requestRange.end}`;
    const existing = grouped.get(rangeKey);
    if (existing) {
      existing.indicatorIds.push(indicator.id);
    } else {
      grouped.set(rangeKey, {
        indicatorIds: [indicator.id],
        range: plan.requestRange,
      });
    }
  }
  return Array.from(grouped.values());
}

interface IndicatorRangeEventSettlementOptions {
  indicatorIds: Iterable<unknown>;
  onFailure: (detail: Record<string, unknown>) => void;
  onSuccess: () => void;
  waitForAllTargetsOnFailure?: boolean;
}

export function createIndicatorRangeEventSettlementBarrier({
  indicatorIds,
  onFailure,
  onSuccess,
  waitForAllTargetsOnFailure = false,
}: IndicatorRangeEventSettlementOptions): (
  ok: boolean,
  detail?: Record<string, unknown>,
) => void {
  const pendingIds = new Set(Array.from(indicatorIds, (value) => String(value)));
  let failureDetail: Record<string, unknown> | null = null;
  let settled = false;
  return (ok, detail = {}) => {
    if (settled) return;
    const indicatorId = detail.indicatorId == null ? "" : String(detail.indicatorId);
    if (!indicatorId || !pendingIds.has(indicatorId)) {
      settled = true;
      onFailure(detail);
      return;
    }
    pendingIds.delete(indicatorId);
    if (!ok) {
      if (!waitForAllTargetsOnFailure) {
        settled = true;
        onFailure(detail);
        return;
      }
      if (!failureDetail || detail.deferred === true) failureDetail = detail;
    }
    if (pendingIds.size > 0) return;
    settled = true;
    if (failureDetail) onFailure(failureDetail);
    else onSuccess();
  };
}
