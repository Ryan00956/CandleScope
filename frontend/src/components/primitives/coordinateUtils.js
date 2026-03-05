/**
 * coordinateUtils.js — Shared coordinate interpolation helpers for drawing primitives.
 *
 * When drawings store timestamps as continuous (non-snapped) values,
 * Lightweight Charts' built-in `timeToCoordinate()` will return null
 * because it only recognises exact candle timestamps. These helpers
 * perform binary-search + linear interpolation against the current
 * series data so that any arbitrary timestamp can be mapped to a
 * screen x-coordinate — and vice-versa.
 */

/**
 * Convert an arbitrary Unix timestamp (seconds) to a screen x-coordinate
 * by interpolating between the two bracketing candles in the series data.
 *
 * @param {object} chart      - Lightweight Charts IChartApi
 * @param {object} series     - Lightweight Charts ISeriesApi
 * @param {number} timestamp  - Unix timestamp in seconds (may be fractional / between candles)
 * @returns {number|null}     - Screen x-coordinate, or null if conversion fails
 */
export function timeToCoordinateInterpolated(chart, series, timestamp) {
  if (!chart || !series || timestamp == null) return null;

  const timeScale = chart.timeScale();

  // Fast path: exact match
  try {
    const exact = timeScale.timeToCoordinate(timestamp);
    if (exact != null && isFinite(exact)) return exact;
  } catch {
    // fall through to interpolation
  }

  // Get the series data for interpolation
  let data;
  try {
    data = series.data();
  } catch {
    return null;
  }
  if (!data || data.length === 0) return null;

  // Binary search for the two candles that bracket `timestamp`
  let lo = 0;
  let hi = data.length - 1;

  // Edge cases: timestamp is outside the data range
  if (timestamp <= data[lo].time) {
    // Extrapolate before the first candle
    if (data.length < 2) {
      return timeScale.timeToCoordinate(data[0].time);
    }
    const x0 = timeScale.timeToCoordinate(data[0].time);
    const x1 = timeScale.timeToCoordinate(data[1].time);
    if (x0 == null || x1 == null) return null;
    const dt = data[1].time - data[0].time;
    if (dt === 0) return x0;
    const frac = (timestamp - data[0].time) / dt;
    return x0 + frac * (x1 - x0);
  }

  if (timestamp >= data[hi].time) {
    // Extrapolate after the last candle
    if (data.length < 2) {
      return timeScale.timeToCoordinate(data[hi].time);
    }
    const xPrev = timeScale.timeToCoordinate(data[hi - 1].time);
    const xLast = timeScale.timeToCoordinate(data[hi].time);
    if (xPrev == null || xLast == null) return null;
    const dt = data[hi].time - data[hi - 1].time;
    if (dt === 0) return xLast;
    const frac = (timestamp - data[hi - 1].time) / dt;
    return xPrev + frac * (xLast - xPrev);
  }

  // Standard binary search: find `lo` such that data[lo].time <= timestamp < data[lo+1].time
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time <= timestamp) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const tA = data[lo].time;
  const tB = data[hi].time;
  const xA = timeScale.timeToCoordinate(tA);
  const xB = timeScale.timeToCoordinate(tB);

  if (xA == null || xB == null) return null;

  const dt = tB - tA;
  if (dt === 0) return xA;

  const frac = (timestamp - tA) / dt;
  return xA + frac * (xB - xA);
}
