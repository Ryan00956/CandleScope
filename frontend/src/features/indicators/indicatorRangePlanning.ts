import { parseIntervalParts, parseIntervalSeconds } from "../../utils/intervals.js";
import { createIntervalTimeline } from "../../utils/intervalTimeline.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  DeferredRightCatchupPlan,
  IndicatorDefinition,
  IndicatorParams,
  IndicatorRange,
  IndicatorVisibleRange,
  InitialHostedRange,
} from "./indicatorTypes.js";

const INITIAL_VISIBLE_FALLBACK_BARS = 600;
const INITIAL_VISIBLE_PADDING_MIN_BARS = 120;
const INITIAL_VISIBLE_PADDING_RATIO = 0.35;
const INITIAL_VISIBLE_PADDING_MAX_BARS = 1_000;

/**
 * Visible-range navigation is bucketed so a drag inside an already planned
 * K-line block is a cache hit instead of a new sliding-tail HTTP request.
 * Keep this below the backend's 50k compute ceiling and large enough to cover
 * several normal chart viewports.
 */
export const VISIBLE_RANGE_RIGHT_PREFETCH_BUCKET_BARS = 1_500;

export interface IndicatorVisibleNavigationState {
  seriesKey: string;
  visibleEnd: number;
  visibleStart: number;
}

export interface IndicatorVisibleHydrationPlan {
  direction: "initial" | "left" | "right" | "stationary";
  endIndex: number;
  nextState: IndicatorVisibleNavigationState | null;
  range: IndicatorRange;
}

export const RIGHT_CATCHUP_GRACE_MS = 1_500;

export function nextIndicatorBarTime(
  lastBarTime: unknown,
  interval: unknown,
  fallbackSeconds: unknown = null,
): number | null {
  const normalized = normalizeRangeBoundary(lastBarTime);
  if (!normalized) return null;
  const semanticNext = createIntervalTimeline(interval)?.next(normalized);
  if (semanticNext !== null && semanticNext !== undefined) {
    return normalizeRangeBoundary(semanticNext);
  }
  const fallback = Math.floor(Number(fallbackSeconds));
  return Number.isFinite(fallback) && fallback > 0
    ? normalizeRangeBoundary(normalized + fallback)
    : null;
}

