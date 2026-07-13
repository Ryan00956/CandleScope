import {
  createFutureIntervalBasis,
  futureTimeFromIntervalDistance,
} from "../utils/intervalTimeline.js";

export const FUTURE_TIME_AXIS_INITIAL_POINTS = 64;
export const FUTURE_TIME_AXIS_GROWTH_POINTS = 64;
export const FUTURE_TIME_AXIS_RESERVE_POINTS = 32;
export const FUTURE_TIME_AXIS_MAX_POINTS = 8_192;
export const FUTURE_TIME_AXIS_ORDINAL_ORDER_START = Number.MAX_SAFE_INTEGER
  - FUTURE_TIME_AXIS_MAX_POINTS;

const EMPTY_PLAN_KEY = "future-time-axis:empty";

function normalizedPointCount(value) {
  const count = Math.floor(Number(value));
  return Number.isFinite(count) && count > 0
    ? Math.min(count, FUTURE_TIME_AXIS_MAX_POINTS)
    : 0;
}

function lastDisplayTime(displayRows) {
  if (!Array.isArray(displayRows)) return null;
  for (let index = displayRows.length - 1; index >= 0; index -= 1) {
    if (displayRows[index]?.time != null) return displayRows[index].time;
  }
  return null;
}

function numericDisplayTimeExists(displayRows, target) {
  let left = 0;
  let right = displayRows.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    const time = Number(displayRows[middle]?.time);
    if (!Number.isFinite(time)) return false;
    if (time < target) left = middle + 1;
    else right = middle;
  }
  return Number(displayRows[left]?.time) === target;
}

export function countFutureTimeAxisPointsAfter(data, sourceTimeHorizon) {
  if (!Array.isArray(data) || !Number.isFinite(sourceTimeHorizon)) return 0;
  let left = 0;
  let right = data.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    const time = Number(data[middle]?.time);
    if (!Number.isFinite(time)) return 0;
    if (time <= sourceTimeHorizon) left = middle + 1;
    else right = middle;
  }
  return data.length - left;
}

/**
 * Numeric carrier points can stay registered as their timestamps become real
 * bars. Rebuild only after a gap would leave a fake logical point behind or
 * the remaining future reserve is running low.
 */
export function canReuseFutureTimeAxisData({
  axisMode = "time",
  currentData = [],
  displayRows = [],
  reservePoints = FUTURE_TIME_AXIS_RESERVE_POINTS,
  sourceTimeHorizon,
} = {}) {
  if (axisMode !== "time"
    || !Array.isArray(currentData)
    || currentData.length === 0
    || !Array.isArray(displayRows)
    || displayRows.length === 0
    || !Number.isFinite(sourceTimeHorizon)) {
    return false;
  }

  const remaining = countFutureTimeAxisPointsAfter(currentData, sourceTimeHorizon);
  if (remaining < Math.max(1, Math.floor(Number(reservePoints)) || 0)) return false;
  for (const point of currentData) {
    const time = Number(point?.time);
    if (!Number.isFinite(time)) return false;
    if (time > sourceTimeHorizon) break;
    if (!numericDisplayTimeExists(displayRows, time)) return false;
  }
  return true;
}

function emptyPlan(currentKey) {
  return {
    changed: currentKey !== EMPTY_PLAN_KEY,
    data: currentKey === EMPTY_PLAN_KEY ? null : [],
    key: EMPTY_PLAN_KEY,
  };
}

/**
 * Build render-only whitespace points which extend Lightweight Charts' shared
 * horizontal scale without entering source, projection, indicator, or drawing
 * data. `currentKey` lets high-frequency updates skip allocating an identical
 * future horizon.
 */
