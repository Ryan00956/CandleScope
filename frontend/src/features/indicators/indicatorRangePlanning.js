import { parseIntervalParts, parseIntervalSeconds } from "../../utils/intervals.js";

const INITIAL_VISIBLE_FALLBACK_BARS = 600;
const INITIAL_VISIBLE_PADDING_MIN_BARS = 120;
const INITIAL_VISIBLE_PADDING_RATIO = 0.35;
const INITIAL_VISIBLE_PADDING_MAX_BARS = 1_000;

export const RIGHT_CATCHUP_GRACE_MS = 1_500;

function normalizeRangeBoundary(value) {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function paramInt(params, key, fallback) {
  const value = Number.parseInt(params?.[key], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function estimateOutputWarmupBars(indicator) {
  const name = String(indicator?.engineName || "").toUpperCase();
  const params = indicator?.params || {};
  if (name === "VOL") return 0;
  if (name === "MA" || name === "SMA" || name === "BOLL") {
    return Math.max(0, paramInt(params, "period", 20) - 1);
  }
  if (name === "EMA") return Math.max(0, paramInt(params, "period", 20) - 1);
  if (name === "RSI" || name === "ATR") return paramInt(params, "period", 14);
  if (name === "MACD") {
    return paramInt(params, "slow", 26) + paramInt(params, "signal", 9);
  }
  return Math.max(0, paramInt(params, "warmup", 0));
}

function maxHostedWarmupBars(hostedIndicators = []) {
  return hostedIndicators.reduce(
    (maxWarmup, indicator) => Math.max(maxWarmup, estimateOutputWarmupBars(indicator)),
    0,
  );
}

function lowerBoundTime(chartData, target) {
  let lo = 0;
  let hi = chartData.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Number(chartData[mid]?.time) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTime(chartData, target) {
  let lo = 0;
  let hi = chartData.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Number(chartData[mid]?.time) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function resolveVisibleIndexesFromTime(chartData, timeRange) {
  const from = normalizeRangeBoundary(timeRange?.from);
  const to = normalizeRangeBoundary(timeRange?.to);
  if (!from || !to || from > to || !Array.isArray(chartData) || chartData.length === 0) return null;

  const firstTime = normalizeRangeBoundary(chartData[0]?.time);
  const lastTime = normalizeRangeBoundary(chartData[chartData.length - 1]?.time);
  if (!firstTime || !lastTime || to < firstTime || from > lastTime) return null;

  const startIndex = Math.min(chartData.length - 1, lowerBoundTime(chartData, Math.max(from, firstTime)));
  const endIndex = Math.max(0, upperBoundTime(chartData, Math.min(to, lastTime)) - 1);
  if (startIndex > endIndex) return null;
  return { startIndex, endIndex };
}

function resolveVisibleIndexesFromLogical(chartData, logicalRange) {
  if (!logicalRange || !Array.isArray(chartData) || chartData.length === 0) return null;
  const from = Math.floor(Number(logicalRange.from));
  const to = Math.ceil(Number(logicalRange.to));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;

  const startIndex = Math.max(0, Math.min(chartData.length - 1, from));
  const endIndex = Math.max(0, Math.min(chartData.length - 1, to));
  if (startIndex > endIndex) return null;
  return { startIndex, endIndex };
}

function resolveVisibleIndexes(chartData, visibleRange) {
  return resolveVisibleIndexesFromTime(chartData, visibleRange?.time)
    || resolveVisibleIndexesFromLogical(chartData, visibleRange?.logical);
}

export function inferFixedIntervalClosedThrough(chartData, interval, nowMs = Date.now()) {
  const parts = parseIntervalParts(interval);
  const step = parseIntervalSeconds(interval);
  const nowSec = Math.floor(Number(nowMs) / 1_000);
  if (
    parts?.unit === "M"
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
    const barTime = normalizeRangeBoundary(chartData[index]?.time);
    if (barTime && barTime + step <= nowSec) return barTime;
  }

  const firstTime = normalizeRangeBoundary(chartData[0]?.time);
  return firstTime ? Math.max(1, firstTime - step) : null;
}

export function resolveInitialHostedRange(chartData, hostedIndicators, visibleRange) {
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
  const start = normalizeRangeBoundary(chartData[startIndex]?.time);
  const end = normalizeRangeBoundary(chartData[endIndex]?.time);
  if (!start || !end || start > end) return null;
  return {
    start,
    end,
    startIndex,
    endIndex,
    visibleStart: normalizeRangeBoundary(chartData[visibleIndexes.startIndex]?.time),
    visibleEnd: normalizeRangeBoundary(chartData[visibleIndexes.endIndex]?.time),
    visibleStartIndex: visibleIndexes.startIndex,
    visibleEndIndex: visibleIndexes.endIndex,
    warmupBars,
    paddingBars,
  };
}

export function planDeferredRightCatchup(previous, next, nowMs, graceMs = RIGHT_CATCHUP_GRACE_MS) {
  if (!next?.key || !next?.signature || !next?.range) return null;
  const firstSeenAt = previous?.key === next.key
    ? Number(previous.firstSeenAt || nowMs)
    : nowMs;
  const elapsedMs = Math.max(0, nowMs - firstSeenAt);
  return {
    ...next,
    firstSeenAt,
    delayMs: Math.max(0, graceMs - elapsedMs),
  };
}
