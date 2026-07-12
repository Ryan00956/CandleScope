import {
  createDrawingLineageIndex,
  isDrawingLineageIndexForSeries,
} from "../features/chart-representation/drawingLineageIndex.js";

const PROJECTION_METADATA_KEY = "chartProjection";
const ordinalSeriesIndexCache = new WeakMap();
const drawingSeriesContextRegistry = new WeakMap();
const hydratedCoordinateSnapshotContexts = new WeakMap();

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isRegistryKey(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeProviderValue(provider, fallback = null) {
  if (typeof provider !== "function") return fallback;
  try {
    return provider();
  } catch {
    return fallback;
  }
}

function normalizeProjectionConfig(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectionConfigFromContext(context) {
  return normalizeProjectionConfig(
    context?.drawingProjectionConfig ?? context?.projectionConfig,
  );
}

/**
 * Associate a Lightweight Charts series with the stable display data and
 * source-domain metadata used by drawing primitives. Primitives only receive
 * the series instance from Lightweight Charts, so this registry is the bridge
 * back to the adapter-owned refs without coupling primitives to React state.
 */
export function registerDrawingSeriesContext(series, {
  seriesDataProvider = null,
  sourceTimeHorizonProvider = null,
  projectionConfigProvider = null,
  ordinalSeriesIndexProvider = null,
  coordinateSnapshotProvider = null,
} = {}) {
  if (!isRegistryKey(series)) return false;
  drawingSeriesContextRegistry.set(series, {
    projectionConfigProvider: typeof projectionConfigProvider === "function"
      ? projectionConfigProvider
      : null,
    ordinalSeriesIndexProvider: typeof ordinalSeriesIndexProvider === "function"
      ? ordinalSeriesIndexProvider
      : null,
    coordinateSnapshotProvider: typeof coordinateSnapshotProvider === "function"
      ? coordinateSnapshotProvider
      : null,
    seriesDataProvider: typeof seriesDataProvider === "function" ? seriesDataProvider : null,
    sourceTimeHorizonProvider: typeof sourceTimeHorizonProvider === "function"
      ? sourceTimeHorizonProvider
      : null,
  });
  return true;
}

function hydrateCoordinateContext(series, context) {
  const registration = isRegistryKey(series)
    ? drawingSeriesContextRegistry.get(series) || null
    : null;
  if (!context || typeof context !== "object" || !registration) return registration;

  let hasCoordinateSnapshot = hydratedCoordinateSnapshotContexts.get(context) === true;
  if (registration.coordinateSnapshotProvider
    && !hydratedCoordinateSnapshotContexts.has(context)) {
    const snapshot = safeProviderValue(registration.coordinateSnapshotProvider, null);
    if (Array.isArray(snapshot?.seriesData)) {
      hasCoordinateSnapshot = true;
      context.seriesData = snapshot.seriesData;
      context.drawingOrdinalSeriesIndex = snapshot.ordinalSeriesIndex || null;
      context.drawingOrdinalSeriesIndexRevision = snapshot.indexRevision ?? null;
    }
    hydratedCoordinateSnapshotContexts.set(context, hasCoordinateSnapshot);
  }
  if (registration.sourceTimeHorizonProvider) {
    context.sourceTimeHorizon = safeProviderValue(
      registration.sourceTimeHorizonProvider,
      null,
    );
  }
  if (registration.projectionConfigProvider) {
    context.drawingProjectionConfig = safeProviderValue(
      registration.projectionConfigProvider,
      null,
    );
  }
  if (!hasCoordinateSnapshot && registration.ordinalSeriesIndexProvider) {
    context.drawingOrdinalSeriesIndex = safeProviderValue(
      registration.ordinalSeriesIndexProvider,
      null,
    );
    delete context.drawingOrdinalSeriesIndexRevision;
  }
  return registration;
}

export function isOrdinalAxisTime(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger(value.order)
    && isFiniteNumber(value.sourceTime)
    && Number.isSafeInteger(value.sourceOrdinal)
    && value.sourceOrdinal >= 0;
}

function projectionMetadataFromRow(row) {
  const metadata = row?.customValues?.[PROJECTION_METADATA_KEY];
  return metadata && typeof metadata === "object" ? metadata : null;
}

function projectorIdFromRow(row) {
  const projectorId = projectionMetadataFromRow(row)?.projectorId;
  return typeof projectorId === "string" && projectorId.length > 0
    ? projectorId
    : null;
}

function sourceOrdinalFromRow(row) {
  if (isOrdinalAxisTime(row?.time)) return row.time.sourceOrdinal;
  const ordinal = projectionMetadataFromRow(row)?.sourceOrdinal;
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
}

function firstSeriesTime(seriesData) {
  if (!Array.isArray(seriesData)) return null;
  for (const row of seriesData) {
    if (row?.time != null) return row.time;
  }
  return null;
}

function firstOrdinalRow(seriesData) {
  if (!Array.isArray(seriesData)) return null;
  for (const row of seriesData) {
    if (row?.time != null) return isOrdinalAxisTime(row.time) ? row : null;
  }
  return null;
}

function usesOrdinalSeriesData(seriesData) {
  return isOrdinalAxisTime(firstSeriesTime(seriesData));
}

function firstRangeIndexWithToAtLeast(rowRanges, target) {
  let lo = 0;
  let hi = rowRanges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowRanges[mid].range.to < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstRangeIndexWithToGreaterThan(rowRanges, target, lo = 0) {
  let left = lo;
  let right = rowRanges.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (rowRanges[mid].range.to <= target) left = mid + 1;
    else right = mid;
  }
  return left;
}

function firstRangeIndexWithFromGreaterThan(rowRanges, target, lo = 0, hi = rowRanges.length) {
  let left = lo;
  let right = hi;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (rowRanges[mid].range.from <= target) left = mid + 1;
    else right = mid;
  }
  return left;
}

function resolveMonotonicSourceRange(rowRanges, target) {
  if (rowRanges.length === 0) return null;

  const firstToAtLeastTarget = firstRangeIndexWithToAtLeast(rowRanges, target);
  if (firstToAtLeastTarget < rowRanges.length
    && rowRanges[firstToAtLeastTarget].range.from <= target) {
    const containingTo = rowRanges[firstToAtLeastTarget].range.to;
    const endOfContainingTo = firstRangeIndexWithToGreaterThan(
      rowRanges,
      containingTo,
      firstToAtLeastTarget,
    );
    const firstFromAfterTarget = firstRangeIndexWithFromGreaterThan(
      rowRanges,
      target,
      firstToAtLeastTarget,
      endOfContainingTo,
    );
    // Match the legacy scan's tie-breaking: smallest containing `to`, then
    // greatest `from`, then the last row for an identical range.
    return rowRanges[firstFromAfterTarget - 1]?.row || null;
  }

  // The legacy scan prefers any predecessor over a future successor and uses
  // the last row when multiple ranges share the same predecessor `to`.
  if (firstToAtLeastTarget > 0) return rowRanges[firstToAtLeastTarget - 1].row;
  return null;
}

function resolveUnorderedSourceRange(rowRanges, target) {
  let containingRow = null;
  let containingTo = Number.POSITIVE_INFINITY;
  let containingFrom = Number.NEGATIVE_INFINITY;
  let predecessorRow = null;
  let predecessorTime = Number.NEGATIVE_INFINITY;

  for (const { row, range } of rowRanges) {
    if (range.from <= target && target <= range.to) {
      if (range.to < containingTo
        || (range.to === containingTo && range.from > containingFrom)
        || (range.to === containingTo && range.from === containingFrom)) {
        containingTo = range.to;
        containingFrom = range.from;
        containingRow = row;
      }
      continue;
    }
    if (range.to < target && range.to >= predecessorTime) {
      predecessorTime = range.to;
      predecessorRow = row;
    }
  }

  return containingRow || predecessorRow;
}

function getOrdinalSeriesIndex(seriesData, context = null) {
  if (!usesOrdinalSeriesData(seriesData)) return null;
  const contextIndex = context?.drawingOrdinalSeriesIndex;
  const contextRevisionMatches = !Object.prototype.hasOwnProperty.call(
    context || {},
    "drawingOrdinalSeriesIndexRevision",
  ) || context.drawingOrdinalSeriesIndexRevision === contextIndex?.revision;
  if (isDrawingLineageIndexForSeries(
    contextIndex,
    seriesData,
  ) && contextRevisionMatches) {
    if (context) context.drawingOrdinalSeriesData = seriesData;
    return contextIndex;
  }
  if (context?.drawingOrdinalSeriesData === seriesData
    && isDrawingLineageIndexForSeries(contextIndex, seriesData)
    && contextRevisionMatches) {
    return contextIndex;
  }

  const firstRow = seriesData[0] || null;
  const lastRow = seriesData[seriesData.length - 1] || null;
  const cached = ordinalSeriesIndexCache.get(seriesData);
  if (cached
    && cached.length === seriesData.length
    && cached.firstRow === firstRow
    && cached.firstTime === firstRow?.time
    && cached.lastRow === lastRow
    && cached.lastTime === lastRow?.time) {
    if (context) {
      context.drawingOrdinalSeriesData = seriesData;
      context.drawingOrdinalSeriesIndex = cached.index;
      delete context.drawingOrdinalSeriesIndexRevision;
    }
    return cached.index;
  }

  const index = createDrawingLineageIndex(seriesData);
  // ProjectionStore replaces the display array for structural and tail
  // changes; its provisional overlay also changes the array edge. Keep a
  // first/last identity guard for callers that retain the same array object.
  ordinalSeriesIndexCache.set(seriesData, {
    firstRow,
    firstTime: firstRow?.time,
    index,
    lastRow,
    lastTime: lastRow?.time,
    length: seriesData.length,
  });
  if (context) {
    context.drawingOrdinalSeriesData = seriesData;
    context.drawingOrdinalSeriesIndex = index;
    delete context.drawingOrdinalSeriesIndexRevision;
  }
  return index;
}

/**
 * Convert a chart-library axis item into a persistence-safe drawing anchor.
 * Projection-local `order` is deliberately discarded because structural
 * reprojections may assign that coordinate to different source lineage.
 */
export function drawingAnchorFromAxisTime(axisTime, seriesData = [], context = null) {
  if (isFiniteNumber(axisTime)) return { time: axisTime };
  if (!isOrdinalAxisTime(axisTime)) return null;

  const anchor = {
    time: axisTime.sourceTime,
    sourceOrdinal: axisTime.sourceOrdinal,
  };
  const projectorId = projectorIdFromRow(firstOrdinalRow(seriesData));
  if (projectorId) anchor.sourceProjection = projectorId;
  const projectionConfig = projectionConfigFromContext(context);
  if (projectionConfig) anchor.sourceProjectionConfig = projectionConfig;
  return anchor;
}

function normalizeDrawingAnchor(anchor, seriesData, context) {
  if (!anchor || typeof anchor !== "object") return null;
  if (isOrdinalAxisTime(anchor.time)) {
    return drawingAnchorFromAxisTime(anchor.time, seriesData, context);
  }
  if (!isFiniteNumber(anchor.time)) return null;
  return {
    time: anchor.time,
    ...(Number.isSafeInteger(anchor.sourceOrdinal) && anchor.sourceOrdinal >= 0
      ? { sourceOrdinal: anchor.sourceOrdinal }
      : {}),
    ...(typeof anchor.sourceProjection === "string" && anchor.sourceProjection.length > 0
      ? { sourceProjection: anchor.sourceProjection }
      : {}),
    ...(normalizeProjectionConfig(anchor.sourceProjectionConfig)
      ? { sourceProjectionConfig: anchor.sourceProjectionConfig }
      : {}),
  };
}

/**
 * Resolve a stable source drawing anchor against the current derived display.
 * Source lineage, not projection-local order, is authoritative. A source time
 * beyond the latest raw source horizon is intentionally unresolved so future
 * drawings cannot silently become relative logical anchors. When raw coverage
 * is unavailable, displayed lineage remains the conservative boundary.
 */
export function resolveDrawingAnchorToDisplayRow(seriesData, anchor, context = null) {
  if (!Array.isArray(seriesData) || seriesData.length === 0) return null;
  const normalized = normalizeDrawingAnchor(anchor, seriesData, context);
  if (!normalized) return null;

  const ordinalIndex = getOrdinalSeriesIndex(seriesData, context);
  if (!ordinalIndex) {
    return seriesData.find((row) => row?.time === normalized.time) || null;
  }

  const {
    currentProjection,
    exactRowsBySourceTime,
    latestLineage,
    rowRanges,
    rowRangesMonotonic,
  } = ordinalIndex;
  const sourceTimeHorizon = isFiniteNumber(context?.sourceTimeHorizon)
    ? context.sourceTimeHorizon
    : null;
  if (sourceTimeHorizon !== null) {
    if (normalized.time > sourceTimeHorizon) return null;
  } else if (!Number.isFinite(latestLineage) || normalized.time > latestLineage) {
    // Without a raw-source horizon, keep the conservative historical behavior:
    // display lineage is the only evidence that this source time exists.
    return null;
  }

  const canUseSourceOrdinal = Number.isSafeInteger(normalized.sourceOrdinal)
    && normalized.sourceProjection === currentProjection
    && normalizeProjectionConfig(normalized.sourceProjectionConfig) !== null
    && normalized.sourceProjectionConfig
      === projectionConfigFromContext(context);

  let lastExactSourceRow = null;
  let exactOrdinalRow = null;
  let predecessorOrdinalRow = null;
  let predecessorOrdinal = Number.NEGATIVE_INFINITY;
  let successorOrdinalRow = null;
  let successorOrdinal = Number.POSITIVE_INFINITY;

  for (const row of exactRowsBySourceTime.get(normalized.time) || []) {
    lastExactSourceRow = row;
    if (!canUseSourceOrdinal) continue;

    const rowOrdinal = sourceOrdinalFromRow(row);
    if (rowOrdinal === null) continue;
    if (rowOrdinal === normalized.sourceOrdinal) {
      exactOrdinalRow = row;
    } else if (rowOrdinal < normalized.sourceOrdinal && rowOrdinal >= predecessorOrdinal) {
      predecessorOrdinal = rowOrdinal;
      predecessorOrdinalRow = row;
    } else if (rowOrdinal > normalized.sourceOrdinal && rowOrdinal < successorOrdinal) {
      successorOrdinal = rowOrdinal;
      successorOrdinalRow = row;
    }
  }

  if (exactOrdinalRow) return exactOrdinalRow;
  if (predecessorOrdinalRow) return predecessorOrdinalRow;
  if (successorOrdinalRow) return successorOrdinalRow;
  if (lastExactSourceRow) return lastExactSourceRow;

  return rowRangesMonotonic
    ? resolveMonotonicSourceRange(rowRanges, normalized.time)
    : resolveUnorderedSourceRange(rowRanges, normalized.time);
}

function getCachedSeriesData(series, context) {
  const registration = hydrateCoordinateContext(series, context);
  if (context && Object.prototype.hasOwnProperty.call(context, "seriesData")) {
    return context.seriesData;
  }

  let data = safeProviderValue(registration?.seriesDataProvider, null);
  if (!Array.isArray(data)) {
    try {
      data = series?.data?.() || [];
    } catch {
      data = [];
    }
  }

  if (context) {
    context.seriesData = data;
  }

  return data;
}

export function timeToCoordinateInterpolated(chart, series, timestamp, context) {
  if (!chart || !series || timestamp == null) return null;

  const timeScale = chart.timeScale();
  const coordinateContext = context || {};
  const data = getCachedSeriesData(series, coordinateContext);

  if (usesOrdinalSeriesData(data)) {
    const anchor = isOrdinalAxisTime(timestamp)
      ? drawingAnchorFromAxisTime(timestamp, data, coordinateContext)
      : { time: timestamp };
    const row = resolveDrawingAnchorToDisplayRow(data, anchor, coordinateContext);
    if (!row) return null;
    try {
      const x = timeScale.timeToCoordinate(row.time);
      return isFiniteNumber(x) ? x : null;
    } catch {
      return null;
    }
  }

  try {
    const exact = timeScale.timeToCoordinate(timestamp);
    if (exact != null && isFinite(exact)) return exact;
  } catch {
    // Fall through to interpolation.
  }

  if (!data || data.length === 0 || !isFiniteNumber(timestamp)) return null;

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

export function dataPointToCoordinate(chart, series, dataPoint, context) {
  if (!chart || !series || !dataPoint) return null;

  const timeScale = chart.timeScale();
  const coordinateContext = context || {};
  const data = getCachedSeriesData(series, coordinateContext);

  if (usesOrdinalSeriesData(data)) {
    const row = resolveDrawingAnchorToDisplayRow(data, dataPoint, coordinateContext);
    if (!row) return null;
    try {
      const x = timeScale.timeToCoordinate(row.time);
      return isFiniteNumber(x) ? x : null;
    } catch {
      return null;
    }
  }

  if (dataPoint.time != null) {
    let x = null;
    try {
      x = timeScale.timeToCoordinate(dataPoint.time);
    } catch {
      x = null;
    }
    if (!isFiniteNumber(x)) {
      x = timeToCoordinateInterpolated(chart, series, dataPoint.time, coordinateContext);
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

export function logicalToInterpolatedSeriesTime(adapter, logicalIndex) {
  if (!adapter?.isReady?.() || logicalIndex == null || !isFinite(logicalIndex)) return null;

  const seriesData = adapter.getSeriesData?.();
  if (!seriesData || seriesData.length === 0) return null;
  if (usesOrdinalSeriesData(seriesData)) return null;

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
