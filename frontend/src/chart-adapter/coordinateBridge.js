import {
  createDrawingLineageIndex,
  isDrawingLineageIndexForSeries,
} from "../features/chart-representation/drawingLineageIndex.js";

const PROJECTION_METADATA_KEY = "chartProjection";
const ordinalSeriesIndexCache = new WeakMap();
const drawingSeriesContextRegistry = new WeakMap();
const hydratedCoordinateSnapshotContexts = new WeakMap();
const numericSeriesBoundsContexts = new WeakMap();
const ordinalFutureBasisContexts = new WeakMap();
const ordinalFutureBasisTransactions = new WeakSet();
const MAX_FREEHAND_CAPTURE_BATCH_POINTS = 4_096;

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
 * Create a short-lived context for resolving one primitive path. Future-basis
 * memoization is deliberately limited to this transaction so zoom/pan changes
 * can never reuse viewport coordinates from an older render.
 */
export function createDrawingCoordinateTransactionContext(context = null) {
  const transaction = context && typeof context === "object" ? { ...context } : {};
  ordinalFutureBasisTransactions.add(transaction);
  return transaction;
}

function numericSeriesBounds(seriesData, context) {
  if (!Array.isArray(seriesData) || !context || typeof context !== "object") return null;
  const cached = numericSeriesBoundsContexts.get(context);
  if (cached?.seriesData === seriesData) return cached.bounds;

  let firstTime = null;
  let lastTime = null;
  for (const row of seriesData) {
    if (!isFiniteNumber(row?.time)) continue;
    if (firstTime === null) firstTime = row.time;
    lastTime = row.time;
  }
  const bounds = firstTime !== null && lastTime !== null && firstTime <= lastTime
    ? { firstTime, lastTime }
    : null;
  numericSeriesBoundsContexts.set(context, { bounds, seriesData });
  return bounds;
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
  sourceIntervalProvider = null,
  sourceIntervalSecondsProvider = null,
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
    sourceIntervalProvider: typeof sourceIntervalProvider === "function"
      ? sourceIntervalProvider
      : null,
    sourceIntervalSecondsProvider: typeof sourceIntervalSecondsProvider === "function"
      ? sourceIntervalSecondsProvider
      : null,
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

  const owns = (field) => Object.prototype.hasOwnProperty.call(context, field);
  const hasOwnCoordinateSnapshot = owns("seriesData")
    || owns("drawingOrdinalSeriesIndex")
    || owns("drawingOrdinalSeriesIndexRevision");
  let hasCoordinateSnapshot = hasOwnCoordinateSnapshot
    || hydratedCoordinateSnapshotContexts.get(context) === true;
  if (registration.coordinateSnapshotProvider
    && !hasOwnCoordinateSnapshot
    && !hydratedCoordinateSnapshotContexts.has(context)) {
    const snapshot = safeProviderValue(registration.coordinateSnapshotProvider, null);
    if (Array.isArray(snapshot?.seriesData)) {
      hasCoordinateSnapshot = true;
      context.seriesData = snapshot.seriesData;
      context.drawingOrdinalSeriesIndex = snapshot.ordinalSeriesIndex || null;
      context.drawingOrdinalSeriesIndexRevision = snapshot.indexRevision ?? null;
      if (Object.prototype.hasOwnProperty.call(snapshot, "sourceTimeHorizon")) {
        context.sourceTimeHorizon = snapshot.sourceTimeHorizon;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "sourceInterval")) {
        context.sourceInterval = snapshot.sourceInterval;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "sourceIntervalSeconds")) {
        context.sourceIntervalSeconds = snapshot.sourceIntervalSeconds;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "drawingProjectionConfig")) {
        context.drawingProjectionConfig = snapshot.drawingProjectionConfig;
      }
    }
    hydratedCoordinateSnapshotContexts.set(context, hasCoordinateSnapshot);
  }
  if (registration.sourceTimeHorizonProvider && !owns("sourceTimeHorizon")) {
    context.sourceTimeHorizon = safeProviderValue(
      registration.sourceTimeHorizonProvider,
      null,
    );
  }
  if (registration.sourceIntervalSecondsProvider && !owns("sourceIntervalSeconds")) {
    context.sourceIntervalSeconds = safeProviderValue(
      registration.sourceIntervalSecondsProvider,
      null,
    );
  }
  if (registration.sourceIntervalProvider && !owns("sourceInterval")) {
    context.sourceInterval = safeProviderValue(
      registration.sourceIntervalProvider,
      null,
    );
  }
  if (registration.projectionConfigProvider && !owns("drawingProjectionConfig")) {
    context.drawingProjectionConfig = safeProviderValue(
      registration.projectionConfigProvider,
      null,
    );
  }
  if (!hasCoordinateSnapshot
    && !owns("drawingOrdinalSeriesIndex")
    && registration.ordinalSeriesIndexProvider) {
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

function exactOrdinalRow(ordinalIndex, anchor) {
  if (!Number.isFinite(anchor?.time)
    || !Number.isSafeInteger(anchor?.sourceOrdinal)
    || anchor.sourceOrdinal < 0) {
    return null;
  }
  for (const row of ordinalIndex?.exactRowsBySourceTime?.get(anchor.time) || []) {
    if (sourceOrdinalFromRow(row) === anchor.sourceOrdinal) return row;
  }
  return null;
}

function compareSourceAnchors(left, right) {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.sourceOrdinal === right.sourceOrdinal) return 0;
  return left.sourceOrdinal < right.sourceOrdinal ? -1 : 1;
}