function normalizeRangeBoundary(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function chartBarTimeAt(
  chartData: readonly KlineBar[],
  index: number,
): unknown {
  const bar: KlineBar | undefined = chartData[index];
  return bar?.time;
}

function paramInt(params: IndicatorParams, key: string, fallback: number): number {
  const value = Number.parseInt(String(params[key] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function estimateOutputWarmupBars(indicator: IndicatorDefinition | null | undefined): number {
  const name = String(indicator?.engineName || "").toUpperCase();
  const params = indicator?.params || {};
  if (name === "VOL") return 0;
  if (name === "MA" || name === "SMA" || name === "BOLL") {
    return Math.max(0, paramInt(params, "period", 20) - 1);
  }
  if (name === "EMA") return Math.max(0, paramInt(params, "period", 20) - 1);
  if (name === "RSI" || name === "ATR") return paramInt(params, "period", 14);
  if (name === "MACD") {
    return paramInt(params, "slow", paramInt(params, "slow_period", 26))
      + paramInt(params, "signal", paramInt(params, "signal_period", 9));
  }
  return Math.max(0, paramInt(params, "warmup", 0));
}

/**
 * Return a correction horizon only for indicators whose formula has a finite
 * dependency window.  Recursive indicators and custom scripts return null and
 * must remain invalid through the current cached/desired right edge.
 */
export function estimateCorrectionPropagationBars(
  indicator: IndicatorDefinition | null | undefined,
): number | null {
  const name = String(indicator?.engineName || "").toUpperCase();
  const params = indicator?.params || {};
  if (name === "VOL") return 0;
  if (name === "MA" || name === "SMA" || name === "BOLL") {
    return Math.max(0, paramInt(params, "period", 20) - 1);
  }
  // Recursive indicators and arbitrary scripts have no finite mathematical
  // correction horizon.  Their input warmup is an initialization budget, not
  // permission to rebase later cached outputs across a historical change.
  return null;
}

function advanceIndicatorBoundary(
  boundary: number,
  interval: string,
  bars: number,
): number {
  const timeline = createIntervalTimeline(interval);
  const fixedStep = parseIntervalSeconds(interval) || 1;
  let cursor = boundary;
  for (let index = 0; index < bars; index += 1) {
    cursor = timeline?.next(cursor) ?? (cursor + fixedStep);
  }
  return cursor;
}

export function planIndicatorCorrectionRefresh(
  dirtyInput: unknown,
  desiredInput: unknown,
  indicator: IndicatorDefinition | null | undefined,
  interval: string,
): {
  affectedRange: IndicatorRange;
  cascadeRight: boolean;
  requestRange: IndicatorRange | null;
} | null {
  const dirty = dirtyInput && typeof dirtyInput === "object" && !Array.isArray(dirtyInput)
    ? dirtyInput as Partial<IndicatorRange>
    : null;
  const desired = desiredInput && typeof desiredInput === "object" && !Array.isArray(desiredInput)
    ? desiredInput as Partial<IndicatorRange>
    : null;
  const dirtyStart = normalizeRangeBoundary(dirty?.start);
  const dirtyEnd = normalizeRangeBoundary(dirty?.end);
  if (!dirtyStart || !dirtyEnd || dirtyStart > dirtyEnd) return null;
  const propagationBars = estimateCorrectionPropagationBars(indicator);
  const cascadeRight = propagationBars == null;
  const affectedRange = cascadeRight
    ? { start: dirtyStart, end: dirtyEnd }
    : {
        start: dirtyStart,
        end: advanceIndicatorBoundary(dirtyEnd, interval, propagationBars),
      };
  const desiredStart = normalizeRangeBoundary(desired?.start);
  const desiredEnd = normalizeRangeBoundary(desired?.end);
  if (!desiredStart || !desiredEnd || desiredStart > desiredEnd) {
    return { affectedRange, cascadeRight, requestRange: null };
  }
  const requestStart = Math.max(affectedRange.start, desiredStart);
  const requestEnd = cascadeRight
    ? desiredEnd
    : Math.min(affectedRange.end, desiredEnd);
  return {
    affectedRange,
    cascadeRight,
    requestRange: requestStart <= requestEnd
      ? { start: requestStart, end: requestEnd }
      : null,
  };
}

function maxHostedWarmupBars(hostedIndicators: readonly IndicatorDefinition[] = []): number {
  return hostedIndicators.reduce(
    (maxWarmup, indicator) => Math.max(maxWarmup, estimateOutputWarmupBars(indicator)),
    0,
  );
}

function lowerBoundTime(chartData: readonly KlineBar[], target: number): number {
  let lo = 0;
  let hi = chartData.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Number(chartBarTimeAt(chartData, mid)) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTime(chartData: readonly KlineBar[], target: number): number {
  let lo = 0;
  let hi = chartData.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Number(chartBarTimeAt(chartData, mid)) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function resolveVisibleIndexesFromTime(
  chartData: readonly KlineBar[],
  timeRange: IndicatorVisibleRange["time"],
): { startIndex: number; endIndex: number } | null {
  const from = normalizeRangeBoundary(timeRange?.from);
  const to = normalizeRangeBoundary(timeRange?.to);
  if (!from || !to || from > to || !Array.isArray(chartData) || chartData.length === 0) return null;

  const firstTime = normalizeRangeBoundary(chartBarTimeAt(chartData, 0));
  const lastTime = normalizeRangeBoundary(
    chartBarTimeAt(chartData, chartData.length - 1),
  );
  if (!firstTime || !lastTime || to < firstTime || from > lastTime) return null;

  const startIndex = Math.min(chartData.length - 1, lowerBoundTime(chartData, Math.max(from, firstTime)));
  const endIndex = Math.max(0, upperBoundTime(chartData, Math.min(to, lastTime)) - 1);
  if (startIndex > endIndex) return null;
  return { startIndex, endIndex };
}

function resolveVisibleIndexesFromLogical(
  chartData: readonly KlineBar[],
  logicalRange: IndicatorVisibleRange["logical"],
): { startIndex: number; endIndex: number } | null {
  if (!logicalRange || !Array.isArray(chartData) || chartData.length === 0) return null;
  const from = Math.floor(Number(logicalRange.from));
  const to = Math.ceil(Number(logicalRange.to));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;

  const startIndex = Math.max(0, Math.min(chartData.length - 1, from));
  const endIndex = Math.max(0, Math.min(chartData.length - 1, to));
  if (startIndex > endIndex) return null;
  return { startIndex, endIndex };
}

function resolveVisibleIndexes(
  chartData: readonly KlineBar[],
  visibleRange: IndicatorVisibleRange | null | undefined,
): { startIndex: number; endIndex: number } | null {
  return resolveVisibleIndexesFromTime(chartData, visibleRange?.time)
    || resolveVisibleIndexesFromLogical(chartData, visibleRange?.logical);
}

export function inferFixedIntervalClosedThrough(
  chartData: readonly KlineBar[],
  interval: string,
  nowMs = Date.now(),
): number | null {
  const parts = parseIntervalParts(interval);
  const step = parseIntervalSeconds(interval);
  const nowSec = Math.floor(Number(nowMs) / 1_000);
  if (
    parts?.unit === "M"
    || typeof step !== "number"
    || !Number.isFinite(step)
    || step <= 0
    || !Number.isFinite(nowSec)
    || nowSec <= 0
    || !Array.isArray(chartData)
    || chartData.length === 0
  ) {
    return null;
  }

  for (let index = chartData.length - 1; index >= 0; index -= 1) {
    const barTime = normalizeRangeBoundary(chartBarTimeAt(chartData, index));
    if (barTime && barTime + step <= nowSec) return barTime;
  }

  const firstTime = normalizeRangeBoundary(chartBarTimeAt(chartData, 0));
  return firstTime ? Math.max(1, firstTime - step) : null;
}

export function resolveInitialHostedRange(
  chartData: readonly KlineBar[],
  hostedIndicators: readonly IndicatorDefinition[],
  visibleRange: IndicatorVisibleRange | null | undefined,
): InitialHostedRange | null {
  if (!Array.isArray(chartData) || chartData.length === 0) return null;
  const visibleIndexes = resolveVisibleIndexes(chartData, visibleRange) || {
    startIndex: Math.max(0, chartData.length - INITIAL_VISIBLE_FALLBACK_BARS),
    endIndex: chartData.length - 1,
  };
  const visibleBars = Math.max(1, visibleIndexes.endIndex - visibleIndexes.startIndex + 1);
  const warmupBars = maxHostedWarmupBars(hostedIndicators);
  const paddingBars = Math.min(
    INITIAL_VISIBLE_PADDING_MAX_BARS,
    Math.max(INITIAL_VISIBLE_PADDING_MIN_BARS, Math.ceil(visibleBars * INITIAL_VISIBLE_PADDING_RATIO)),
  );
  const startIndex = Math.max(0, visibleIndexes.startIndex - warmupBars - paddingBars);
  const endIndex = Math.max(startIndex, visibleIndexes.endIndex);
  const start = normalizeRangeBoundary(chartBarTimeAt(chartData, startIndex));
  const end = normalizeRangeBoundary(chartBarTimeAt(chartData, endIndex));
  if (!start || !end || start > end) return null;
  return {
    start,
    end,
    startIndex,
    endIndex,
    visibleStart: normalizeRangeBoundary(
      chartBarTimeAt(chartData, visibleIndexes.startIndex),
    ),
    visibleEnd: normalizeRangeBoundary(
      chartBarTimeAt(chartData, visibleIndexes.endIndex),
    ),
    visibleStartIndex: visibleIndexes.startIndex,
    visibleEndIndex: visibleIndexes.endIndex,
    warmupBars,
    paddingBars,
  };
}

function resolveVisibleNavigationDirection(
  previous: IndicatorVisibleNavigationState | null | undefined,
  next: IndicatorVisibleNavigationState | null,
): IndicatorVisibleHydrationPlan["direction"] {
  if (!next || !previous || previous.seriesKey !== next.seriesKey) return "initial";
  const movedRight = next.visibleStart >= previous.visibleStart
    && next.visibleEnd >= previous.visibleEnd
    && (
      next.visibleStart > previous.visibleStart
      || next.visibleEnd > previous.visibleEnd
    );
  if (movedRight) return "right";
  const movedLeft = next.visibleStart <= previous.visibleStart
    && next.visibleEnd <= previous.visibleEnd
    && (
      next.visibleStart < previous.visibleStart
      || next.visibleEnd < previous.visibleEnd
    );
  return movedLeft ? "left" : "stationary";
}

function continuousRightEndIndex(
  chartData: readonly KlineBar[],
  startIndex: number,
  candidateEndIndex: number,
  interval: unknown,
): number {
  const timeline = createIntervalTimeline(interval);
  if (!timeline) return startIndex;
  let endIndex = startIndex;
  for (let index = startIndex + 1; index <= candidateEndIndex; index += 1) {
    const previousTime = normalizeRangeBoundary(chartBarTimeAt(chartData, index - 1));
    const currentTime = normalizeRangeBoundary(chartBarTimeAt(chartData, index));
    if (!previousTime || !currentTime || !timeline.isSuccessor(previousTime, currentTime)) break;
    endIndex = index;
  }
  return endIndex;
}

/**
 * Expand only an explicitly right-moving viewport to the end of its fixed
 * K-line index bucket. Leftward history navigation remains exact, because
 * speculative right work would be invalidated by the next prepend revision.
 */
export function planVisibleIndicatorHydrationRange({
  bucketBars = VISIBLE_RANGE_RIGHT_PREFETCH_BUCKET_BARS,
  chartData,
  desired,
  interval,
  previous,
  seriesKey,
}: {
  bucketBars?: number;
  chartData: readonly KlineBar[];
  desired: InitialHostedRange;
  interval: unknown;
  previous?: IndicatorVisibleNavigationState | null;
  seriesKey: unknown;
}): IndicatorVisibleHydrationPlan {
  const normalizedSeriesKey = String(seriesKey || "");
  const visibleStart = normalizeRangeBoundary(desired.visibleStart);
  const visibleEnd = normalizeRangeBoundary(desired.visibleEnd);
  const nextState = normalizedSeriesKey && visibleStart && visibleEnd
    ? { seriesKey: normalizedSeriesKey, visibleStart, visibleEnd }
    : null;
  const direction = resolveVisibleNavigationDirection(previous, nextState);
  const exactPlan: IndicatorVisibleHydrationPlan = {
    direction,
    endIndex: desired.endIndex,
    nextState,
    range: { start: desired.start, end: desired.end },
  };
  if (
    direction !== "right"
    || !Array.isArray(chartData)
    || chartData.length === 0
    || desired.endIndex < 0
    || desired.endIndex >= chartData.length
  ) return exactPlan;

  const normalizedBucketBars = Math.max(1, Math.floor(Number(bucketBars) || 1));
  const anchorIndex = Math.max(desired.endIndex, desired.visibleEndIndex);
  const bucketEndIndex = Math.min(
    chartData.length - 1,
    (Math.floor(anchorIndex / normalizedBucketBars) + 1) * normalizedBucketBars - 1,
  );
  if (bucketEndIndex <= desired.endIndex) return exactPlan;
  const endIndex = continuousRightEndIndex(
    chartData,
    desired.endIndex,
    bucketEndIndex,
    interval,
  );
  const end = normalizeRangeBoundary(chartBarTimeAt(chartData, endIndex));
  if (!end || end <= desired.end) return exactPlan;
  return {
    direction,
    endIndex,
    nextState,
    range: { start: desired.start, end },
  };
}

export function planDeferredRightCatchup(
  previous: Partial<DeferredRightCatchupPlan> | null | undefined,
  next: Partial<DeferredRightCatchupPlan> | null | undefined,
  nowMs: number,
  graceMs = RIGHT_CATCHUP_GRACE_MS,
): DeferredRightCatchupPlan | null {
  if (!next?.key || !next?.signature || !next?.range) return null;
  const firstSeenAt = previous?.key === next.key
    ? Number(previous.firstSeenAt || nowMs)
    : nowMs;
  const elapsedMs = Math.max(0, nowMs - firstSeenAt);
  return {
    ...next,
    key: next.key,
    signature: next.signature,
    range: next.range,
    firstSeenAt,
    delayMs: Math.max(0, graceMs - elapsedMs),
  };
}
