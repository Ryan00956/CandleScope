const INDICATOR_RANGE_REQUEST_MAX_BARS = 5_000;

export function requestIndicatorRangeInChunks(requestRange, start, end, intervalSeconds) {
  if (typeof requestRange !== "function") return;
  const startSec = Math.floor(Number(start));
  const endSec = Math.floor(Number(end));
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0 || startSec > endSec) {
    return;
  }
  if (!intervalSeconds || intervalSeconds <= 0) {
    requestRange(startSec, endSec);
    return;
  }

  const chunkSpan = (INDICATOR_RANGE_REQUEST_MAX_BARS - 1) * intervalSeconds;
  for (let chunkStart = startSec; chunkStart <= endSec; chunkStart += INDICATOR_RANGE_REQUEST_MAX_BARS * intervalSeconds) {
    const chunkEnd = Math.min(endSec, chunkStart + chunkSpan);
    requestRange(chunkStart, chunkEnd);
  }
}