export function planFutureTimeAxis({
  axisMode = "time",
  currentKey = null,
  displayRows = [],
  pointCount = FUTURE_TIME_AXIS_INITIAL_POINTS,
  sourceInterval,
  sourceIntervalSeconds,
  sourceTimeHorizon,
} = {}) {
  const count = normalizedPointCount(pointCount);
  const tailTime = lastDisplayTime(displayRows);
  const intervalBasis = createFutureIntervalBasis({
    horizon: sourceTimeHorizon,
    sourceInterval,
    sourceIntervalSeconds,
  });
  if (!count || tailTime == null || !intervalBasis) return emptyPlan(currentKey);

  const usesOrdinalAxis = axisMode === "derived-ordinal" || axisMode === "ordinal";
  const tailOrder = usesOrdinalAxis ? Number(tailTime?.order) : null;
  const tailSourceTime = usesOrdinalAxis
    ? Number(tailTime?.sourceTime)
    : Number(tailTime);
  if (!Number.isFinite(tailSourceTime)
    || (usesOrdinalAxis && !Number.isSafeInteger(tailOrder))) {
    return emptyPlan(currentKey);
  }

  const key = JSON.stringify([
    "future-time-axis",
    usesOrdinalAxis ? "ordinal" : "time",
    intervalBasis.horizon,
    intervalBasis.calendarMonths,
    intervalBasis.step,
    count,
    usesOrdinalAxis ? "reserved-order-space" : tailSourceTime,
  ]);
  if (key === currentKey) return { changed: false, data: null, key };

  const data = [];
  let previousSourceTime = Math.max(intervalBasis.horizon, tailSourceTime);
  for (let cell = 1; cell <= count; cell += 1) {
    const sourceTime = futureTimeFromIntervalDistance(intervalBasis, cell);
    if (!Number.isFinite(sourceTime) || sourceTime <= previousSourceTime) {
      return emptyPlan(currentKey);
    }
    data.push({
      time: usesOrdinalAxis
        ? {
            order: FUTURE_TIME_AXIS_ORDINAL_ORDER_START + cell,
            sourceTime,
            sourceOrdinal: 0,
          }
        : sourceTime,
    });
    previousSourceTime = sourceTime;
  }

  return { changed: true, data, key };
}

export function resolveFutureTimeAxisPointCount({
  contentLastLogical,
  currentCount = 0,
  allocatedCount = currentCount,
  growthPoints = FUTURE_TIME_AXIS_GROWTH_POINTS,
  initialPoints = FUTURE_TIME_AXIS_INITIAL_POINTS,
  maxPoints = FUTURE_TIME_AXIS_MAX_POINTS,
  reservePoints = FUTURE_TIME_AXIS_RESERVE_POINTS,
  visibleLogicalRange,
} = {}) {
  const maximum = Math.max(1, Math.floor(Number(maxPoints)) || FUTURE_TIME_AXIS_MAX_POINTS);
  const growth = Math.max(1, Math.floor(Number(growthPoints)) || FUTURE_TIME_AXIS_GROWTH_POINTS);
  const initial = Math.max(1, Math.floor(Number(initialPoints)) || FUTURE_TIME_AXIS_INITIAL_POINTS);
  const reserve = Math.max(0, Math.floor(Number(reservePoints)) || 0);
  const current = Math.max(0, Math.floor(Number(currentCount)) || 0);
  const allocated = Math.min(
    maximum,
    Math.max(current, Math.floor(Number(allocatedCount)) || 0),
  );

  if (!Number.isFinite(contentLastLogical)
    || !Number.isFinite(visibleLogicalRange?.to)) {
    return allocated > 0 ? allocated : Math.min(maximum, initial);
  }

  const required = Math.max(
    initial,
    Math.ceil(visibleLogicalRange.to - contentLastLogical) + reserve,
  );
  const rounded = Math.min(
    maximum,
    Math.ceil(Math.max(1, required) / growth) * growth,
  );

  // If live bars have consumed part of the carrier, rebuild the existing
  // allocation before the visible range reaches its end. Otherwise retain the
  // allocation to avoid churn while panning around the same future area.
  if (rounded > current) return Math.max(allocated, rounded);

  // Release unusually large one-off expansions after the user returns near
  // live data. Requiring at least a 2x reduction prevents resize oscillation.
  if (allocated > initial && rounded * 2 <= allocated) return rounded;
  return allocated;
}
