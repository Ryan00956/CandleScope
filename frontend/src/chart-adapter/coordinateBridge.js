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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function getSeriesData(series) {
  try {
    return series?.data?.() || [];
  } catch {
    return [];
  }
}

function getLastSeriesLogical(chart, series) {
  if (!chart || !series) return null;
  const data = getSeriesData(series);
  if (!data.length) return null;

  const last = data[data.length - 1];
  if (last?.time == null) return null;

  const timeScale = chart.timeScale();
  try {
    const x = timeScale.timeToCoordinate(last.time);
    if (isFiniteNumber(x)) {
      const logical = timeScale.coordinateToLogical(x);
      if (isFiniteNumber(logical)) return logical;
    }
  } catch {
    // Fall back to the data index below.
  }

  return data.length - 1;
}

export function barOffsetFromLastToCoordinate(chart, series, barOffsetFromLast) {
  if (!isFiniteNumber(barOffsetFromLast)) return null;
  const lastLogical = getLastSeriesLogical(chart, series);
  if (!isFiniteNumber(lastLogical)) return null;
  return logicalToCoordinateInterpolated(chart?.timeScale?.(), lastLogical + barOffsetFromLast);
}

export function dataPointToCoordinate(chart, series, dataPoint) {
  if (!chart || !series || !dataPoint) return null;

  if (isFiniteNumber(dataPoint.barOffsetFromLast)) {
    const offsetX = barOffsetFromLastToCoordinate(chart, series, dataPoint.barOffsetFromLast);
    if (isFiniteNumber(offsetX)) return offsetX;
  }

  const timeScale = chart.timeScale();
  if (dataPoint.time != null) {
    let x = timeScale.timeToCoordinate(dataPoint.time);
    if (!isFiniteNumber(x)) {
      x = timeToCoordinateInterpolated(chart, series, dataPoint.time);
    }
    if (isFiniteNumber(x)) return x;
  }

  if (isFiniteNumber(dataPoint.logical)) {
    const x = logicalToCoordinateInterpolated(timeScale, dataPoint.logical);
    if (isFiniteNumber(x)) return x;
  }

  return null;
}

export function coordinateToFractionalLogical(adapter, x) {
  if (!adapter?.isReady?.()) return null;

  const intLogical = adapter.coordinateToLogical?.(x);
  if (intLogical == null || !isFinite(intLogical)) return null;

  let fracLogical = intLogical;
  const x0 = adapter.logicalToCoordinate?.(intLogical);
  if (x0 != null && isFinite(x0)) {
    const xRight = adapter.logicalToCoordinate?.(intLogical + 1);
    if (xRight != null && isFinite(xRight) && xRight !== x0) {
      fracLogical = intLogical + (x - x0) / (xRight - x0);
    }
  }

  return fracLogical;
}

export function lastBarLogicalFromAdapter(adapter) {
  if (!adapter?.isReady?.()) return null;

  const direct = adapter.getLastBarLogical?.();
  if (isFiniteNumber(direct)) return direct;

  const seriesData = adapter.getSeriesData?.();
  if (!seriesData?.length) return null;
  const lastTime = seriesData[seriesData.length - 1]?.time;
  if (lastTime == null) return null;

  const lastX = adapter.timeToCoordinate?.(lastTime);
  if (isFiniteNumber(lastX)) {
    const logical = adapter.coordinateToLogical?.(lastX);
    if (isFiniteNumber(logical)) return logical;
  }

  return seriesData.length - 1;
}

export function futureBarOffsetFromLogical(adapter, logicalIndex) {
  if (!isFiniteNumber(logicalIndex)) return null;
  const lastLogical = lastBarLogicalFromAdapter(adapter);
  if (!isFiniteNumber(lastLogical) || logicalIndex <= lastLogical) return null;
  return Math.max(1, Math.round(logicalIndex - lastLogical));
}

export function logicalToInterpolatedSeriesTime(adapter, logicalIndex) {
  if (!adapter?.isReady?.() || logicalIndex == null || !isFinite(logicalIndex)) return null;

  const seriesData = adapter.getSeriesData?.();
  if (!seriesData || seriesData.length === 0) return null;

  let dataIndex = logicalIndex;
  const firstTime = seriesData[0]?.time;
  const firstCoord = firstTime == null ? null : adapter.timeToCoordinate?.(firstTime);
  const firstLogical = firstCoord == null || !isFinite(firstCoord)
    ? null
    : adapter.coordinateToLogical?.(firstCoord);
  if (firstLogical != null && isFinite(firstLogical)) {
    dataIndex = logicalIndex - firstLogical;
  }

  const floorIdx = Math.floor(dataIndex);
  const frac = dataIndex - floorIdx;

  if (floorIdx < 0) {
    if (seriesData.length >= 2) {
      const dt = seriesData[1].time - seriesData[0].time;
      return seriesData[0].time + dataIndex * dt;
    }
    return seriesData[0].time;
  }

  if (floorIdx >= seriesData.length - 1) {
    if (seriesData.length >= 2) {
      const dt = seriesData[seriesData.length - 1].time - seriesData[seriesData.length - 2].time;
      return seriesData[seriesData.length - 1].time + (dataIndex - (seriesData.length - 1)) * dt;
    }
    return seriesData[seriesData.length - 1].time;
  }

  const tA = seriesData[floorIdx].time;
  const tB = seriesData[floorIdx + 1].time;
  return tA + frac * (tB - tA);
}

export function logicalToCoordinateInterpolated(timeScale, logical) {
  if (!timeScale || logical == null || !isFinite(logical)) return null;

  const leftLogical = Math.floor(logical);
  const fraction = logical - leftLogical;

  const xLeft = timeScale.logicalToCoordinate(leftLogical);
  if (xLeft == null || !isFinite(xLeft)) return null;
  if (fraction === 0) return xLeft;

  const xRight = timeScale.logicalToCoordinate(leftLogical + 1);
  if (xRight == null || !isFinite(xRight)) return null;

  return xLeft + fraction * (xRight - xLeft);
}
