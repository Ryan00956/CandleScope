import { isFiniteNumber } from "./drawingModel.js";
import type { DisplayRow } from "../chart-representation/chartRepresentationTypes.js";
import type {
  DrawingChartAdapter,
  DrawingDataPoint,
  OrdinalLineageAnchor,
  SourceTimeAnchor,
} from "./drawingTypes.js";

const SNAP_TIME_DISTANCE_PX = 12;
const SNAP_PRICE_DISTANCE_PX = 10;
const SNAP_PRICE_CANDLE_DISTANCE_PX = 18;
const SNAP_CANDIDATE_SCAN_RADIUS = 3;
const SNAP_PRICE_FIELDS = ["open", "high", "low", "close"] as const;

type CanonicalDrawingAnchor = SourceTimeAnchor | OrdinalLineageAnchor;
type SnapPriceSource = typeof SNAP_PRICE_FIELDS[number] | "value";

interface SnapPriceCandidate {
  value: number;
  source: SnapPriceSource;
}

interface TimeSnapTarget {
  time: unknown;
  x: number;
  dx: number;
  index: number;
}

interface PriceSnapTarget extends TimeSnapTarget {
  price: number;
  y: number;
  dy: number;
  source: SnapPriceSource;
}

interface PointerSnapTarget {
  time: TimeSnapTarget | null;
  price: PriceSnapTarget | null;
}

interface SnapDataPointOptions {
  snap?: boolean;
  time?: boolean;
  price?: boolean;
}

function isSafeSourceOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeSourceProjection(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isSafeProjectionConfig(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function adapterUsesOrdinalTime(
  adapter: DrawingChartAdapter | null | undefined,
): boolean {
  try {
    return adapter?.usesOrdinalTime?.() === true;
  } catch {
    return false;
  }
}

/**
 * Convert a chart-axis value into the durable drawing-anchor schema.
 * Ordinal `order` is deliberately discarded because it is projection-local.
 */
export function canonicalDrawingAnchorFromAxisTime(
  adapter: DrawingChartAdapter | null | undefined,
  axisTime: unknown,
): CanonicalDrawingAnchor | null {
  if (adapterUsesOrdinalTime(adapter)) {
    let anchor = null;
    try {
      anchor = adapter?.axisTimeToDrawingAnchor?.(axisTime) || null;
    } catch {
      anchor = null;
    }
    if (!anchor
      || typeof anchor.time !== "number"
      || !Number.isFinite(anchor.time)
      || !isSafeSourceOrdinal(anchor.sourceOrdinal)
      || !isSafeSourceProjection(anchor.sourceProjection)
      || (anchor.sourceProjectionConfig != null
        && !isSafeProjectionConfig(anchor.sourceProjectionConfig))) {
      return null;
    }
    return {
      time: anchor.time,
      sourceOrdinal: anchor.sourceOrdinal,
      sourceProjection: anchor.sourceProjection,
      ...(anchor.sourceProjectionConfig != null
        ? { sourceProjectionConfig: anchor.sourceProjectionConfig }
        : {}),
    };
  }

  return typeof axisTime === "number" && Number.isFinite(axisTime)
    ? { time: axisTime }
    : null;
}

/**
 * Capture a durable horizontal anchor directly from a screen coordinate.
 *
 * Ordinal adapters may return either an already-materialized lineage anchor
 * or an absolute source-time anchor for the right-side blank area.  Keep the
 * latter deliberately minimal: future placement must never persist a
 * projection-local order/logical coordinate or a guessed source ordinal.
 */
export function canonicalDrawingAnchorFromCoordinate(
  adapter: DrawingChartAdapter | null | undefined,
  x: number,
): CanonicalDrawingAnchor | null {
  if (!adapterUsesOrdinalTime(adapter) || !isFiniteNumber(x)) return null;

  if (typeof adapter?.coordinateToDrawingAnchor !== "function") {
    let axisTime = null;
    try {
      axisTime = adapter?.coordinateToTime?.(x) ?? null;
    } catch {
      axisTime = null;
    }
    return canonicalDrawingAnchorFromAxisTime(adapter, axisTime);
  }

  let anchor = null;
  try {
    anchor = adapter.coordinateToDrawingAnchor(x) || null;
  } catch {
    anchor = null;
  }
  if (!anchor || !isFiniteNumber(anchor.time)) return null;

  const sourceOrdinal = isSafeSourceOrdinal(anchor.sourceOrdinal)
    ? anchor.sourceOrdinal
    : null;
  const sourceProjection = isSafeSourceProjection(anchor.sourceProjection)
    ? anchor.sourceProjection
    : null;
  const sourceProjectionConfig = isSafeProjectionConfig(anchor.sourceProjectionConfig)
    ? anchor.sourceProjectionConfig
    : null;

  if (sourceOrdinal !== null && sourceProjection !== null) {
    return {
      time: anchor.time,
      sourceOrdinal,
      sourceProjection,
      ...(sourceProjectionConfig !== null ? { sourceProjectionConfig } : {}),
    };
  }

  const hasLineageMetadata = anchor.sourceOrdinal != null
    || anchor.sourceProjection != null
    || anchor.sourceProjectionConfig != null;
  return hasLineageMetadata ? null : { time: anchor.time };
}

function replaceHorizontalAnchor(
  dataPoint: DrawingDataPoint,
  anchor: CanonicalDrawingAnchor | null,
  { ordinal = false }: { ordinal?: boolean } = {},
): DrawingDataPoint {
  const next = { ...dataPoint };
  delete next.order;
  delete next.sourceOrdinal;
  delete next.sourceProjection;
  delete next.sourceProjectionConfig;
  if (ordinal) delete next.logical;
  if (!anchor) return next;
  next.time = anchor.time;
  if (anchor.sourceOrdinal != null) next.sourceOrdinal = anchor.sourceOrdinal;
  if (anchor.sourceProjection != null) next.sourceProjection = anchor.sourceProjection;
  if (anchor.sourceProjectionConfig != null) {
    next.sourceProjectionConfig = anchor.sourceProjectionConfig;
  }
  return next;
}

function getSnapPriceCandidates(item: DisplayRow | null | undefined): SnapPriceCandidate[] {
  if (!item) return [];
  const candidates: SnapPriceCandidate[] = [];
  const seen = new Set<number>();

  for (const field of SNAP_PRICE_FIELDS) {
    const value = item[field];
    if (!isFiniteNumber(value) || seen.has(value)) continue;
    seen.add(value);
    candidates.push({ value, source: field });
  }

  if (candidates.length === 0 && isFiniteNumber(item.value)) {
    candidates.push({ value: item.value, source: "value" });
  }

  return candidates;
}

export function findSnapTargetForPointer(
  adapter: DrawingChartAdapter | null | undefined,
  x: number,
  y: number,
): PointerSnapTarget | null {
  if (!adapter?.isReady?.()) return null;

  const seriesData = adapter.getSeriesData?.();
  if (!Array.isArray(seriesData) || seriesData.length === 0) return null;

  let logical: number | null = null;
  let firstLogical: number | null = null;
  try {
    logical = adapter.coordinateToLogical?.(x) ?? null;
  } catch {
    logical = null;
  }
  try {
    const firstRow = seriesData[0];
    if (!firstRow) return null;
    const firstCoord = adapter.timeToCoordinate?.(firstRow.time);
    if (isFiniteNumber(firstCoord)) {
      const value = adapter.coordinateToLogical?.(firstCoord);
      if (isFiniteNumber(value)) firstLogical = value;
    }
  } catch {
    firstLogical = null;
  }

  let centerIdx: number | null = null;
  if (isFiniteNumber(logical) && isFiniteNumber(firstLogical)) {
    centerIdx = Math.round(logical - firstLogical);
  } else {
    let bestDx = Infinity;
    for (let index = 0; index < seriesData.length; index += 1) {
      const item = seriesData[index];
      if (!item || item.time == null) continue;
      let cx: number | null = null;
      try { cx = adapter.timeToCoordinate?.(item.time) ?? null; } catch { cx = null; }
      if (!isFiniteNumber(cx)) continue;
      const dx = Math.abs(cx - x);
      if (dx < bestDx) {
        bestDx = dx;
        centerIdx = index;
      }
    }
  }

  if (!isFiniteNumber(centerIdx)) return null;
  centerIdx = Math.max(0, Math.min(seriesData.length - 1, centerIdx));

  let priceCandidateMaxDx = SNAP_PRICE_CANDLE_DISTANCE_PX;
  try {
    const barSpacing = adapter.getBarSpacing?.();
    if (isFiniteNumber(barSpacing)) {
      priceCandidateMaxDx = Math.max(priceCandidateMaxDx, barSpacing * 0.5);
    }
  } catch {
    // Keep the default horizontal snap distance.
  }

  const start = Math.max(0, centerIdx - SNAP_CANDIDATE_SCAN_RADIUS);
  const end = Math.min(seriesData.length - 1, centerIdx + SNAP_CANDIDATE_SCAN_RADIUS);
  let bestTimeSnap: TimeSnapTarget | null = null;
  let bestTimeDistance = Infinity;
  let bestPriceSnap: PriceSnapTarget | null = null;
  let bestPriceScore = Infinity;

  for (let index = start; index <= end; index += 1) {
    const item = seriesData[index];
    if (!item || item.time == null) continue;

    let cx: number | null = null;
    try { cx = adapter.timeToCoordinate?.(item.time) ?? null; } catch { cx = null; }
    if (!isFiniteNumber(cx)) continue;

    const dx = Math.abs(cx - x);
    if (dx <= SNAP_TIME_DISTANCE_PX && dx < bestTimeDistance) {
      bestTimeDistance = dx;
      bestTimeSnap = { time: item.time, x: cx, dx, index };
    }

    if (dx > priceCandidateMaxDx) continue;

    for (const candidate of getSnapPriceCandidates(item)) {
      let py: number | null = null;
      try { py = adapter.priceToCoordinate?.(candidate.value) ?? null; } catch { py = null; }
      if (!isFiniteNumber(py)) continue;
      const dy = Math.abs(py - y);
      if (dy > SNAP_PRICE_DISTANCE_PX) continue;

      const score = dy + dx * 0.15;
      if (score < bestPriceScore) {
        bestPriceScore = score;
        bestPriceSnap = {
          price: candidate.value,
          time: item.time,
          x: cx,
          y: py,
          dx,
          dy,
          source: candidate.source,
          index,
        };
      }
    }
  }

  if (!bestTimeSnap && !bestPriceSnap) return null;
  return { time: bestTimeSnap, price: bestPriceSnap };
}

export function snapDataPointAtPointer(
  dataPoint: DrawingDataPoint | null,
  x: number,
  y: number,
  options: SnapDataPointOptions,
  adapter: DrawingChartAdapter | null | undefined,
): DrawingDataPoint | null {
  if (!dataPoint || options.snap === false) return dataPoint;
  const allowTime = options.time !== false;
  const allowPrice = options.price !== false;
  if (!allowTime && !allowPrice) return dataPoint;

  const target = findSnapTargetForPointer(adapter, x, y);
  if (!target) return dataPoint;

  let next = { ...dataPoint };
  const preserveFutureSourceTime = adapterUsesOrdinalTime(adapter)
    && isFiniteNumber(dataPoint.time)
    && !isSafeSourceOrdinal(dataPoint.sourceOrdinal)
    && dataPoint.sourceProjection == null
    && dataPoint.sourceProjectionConfig == null;
  let snappedAxisTime: unknown = null;
  if (allowPrice && target.price) {
    next.price = target.price.price;
    if (allowTime && !preserveFutureSourceTime) snappedAxisTime = target.price.time;
  } else if (allowTime && target.time && !preserveFutureSourceTime) {
    snappedAxisTime = target.time.time;
  }

  if (allowTime && snappedAxisTime != null) {
    const ordinal = adapterUsesOrdinalTime(adapter);
    const anchor = canonicalDrawingAnchorFromAxisTime(adapter, snappedAxisTime);
    if (anchor) next = replaceHorizontalAnchor(next, anchor, { ordinal });
  }
  return next;
}