function persistenceSafeProjectionId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function persistenceSafeProjectionConfig(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
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

function isSafeTimeMagnitude(value) {
  return isFiniteNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function calendarMonthInterval(value) {
  if (typeof value !== "string") return { matched: false, months: null };
  const normalized = value.trim();
  if (!normalized.endsWith("M")) return { matched: false, months: null };
  const match = /^([1-9]\d*)M$/.exec(normalized);
  if (!match) return { matched: true, months: null };
  const months = Number(match[1]);
  return {
    matched: true,
    months: Number.isSafeInteger(months) ? months : null,
  };
}

function utcDateParts(time) {
  if (!isSafeTimeMagnitude(time)) return null;
  const milliseconds = time * 1_000;
  if (!isFiniteNumber(milliseconds)) return null;
  const date = new Date(milliseconds);
  const clippedMilliseconds = date.getTime();
  if (!isFiniteNumber(clippedMilliseconds)) return null;
  return {
    date,
    subMillisecond: milliseconds - clippedMilliseconds,
  };
}

function addUtcCalendarMonths(time, months) {
  if (!Number.isSafeInteger(months) || months < 0) return null;
  const source = utcDateParts(time);
  if (!source) return null;

  const day = source.date.getUTCDate();
  const target = new Date(source.date.getTime());
  target.setUTCDate(1);
  target.setUTCFullYear(
    target.getUTCFullYear(),
    target.getUTCMonth() + months,
    1,
  );
  if (!isFiniteNumber(target.getTime())) return null;

  const lastDay = new Date(target.getTime());
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  if (!isFiniteNumber(lastDay.getTime())) return null;
  target.setUTCDate(Math.min(day, lastDay.getUTCDate()));

  const result = (target.getTime() + source.subMillisecond) / 1_000;
  return isSafeTimeMagnitude(result) ? result : null;
}

function calendarBoundaryTime(horizon, monthsPerCell, cell) {
  if (!Number.isSafeInteger(monthsPerCell)
    || monthsPerCell < 1
    || !Number.isSafeInteger(cell)
    || cell < 0) {
    return null;
  }
  const monthOffset = monthsPerCell * cell;
  return Number.isSafeInteger(monthOffset)
    ? addUtcCalendarMonths(horizon, monthOffset)
    : null;
}

function calendarFutureTime(horizon, monthsPerCell, cellDistance) {
  if (!isFiniteNumber(cellDistance) || cellDistance <= 0) return null;
  const wholeCells = Math.floor(cellDistance);
  if (!Number.isSafeInteger(wholeCells) || wholeCells < 0) return null;
  const lower = calendarBoundaryTime(horizon, monthsPerCell, wholeCells);
  if (lower === null) return null;

  const fraction = cellDistance - wholeCells;
  if (fraction === 0) return lower;
  const upper = calendarBoundaryTime(horizon, monthsPerCell, wholeCells + 1);
  if (upper === null || upper <= lower) return null;
  const time = lower + (upper - lower) * fraction;
  return isSafeTimeMagnitude(time) ? time : null;
}

function calendarFutureCellDistance(horizon, monthsPerCell, time) {
  if (!isSafeTimeMagnitude(time) || time <= horizon) return null;
  const start = utcDateParts(horizon);
  const target = utcDateParts(time);
  if (!start || !target) return null;

  const monthDelta = (target.date.getUTCFullYear() - start.date.getUTCFullYear()) * 12
    + target.date.getUTCMonth() - start.date.getUTCMonth();
  if (!Number.isSafeInteger(monthDelta)) return null;
  let wholeCells = Math.max(0, Math.floor(monthDelta / monthsPerCell));
  let lower = calendarBoundaryTime(horizon, monthsPerCell, wholeCells);
  if (lower === null) return null;

  // Month-end clamping can put the calendar estimate one cell on either side.
  if (lower > time && wholeCells > 0) {
    wholeCells -= 1;
    lower = calendarBoundaryTime(horizon, monthsPerCell, wholeCells);
    if (lower === null) return null;
  }
  let upper = calendarBoundaryTime(horizon, monthsPerCell, wholeCells + 1);
  if (upper === null) return null;
  if (upper <= time) {
    wholeCells += 1;
    lower = upper;
    upper = calendarBoundaryTime(horizon, monthsPerCell, wholeCells + 1);
    if (upper === null) return null;
  }
  if (lower > time || upper <= lower || time >= upper) return null;

  const fraction = (time - lower) / (upper - lower);
  const distance = wholeCells + fraction;
  return isFiniteNumber(distance) && distance > 0 ? distance : null;
}

function ordinalCellWidth(timeScale, tailX) {
  let logical = null;
  try {
    logical = timeScale.coordinateToLogical?.(tailX);
  } catch {
    logical = null;
  }
  if (isFiniteNumber(logical)) {
    let center = null;
    let next = null;
    let previous = null;
    try {
      center = timeScale.logicalToCoordinate?.(logical);
      next = timeScale.logicalToCoordinate?.(logical + 1);
      previous = timeScale.logicalToCoordinate?.(logical - 1);
    } catch {
      center = null;
      next = null;
      previous = null;
    }
    const rightWidth = isFiniteNumber(center) && isFiniteNumber(next)
      ? next - center
      : null;
    if (isFiniteNumber(rightWidth) && rightWidth > 0) return rightWidth;
    const leftWidth = isFiniteNumber(center) && isFiniteNumber(previous)
      ? center - previous
      : null;
    if (isFiniteNumber(leftWidth) && leftWidth > 0) return leftWidth;
  }

  let barSpacing = null;
  try {
    barSpacing = timeScale.options?.().barSpacing;
  } catch {
    barSpacing = null;
  }
  return isFiniteNumber(barSpacing) && barSpacing > 0 ? barSpacing : null;
}

function ordinalFutureCoordinateBasis(timeScale, seriesData, context, ordinalIndex = null) {
  const index = ordinalIndex || getOrdinalSeriesIndex(seriesData, context);
  const tailRow = index?.ordinalRows?.[index.ordinalRows.length - 1] || null;
  const horizon = context?.sourceTimeHorizon;
  const step = context?.sourceIntervalSeconds;
  const calendarInterval = calendarMonthInterval(context?.sourceInterval);
  if (!tailRow
    || !isSafeTimeMagnitude(horizon)
    || (calendarInterval.matched && calendarInterval.months === null)
    || (!calendarInterval.matched && (!isFiniteNumber(step) || step <= 0))) {
    return null;
  }

  let tailX = null;
  try {
    tailX = timeScale.timeToCoordinate(tailRow.time);
  } catch {
    tailX = null;
  }
  if (!isFiniteNumber(tailX)) return null;
  const cellWidth = ordinalCellWidth(timeScale, tailX);
  return isFiniteNumber(cellWidth) && cellWidth > 0
    ? {
        calendarMonths: calendarInterval.months,
        cellWidth,
        horizon,
        index,
        step,
        tailRow,
        tailX,
      }
    : null;
}

function cachedOrdinalFutureCoordinateBasis(
  timeScale,
  seriesData,
  context,
  ordinalIndex = null,
) {
  const canCache = context
    && typeof context === "object"
    && ordinalFutureBasisTransactions.has(context);
  if (canCache) {
    const cached = ordinalFutureBasisContexts.get(context);
    if (cached
      && cached.timeScale === timeScale
      && cached.seriesData === seriesData
      && cached.sourceTimeHorizon === context.sourceTimeHorizon
      && cached.sourceInterval === context.sourceInterval
      && cached.sourceIntervalSeconds === context.sourceIntervalSeconds
      && (!ordinalIndex || cached.ordinalIndex === ordinalIndex)) {
      return cached.basis;
    }
  }

  const basis = ordinalFutureCoordinateBasis(timeScale, seriesData, context, ordinalIndex);
  if (canCache) {
    ordinalFutureBasisContexts.set(context, {
      basis,
      ordinalIndex: ordinalIndex || basis?.index || null,
      seriesData,
      sourceInterval: context.sourceInterval,
      sourceIntervalSeconds: context.sourceIntervalSeconds,
      sourceTimeHorizon: context.sourceTimeHorizon,
      timeScale,
    });
  }
  return basis;
}

function futureTimeFromCellDistance(basis, cellDistance) {
  if (basis.calendarMonths !== null) {
    return calendarFutureTime(basis.horizon, basis.calendarMonths, cellDistance);
  }
  const time = basis.horizon + cellDistance * basis.step;
  return isSafeTimeMagnitude(time) ? time : null;
}

function futureCellDistanceFromTime(basis, time) {
  if (basis.calendarMonths !== null) {
    return calendarFutureCellDistance(basis.horizon, basis.calendarMonths, time);
  }
  const distance = (time - basis.horizon) / basis.step;
  return isFiniteNumber(distance) && distance > 0 ? distance : null;
}

/**
 * Capture a persistence-safe drawing anchor directly from a chart coordinate.
 * Existing ordinal cells retain complete source lineage; right-side whitespace
 * becomes an absolute source time with no projection-local order/logical data.
 */
export function drawingAnchorFromCoordinate(chart, series, x, context = null) {
  if (!chart || !series || !isFiniteNumber(x)) return null;
  const coordinateContext = context || {};
  const seriesData = getCachedSeriesData(series, coordinateContext);
  if (!Array.isArray(seriesData) || seriesData.length === 0) return null;

  const timeScale = chart.timeScale?.();
  if (!timeScale) return null;
  const ordinalIndex = getOrdinalSeriesIndex(seriesData, coordinateContext);
  if (!ordinalIndex) {
    let axisTime = null;
    try {
      axisTime = timeScale.coordinateToTime?.(x);
    } catch {
      axisTime = null;
    }
    return isFiniteNumber(axisTime) ? { time: axisTime } : null;
  }

  const tailRow = ordinalIndex.ordinalRows[ordinalIndex.ordinalRows.length - 1] || null;
  let tailX = null;
  try {
    tailX = timeScale.timeToCoordinate(tailRow?.time);
  } catch {
    tailX = null;
  }
  if (isFiniteNumber(tailX) && x > tailX) {
    const basis = ordinalFutureCoordinateBasis(
      timeScale,
      seriesData,
      coordinateContext,
      ordinalIndex,
    );
    if (!basis) return null;
    const delta = x - basis.tailX;
    const bars = delta / basis.cellWidth;
    const time = futureTimeFromCellDistance(basis, bars);
    return isFiniteNumber(delta)
      && delta > 0
      && isFiniteNumber(bars)
      && bars > 0
      && time !== null
      ? { time }
      : null;
  }

  let axisTime = null;
  try {
    axisTime = timeScale.coordinateToTime?.(x);
  } catch {
    axisTime = null;
  }
  if (!isOrdinalAxisTime(axisTime)) return null;
  const exactRow = exactOrdinalRow(ordinalIndex, {
    time: axisTime.sourceTime,
    sourceOrdinal: axisTime.sourceOrdinal,
  });
  if (exactRow?.time?.order !== axisTime.order) return null;
  const anchor = drawingAnchorFromAxisTime(axisTime, seriesData, coordinateContext);
  return anchor?.sourceProjection && anchor?.sourceProjectionConfig
    ? anchor
    : null;
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

/**
 * Atomically convert one coalesced pointer batch into portable synthetic-chart
 * freehand captures. Materialized cells retain source-lineage spans while
 * right-side whitespace becomes an absolute source-time point. Axis-local
 * order is used only for chart lookup and is never persisted.
 */
export function captureSourceLineageFreehandStrokeBatch(
  chart,
  series,
  screenPoints,
  context = null,
) {
  if (!chart
    || !series
    || !Array.isArray(screenPoints)
    || screenPoints.length === 0
    || screenPoints.length > MAX_FREEHAND_CAPTURE_BATCH_POINTS) {
    return null;
  }

  const coordinateContext = context || {};
  const seriesData = getCachedSeriesData(series, coordinateContext);
  const suppliedIndex = coordinateContext.drawingOrdinalSeriesIndex;
  const hasSuppliedIndex = Object.prototype.hasOwnProperty.call(
    coordinateContext,
    "drawingOrdinalSeriesIndex",
  );
  if (hasSuppliedIndex && !isDrawingLineageIndexForSeries(suppliedIndex, seriesData)) {
    return null;
  }
  const ordinalIndex = hasSuppliedIndex
    ? suppliedIndex
    : getOrdinalSeriesIndex(seriesData, coordinateContext);
  if (!ordinalIndex
    || !ordinalIndex.rowRangesMonotonic
    || ordinalIndex.ordinalRows.length < 1
    || ordinalIndex.rowRanges.length !== ordinalIndex.ordinalRows.length) {
    return null;
  }

  const expectedRevision = ordinalIndex.revision;
  if (Object.prototype.hasOwnProperty.call(
    coordinateContext,
    "drawingOrdinalSeriesIndexRevision",
  ) && coordinateContext.drawingOrdinalSeriesIndexRevision !== expectedRevision) {
    return null;
  }
  const sourceProjection = ordinalIndex.currentProjection;
  const sourceProjectionConfig = projectionConfigFromContext(coordinateContext);
  const sourceTimeHorizon = coordinateContext.sourceTimeHorizon;
  if (!persistenceSafeProjectionId(sourceProjection)
    || !persistenceSafeProjectionConfig(sourceProjectionConfig)
    || !isFiniteNumber(sourceTimeHorizon)
    || ordinalIndex.latestLineage > sourceTimeHorizon) {
    return null;
  }

  const timeScale = chart.timeScale?.();
  if (!timeScale) return null;

  const rows = ordinalIndex.ordinalRows;
  const ranges = ordinalIndex.rowRanges;
  const originalLength = seriesData.length;
  const originalFirst = seriesData[0];
  const originalLast = seriesData[originalLength - 1];
  const coordinateCache = new Map();
  const coordinateAt = (index) => {
    if (coordinateCache.has(index)) return coordinateCache.get(index);
    let coordinate = null;
    try {
      coordinate = timeScale.timeToCoordinate(rows[index]?.time);
    } catch {
      coordinate = null;
    }
    const normalized = isFiniteNumber(coordinate) ? coordinate : null;
    coordinateCache.set(index, normalized);
    return normalized;
  };
  const tailX = coordinateAt(rows.length - 1);
  let drawableWidth = null;
  try {
    drawableWidth = timeScale.width?.();
  } catch {
    drawableWidth = null;
  }
  if (!isFiniteNumber(drawableWidth) || drawableWidth <= 0) drawableWidth = null;
  let futureBasis = null;
  let futureBasisResolved = false;
  const getFutureBasis = () => {
    if (!futureBasisResolved) {
      futureBasis = ordinalFutureCoordinateBasis(
        timeScale,
        seriesData,
        coordinateContext,
        ordinalIndex,
      );
      futureBasisResolved = true;
    }
    return futureBasis;
  };

  const pairForCoordinate = (x) => {
    let snappedTime = null;
    try {
      snappedTime = timeScale.coordinateToTime?.(x);
    } catch {
      snappedTime = null;
    }
    if (!isOrdinalAxisTime(snappedTime)) return null;

    let left = 0;
    let right = rows.length;
    while (left < right) {
      const middle = (left + right) >> 1;
      const order = rows[middle]?.time?.order;
      if (!Number.isSafeInteger(order)) return null;
      if (order < snappedTime.order) left = middle + 1;
      else right = middle;
    }
    const snappedRow = rows[left];
    if (!isOrdinalAxisTime(snappedRow?.time)
      || snappedRow.time.order !== snappedTime.order
      || snappedRow.time.sourceTime !== snappedTime.sourceTime
      || snappedRow.time.sourceOrdinal !== snappedTime.sourceOrdinal) {
      return null;
    }
    const center = coordinateAt(left);
    if (center === null) return null;
    if (x < center) return left > 0 ? left - 1 : null;
    if (x > center) return left < rows.length - 1 ? left : null;
    return left < rows.length - 1 ? left : (left > 0 ? left - 1 : null);
  };

  const spanCache = new Map();
  const spanForPair = (pairIndex) => {
    if (spanCache.has(pairIndex)) return spanCache.get(pairIndex);
    const leftRow = rows[pairIndex];
    const rightRow = rows[pairIndex + 1];
    const leftEntry = ranges[pairIndex];
    const rightEntry = ranges[pairIndex + 1];
    if (leftEntry?.row !== leftRow
      || rightEntry?.row !== rightRow
      || leftEntry.coverageGroup !== rightEntry.coverageGroup
      || projectorIdFromRow(leftRow) !== sourceProjection
      || projectorIdFromRow(rightRow) !== sourceProjection) {
      return null;
    }
    const exact = {
      left: {
        time: leftRow.time.sourceTime,
        sourceOrdinal: leftRow.time.sourceOrdinal,
      },
      right: {
        time: rightRow.time.sourceTime,
        sourceOrdinal: rightRow.time.sourceOrdinal,
      },
    };
    const fromTime = leftEntry.range?.from;
    const toTime = rightEntry.range?.to;
    if (compareSourceAnchors(exact.left, exact.right) >= 0
      || !isFiniteNumber(fromTime)
      || !isFiniteNumber(toTime)
      || fromTime > toTime
      || exact.left.time < fromTime
      || exact.left.time > toTime
      || exact.right.time < fromTime
      || exact.right.time > toTime
      || toTime > sourceTimeHorizon) {
      return null;
    }

    const overlapFirst = firstRangeIndexWithToAtLeast(ranges, fromTime);
    const overlapEnd = firstRangeIndexWithFromGreaterThan(ranges, toTime, overlapFirst);
    if (overlapFirst > pairIndex
      || overlapEnd <= pairIndex + 1
      || overlapFirst >= overlapEnd
      || ranges[overlapFirst].coverageGroup !== ranges[overlapEnd - 1].coverageGroup) {
      return null;
    }
    const leftCenter = coordinateAt(pairIndex);
    const rightCenter = coordinateAt(pairIndex + 1);
    if (leftCenter === null
      || rightCenter === null
      || leftCenter >= rightCenter) {
      return null;
    }
    const cellCount = overlapEnd - overlapFirst;
    const leftRatio = (pairIndex - overlapFirst + 0.5) / cellCount;
    const rightRatio = (pairIndex - overlapFirst + 1.5) / cellCount;
    if (!Number.isSafeInteger(cellCount)
      || cellCount <= 0
      || !isFiniteNumber(leftRatio)
      || !isFiniteNumber(rightRatio)
      || leftRatio < 0
      || rightRatio > 1
      || leftRatio >= rightRatio) {
      return null;
    }
    const span = Object.freeze({
      exact: Object.freeze({
        left: Object.freeze(exact.left),
        right: Object.freeze(exact.right),
      }),
      fallback: Object.freeze({ fromTime, toTime, leftRatio, rightRatio }),
    });
    spanCache.set(pairIndex, span);
    return span;
  };

  const captures = [];
  for (const point of screenPoints) {
    const x = point?.x;
    const y = point?.y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (drawableWidth !== null && (x < 0 || x >= drawableWidth)) return null;
    let price = null;
    try {
      price = series.coordinateToPrice?.(y);
    } catch {
      price = null;
    }
    if (!isFiniteNumber(price)) return null;

    if (tailX !== null && x > tailX) {
      const basis = getFutureBasis();
      if (!basis) return null;
      const cellDistance = (x - basis.tailX) / basis.cellWidth;
      const time = futureTimeFromCellDistance(basis, cellDistance);
      if (!isFiniteNumber(cellDistance)
        || cellDistance <= 0
        || time === null
        || time <= sourceTimeHorizon) {
        return null;
      }
      captures.push(Object.freeze({
        time,
        price,
        screen: Object.freeze({ x, y }),
      }));
      continue;
    }

    if (rows.length === 1 && tailX !== null) {
      const cellWidth = getFutureBasis()?.cellWidth ?? ordinalCellWidth(timeScale, tailX);
      const tailTime = rows[0]?.time?.sourceTime;
      if (!isFiniteNumber(cellWidth)
        || cellWidth <= 0
        || x < tailX - cellWidth / 2
        || x > tailX
        || !isSafeTimeMagnitude(tailTime)) {
        return null;
      }
      captures.push(Object.freeze({
        anchor: Object.freeze({
          time: tailTime,
          sourceOrdinal: rows[0].time.sourceOrdinal,
        }),
        price,
        screen: Object.freeze({ x, y }),
      }));
      continue;
    }

    const pairIndex = pairForCoordinate(x);
    if (pairIndex === null) return null;
    const left = coordinateAt(pairIndex);
    const right = coordinateAt(pairIndex + 1);
    const span = spanForPair(pairIndex);
    if (!span || left === null || right === null || left >= right) {
      return null;
    }
    const ratio = (x - left) / (right - left);
    if (!isFiniteNumber(ratio) || ratio < 0 || ratio > 1) return null;
    captures.push(Object.freeze({
      span,
      ratio,
      price,
      screen: Object.freeze({ x, y }),
    }));
  }

  if (ordinalIndex.revision !== expectedRevision
    || ordinalIndex.seriesData !== seriesData
    || seriesData.length !== originalLength
    || seriesData[0] !== originalFirst
    || seriesData[originalLength - 1] !== originalLast) {
    return null;
  }
  return Object.freeze({
    sourceProjection,
    sourceProjectionConfig,
    captures: Object.freeze(captures),
  });
}

/**
 * Resolve one freehand v2 source-lineage span to CSS-pixel x coordinates.
 * Exact ordinal row centers are used only for an unchanged projector/config.
 * Otherwise the source envelope maps to the full cell envelope of the target
 * overlap run, preserving continuous positions even when only one row remains.
 */
export function resolveSourceLineageSpanToCoordinates(
  chart,
  series,
  {
    sourceProjection,
    sourceProjectionConfig,
    exact,
    fallback,
  } = {},
  context = null,
) {
  if (!chart || !series) return null;
  const coordinateContext = context || {};
  const seriesData = getCachedSeriesData(series, coordinateContext);
  const timeScale = chart.timeScale?.();
  if (!timeScale) return null;
  const coordinateForRow = (row) => {
    if (!row) return null;
    try {
      const coordinate = timeScale.timeToCoordinate(row.time);
      return isFiniteNumber(coordinate) ? coordinate : null;
    } catch {
      return null;
    }
  };

  const fromTime = isFiniteNumber(fallback?.fromTime) ? fallback.fromTime : null;
  const toTime = isFiniteNumber(fallback?.toTime) ? fallback.toTime : null;
  const leftRatio = isFiniteNumber(fallback?.leftRatio) ? fallback.leftRatio : null;
  const rightRatio = isFiniteNumber(fallback?.rightRatio) ? fallback.rightRatio : null;
  if (fromTime === null
    || toTime === null
    || fromTime > toTime
    || leftRatio === null
    || rightRatio === null
    || leftRatio < 0
    || rightRatio > 1
    || leftRatio >= rightRatio) {
    return null;
  }

  const ordinalIndex = getOrdinalSeriesIndex(seriesData, coordinateContext);
  const exactContextMatches = ordinalIndex
    && sourceProjection === ordinalIndex.currentProjection
    && normalizeProjectionConfig(sourceProjectionConfig) !== null
    && sourceProjectionConfig === projectionConfigFromContext(coordinateContext);
  if (exactContextMatches) {
    const left = coordinateForRow(exactOrdinalRow(ordinalIndex, exact?.left));
    const right = coordinateForRow(exactOrdinalRow(ordinalIndex, exact?.right));
    if (left !== null && right !== null && left < right) return { left, right };
  }

  let barSpacing = null;
  try {
    barSpacing = timeScale.options?.().barSpacing;
  } catch {
    barSpacing = null;
  }
  if (!isFiniteNumber(barSpacing) || barSpacing <= 0) return null;

  if (!ordinalIndex) {
    const bounds = numericSeriesBounds(seriesData, coordinateContext);
    if (!bounds || fromTime < bounds.firstTime || toTime > bounds.lastTime) return null;
    const envelopeLeftCenter = timeToCoordinateInterpolated(
      chart,
      series,
      fromTime,
      coordinateContext,
    );
    const envelopeRightCenter = timeToCoordinateInterpolated(
      chart,
      series,
      toTime,
      coordinateContext,
    );
    if (!isFiniteNumber(envelopeLeftCenter)
      || !isFiniteNumber(envelopeRightCenter)
      || envelopeLeftCenter > envelopeRightCenter) {
      return null;
    }
    const envelopeLeft = envelopeLeftCenter - barSpacing / 2;
    const envelopeRight = envelopeRightCenter + barSpacing / 2;
    return {
      left: envelopeLeft + (envelopeRight - envelopeLeft) * leftRatio,
      right: envelopeLeft + (envelopeRight - envelopeLeft) * rightRatio,
    };
  }

  const sourceTimeHorizon = isFiniteNumber(coordinateContext.sourceTimeHorizon)
    ? coordinateContext.sourceTimeHorizon
    : null;
  if ((sourceTimeHorizon !== null && toTime > sourceTimeHorizon)
    || (sourceTimeHorizon === null
      && (!Number.isFinite(ordinalIndex.latestLineage)
        || toTime > ordinalIndex.latestLineage))) {
    return null;
  }

  const overlap = ordinalIndex.rowsOverlappingSourceEnvelope({ fromTime, toTime });
  if (!overlap) return null;
  const firstCenter = coordinateForRow(overlap.first);
  const lastCenter = coordinateForRow(overlap.last);
  if (firstCenter === null
    || lastCenter === null
    || firstCenter > lastCenter) {
    return null;
  }

  const envelopeLeft = firstCenter - barSpacing / 2;
  const envelopeRight = lastCenter + barSpacing / 2;
  return {
    left: envelopeLeft + (envelopeRight - envelopeLeft) * leftRatio,
    right: envelopeLeft + (envelopeRight - envelopeLeft) * rightRatio,
  };
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
    const anchorTime = isFiniteNumber(dataPoint.time) ? dataPoint.time : null;
    const horizon = coordinateContext.sourceTimeHorizon;
    if (anchorTime !== null && isSafeTimeMagnitude(horizon) && anchorTime > horizon) {
      if (!isSafeTimeMagnitude(anchorTime)) return null;
      const basis = cachedOrdinalFutureCoordinateBasis(timeScale, data, coordinateContext);
      if (!basis) return null;
      const delta = anchorTime - basis.horizon;
      const bars = futureCellDistanceFromTime(basis, anchorTime);
      if (bars === null) return null;
      const x = basis.tailX + bars * basis.cellWidth;
      return isFiniteNumber(delta)
        && delta > 0
        && isFiniteNumber(bars)
        && bars > 0
        && isFiniteNumber(x)
        ? x
        : null;
    }
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
