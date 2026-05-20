export function numericRange(start, end) {
  const startValue = Number(start);
  const endValue = Number(end);
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  if (endValue < startValue) return null;
  return { start: startValue, end: endValue };
}

export function eventRangeFromDetail(detail = {}) {
  return numericRange(
    detail.request_start_ms ?? detail.range_start_ms,
    detail.request_end_ms ?? detail.range_end_ms,
  );
}

export function rowRangeMs(rows) {
  if (!rows?.length) return null;
  const times = rows
    .map((row) => Number(row?.time))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return null;
  return {
    start: Math.min(...times) * 1000,
    end: Math.max(...times) * 1000,
  };
}

export function rangesOverlap(a, b) {
  if (!a || !b) return false;
  return a.start <= b.end && b.start <= a.end;
}

export function rangeCovers(container, target, toleranceMs = 0) {
  if (!container || !target) return false;
  return (
    container.start <= target.start + toleranceMs &&
    container.end >= target.end - toleranceMs
  );
}

export function isSameSeries(a, b) {
  if (!a || !b) return false;
  return (
    String(a.exchange || "").toLowerCase() === String(b.exchange || "").toLowerCase() &&
    String(a.marketType || "").toLowerCase() === String(b.marketType || "").toLowerCase() &&
    String(a.symbol || "").toUpperCase() === String(b.symbol || "").toUpperCase() &&
    a.interval === b.interval
  );
}
