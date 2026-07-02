export function requestIndicatorRangeInChunks(requestRange, start, end) {
  if (typeof requestRange !== "function") return;
  const startSec = Math.floor(Number(start));
  const endSec = Math.floor(Number(end));
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0 || startSec > endSec) {
    return;
  }
  requestRange(startSec, endSec);
}
