import type { ChartTime } from "./chartAdapterTypes.js";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object(value) as Record<string, unknown>
    : null;
}

function ordinalOrder(time: unknown): number | null {
  const record = objectRecord(time);
  if (
    record
    && Number.isSafeInteger(record.order)
  ) {
    return record.order as number;
  }
  return null;
}

function businessDayOrder(time: unknown): number | null {
  const record = objectRecord(time);
  if (
    record
    && Number.isSafeInteger(record.year)
    && Number.isSafeInteger(record.month)
    && Number.isSafeInteger(record.day)
  ) {
    return (record.year as number) * 372
      + (record.month as number) * 31
      + (record.day as number);
  }
  return null;
}

/**
 * Stable key for Lightweight Charts time values used inside adapter-owned maps
 * and render signatures. Ordinal keys include source lineage as well as
 * `order`, so a structural reproject cannot reuse a stale auxiliary point just
 * because the custom horizontal scale assigned the same coordinate again.
 */
export function chartTimeKey(time: ChartTime | null | undefined): string | null {
  const order = ordinalOrder(time);
  if (order !== null) {
    const ordinalTime = objectRecord(time);
    if (!ordinalTime) return null;
    const sourceTime = typeof ordinalTime.sourceTime === "number"
      && Number.isFinite(ordinalTime.sourceTime)
      ? ordinalTime.sourceTime
      : "";
    const sourceOrdinal = Number.isSafeInteger(ordinalTime.sourceOrdinal)
      ? ordinalTime.sourceOrdinal
      : "";
    return `order:${order}:source:${sourceTime}:ordinal:${sourceOrdinal}`;
  }
  if (typeof time === "number" && Number.isFinite(time)) return `time:${time}`;
  if (typeof time === "string") return `string:${time}`;

  const businessDay = businessDayOrder(time);
  if (businessDay !== null) {
    const day = objectRecord(time);
    if (!day) return null;
    return `day:${day.year}-${day.month}-${day.day}`;
  }
  return null;
}

/** Compare chart coordinates without coercing ordinal objects to numbers. */
export function compareChartTimes(left: ChartTime, right: ChartTime): number {
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

export function chartTimesEqual(
  left: ChartTime | null | undefined,
  right: ChartTime | null | undefined,
): boolean {
  if (left === right) return true;
  const leftKey = chartTimeKey(left);
  return leftKey !== null && leftKey === chartTimeKey(right);
}

export function sourceTimeFromChartTime(time: ChartTime | null | undefined): number | null {
  if (typeof time === "number" && Number.isFinite(time)) return time;
  if (ordinalOrder(time) === null) return null;
  const ordinalTime = objectRecord(time);
  if (!ordinalTime) return null;
  return typeof ordinalTime.sourceTime === "number" && Number.isFinite(ordinalTime.sourceTime)
    ? ordinalTime.sourceTime
    : null;
}
