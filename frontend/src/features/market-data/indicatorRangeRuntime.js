export function requestIndicatorRangeInChunks(requestRange, start, end) {
  if (typeof requestRange !== "function") return;
  const startSec = Math.floor(Number(start));
  const endSec = Math.floor(Number(end));
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0 || startSec > endSec) {
    return;
  }
  requestRange(startSec, endSec);
}

export function resolveIndicatorRangeFromWindowMeta(meta = {}) {
  const type = meta?.windowDeltaType;
  if (type !== "prepend" && type !== "mid-merge") return null;
  const start = Math.floor(Number(meta.incomingFirstTime));
  const end = Math.floor(Number(meta.incomingLastTime));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) {
    return null;
  }
  return { start, end, reason: `window-${type}` };
}

export function requestIndicatorRangeForWindowMeta(requestRange, meta = {}) {
  const range = resolveIndicatorRangeFromWindowMeta(meta);
  if (!range) return false;
  requestIndicatorRangeInChunks(requestRange, range.start, range.end);
  return true;
}
