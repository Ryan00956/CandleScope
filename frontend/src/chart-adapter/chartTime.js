function ordinalOrder(time) {
  if (
    time !== null
    && typeof time === "object"
    && !Array.isArray(time)
    && Number.isSafeInteger(time.order)
  ) {
    return time.order;
  }
  return null;
}

function businessDayOrder(time) {
  if (
    time !== null
    && typeof time === "object"
    && Number.isSafeInteger(time.year)
    && Number.isSafeInteger(time.month)
    && Number.isSafeInteger(time.day)
  ) {
    return time.year * 372 + time.month * 31 + time.day;
  }
  return null;
}

/**
 * Stable key for Lightweight Charts time values used inside adapter-owned maps
 * and render signatures. Ordinal keys include source lineage as well as
 * `order`, so a structural reproject cannot reuse a stale auxiliary point just
 * because the custom horizontal scale assigned the same coordinate again.
 */
export function chartTimeKey(time) {
  const order = ordinalOrder(time);
  if (order !== null) {
    const sourceTime = typeof time.sourceTime === "number" && Number.isFinite(time.sourceTime)
      ? time.sourceTime
      : "";
    const sourceOrdinal = Number.isSafeInteger(time.sourceOrdinal)
      ? time.sourceOrdinal
      : "";
    return `order:${order}:source:${sourceTime}:ordinal:${sourceOrdinal}`;
  }
  if (typeof time === "number" && Number.isFinite(time)) return `time:${time}`;
  if (typeof time === "string") return `string:${time}`;

  const businessDay = businessDayOrder(time);
  if (businessDay !== null) {
    return `day:${time.year}-${time.month}-${time.day}`;
  }
  return null;
}

/** Compare chart coordinates without coercing ordinal objects to numbers. */
export function compareChartTimes(left, right) {
  const leftOrder = ordinalOrder(left);
  const rightOrder = ordinalOrder(right);
  if (leftOrder !== null && rightOrder !== null) return leftOrder - rightOrder;

  if (
    typeof left === "number"
    && Number.isFinite(left)
    && typeof right === "number"
    && Number.isFinite(right)
  ) {
    return left - right;
  }

  const leftDay = businessDayOrder(left);
  const rightDay = businessDayOrder(right);
  if (leftDay !== null && rightDay !== null) return leftDay - rightDay;

  const leftKey = chartTimeKey(left) || "";
  const rightKey = chartTimeKey(right) || "";
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

export function chartTimesEqual(left, right) {
  if (left === right) return true;
  const leftKey = chartTimeKey(left);
  return leftKey !== null && leftKey === chartTimeKey(right);
}

export function sourceTimeFromChartTime(time) {
  if (typeof time === "number" && Number.isFinite(time)) return time;
  if (ordinalOrder(time) === null) return null;
  return typeof time.sourceTime === "number" && Number.isFinite(time.sourceTime)
    ? time.sourceTime
    : null;
}
