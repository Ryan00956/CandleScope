export function timeToCoordinateInterpolated(chart, series, timestamp) {
  if (!chart || !series || timestamp == null) return null;

  const timeScale = chart.timeScale();

  try {
    const exact = timeScale.timeToCoordinate(timestamp);
    if (exact != null && isFinite(exact)) return exact;
  } catch {
    // Fall through to interpolation.
  }

  let data;
  try {
    data = series.data();
  } catch {
    return null;
  }
  if (!data || data.length === 0) return null;

  let lo = 0;
  let hi = data.length - 1;

  if (timestamp <= data[lo].time) {
    if (data.length < 2) return timeScale.timeToCoordinate(data[0].time);
    const x0 = timeScale.timeToCoordinate(data[0].time);
    const x1 = timeScale.timeToCoordinate(data[1].time);
    if (x0 == null || x1 == null) return null;
    const dt = data[1].time - data[0].time;
    if (dt === 0) return x0;
    return x0 + ((timestamp - data[0].time) / dt) * (x1 - x0);
  }

  if (timestamp >= data[hi].time) {
    if (data.length < 2) return timeScale.timeToCoordinate(data[hi].time);
    const xPrev = timeScale.timeToCoordinate(data[hi - 1].time);
    const xLast = timeScale.timeToCoordinate(data[hi].time);
    if (xPrev == null || xLast == null) return null;
    const dt = data[hi].time - data[hi - 1].time;
    if (dt === 0) return xLast;
    return xPrev + ((timestamp - data[hi - 1].time) / dt) * (xLast - xPrev);
  }

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time <= timestamp) lo = mid;
    else hi = mid;
  }

  const tA = data[lo].time;
  const tB = data[hi].time;
  const xA = timeScale.timeToCoordinate(tA);
  const xB = timeScale.timeToCoordinate(tB);
  if (xA == null || xB == null) return null;

  const dt = tB - tA;
  if (dt === 0) return xA;
  return xA + ((timestamp - tA) / dt) * (xB - xA);
}