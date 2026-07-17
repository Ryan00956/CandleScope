import type { DrawingEntity } from "../core/drawingDocument.js";
import type {
  DrawingDataPoint,
  FreehandStroke,
  FreehandStrokeV3Point,
  HorizontalDrawingAnchor,
} from "../drawingTypes.js";

export const DRAWING_FREEHAND_BOUNDS_CHUNK_POINTS = 128;

export type DrawingHorizontalDomain = "logical" | "time";
export type DrawingUnboundedAxis = "both" | "horizontal" | "vertical";

export interface DrawingBoundPoint {
  readonly horizontal: number;
  readonly horizontalDomain: DrawingHorizontalDomain;
  readonly price: number;
}

export interface BoundedDrawingGeometryBounds {
  readonly kind: "bounded";
  readonly horizontalDomain: DrawingHorizontalDomain;
  readonly minHorizontal: number;
  readonly maxHorizontal: number;
  readonly minPrice: number;
  readonly maxPrice: number;
}

/**
 * An unbounded axis is represented explicitly. The nullable values constrain
 * the other axis when possible (for example, the price of a horizontal line).
 */
export interface UnboundedDrawingGeometryBounds {
  readonly kind: "unbounded";
  readonly axis: DrawingUnboundedAxis;
  readonly horizontalDomain: DrawingHorizontalDomain | null;
  readonly minHorizontal: number | null;
  readonly maxHorizontal: number | null;
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
}

export interface DeferredDrawingGeometryBounds {
  readonly kind: "deferred";
}

export type DrawingGeometryBounds =
  | BoundedDrawingGeometryBounds
  | UnboundedDrawingGeometryBounds
  | DeferredDrawingGeometryBounds;

export interface DrawingBoundsChunk {
  /** First source point owned by this chunk. */
  readonly startPointIndex: number;
  /** Exclusive source point end. A chunk owns at most 128 source points. */
  readonly endPointIndex: number;
  /**
   * First point needed to bound every segment owned by this chunk. Except at a
   * path start, this is startPointIndex - 1 so the boundary segment is not lost.
   */
  readonly segmentStartPointIndex: number;
  /** Span envelopes require the atomic frame projector before safe culling. */
  readonly requiresExactProjection: boolean;
  readonly bounds: DrawingGeometryBounds;
}

export interface DrawingEntityGeometryBounds {
  readonly bounds: DrawingGeometryBounds;
  readonly chunks: readonly DrawingBoundsChunk[];
  readonly gapPointIndexes: readonly number[];
  readonly pointCount: number;
}

export interface DrawingFreehandBoundsPointInput {
  readonly canonicalPoint: DrawingBoundPoint | null;
  readonly entity: DrawingEntity;
  readonly point: unknown;
  readonly pointIndex: number;
}

export type DrawingFreehandBoundsPointResolver = (
  input: DrawingFreehandBoundsPointInput,
) => DrawingBoundPoint | null;

export interface DrawingGeometryBoundsOptions {
  /** Optional frame/world resolver. Returning null creates an explicit path gap. */
  readonly resolveFreehandPoint?: DrawingFreehandBoundsPointResolver;
}

export interface DrawingBoundsViewport {
  readonly horizontalDomain: DrawingHorizontalDomain;
  readonly minHorizontal: number;
  readonly maxHorizontal: number;
  readonly minPrice: number;
  readonly maxPrice: number;
}

const DEFERRED_BOUNDS: DeferredDrawingGeometryBounds = Object.freeze({ kind: "deferred" });
const EMPTY_CHUNKS: readonly DrawingBoundsChunk[] = Object.freeze([]);
const EMPTY_INDEXES: readonly number[] = Object.freeze([]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeBoundPoint(value: unknown): DrawingBoundPoint | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DrawingBoundPoint>;
  if (!finiteNumber(candidate.horizontal)
    || !finiteNumber(candidate.price)
    || (candidate.horizontalDomain !== "time" && candidate.horizontalDomain !== "logical")) {
    return null;
  }
  return Object.freeze({
    horizontal: candidate.horizontal,
    horizontalDomain: candidate.horizontalDomain,
    price: candidate.price,
  });
}

function boundPointFromDataPoint(value: unknown): DrawingBoundPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<DrawingDataPoint>;
  if (!finiteNumber(point.price)) return null;
  // Canonical source time wins over a stale legacy logical fallback.
  if (finiteNumber(point.time)) {
    return Object.freeze({ horizontal: point.time, horizontalDomain: "time", price: point.price });
  }
  if (finiteNumber(point.logical)) {
    return Object.freeze({
      horizontal: point.logical,
      horizontalDomain: "logical",
      price: point.price,
    });
  }
  return null;
}

function boundPointFromHorizontalAnchor(
  anchor: HorizontalDrawingAnchor | null | undefined,
  price: number,
): DrawingBoundPoint | null {
  if (!finiteNumber(price) || anchor == null) return null;
  if (finiteNumber(anchor)) {
    return Object.freeze({ horizontal: anchor, horizontalDomain: "time", price });
  }
  return boundPointFromDataPoint({ ...anchor, price });
}

function boundedFromPoints(points: readonly DrawingBoundPoint[]): DrawingGeometryBounds {
  const first = points[0];
  if (!first) return DEFERRED_BOUNDS;
  let minHorizontal = first.horizontal;
  let maxHorizontal = first.horizontal;
  let minPrice = first.price;
  let maxPrice = first.price;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (!point || point.horizontalDomain !== first.horizontalDomain) return DEFERRED_BOUNDS;
    minHorizontal = Math.min(minHorizontal, point.horizontal);
    maxHorizontal = Math.max(maxHorizontal, point.horizontal);
    minPrice = Math.min(minPrice, point.price);
    maxPrice = Math.max(maxPrice, point.price);
  }
  return Object.freeze({
    kind: "bounded",
    horizontalDomain: first.horizontalDomain,
    minHorizontal,
    maxHorizontal,
    minPrice,
    maxPrice,
  });
}

function explicitUnbounded(
  axis: DrawingUnboundedAxis,
  point: DrawingBoundPoint | null,
): UnboundedDrawingGeometryBounds {
  const horizontalBounded = axis === "vertical";
  const priceBounded = axis === "horizontal";
  return Object.freeze({
    kind: "unbounded",
    axis,
    horizontalDomain: horizontalBounded ? point?.horizontalDomain ?? null : null,
    minHorizontal: horizontalBounded ? point?.horizontal ?? null : null,
    maxHorizontal: horizontalBounded ? point?.horizontal ?? null : null,
    minPrice: priceBounded ? point?.price ?? null : null,
    maxPrice: priceBounded ? point?.price ?? null : null,
  });
}

function unionChunkBounds(chunks: readonly DrawingBoundsChunk[]): DrawingGeometryBounds {
  if (chunks.length === 0) return DEFERRED_BOUNDS;
  const points: DrawingBoundPoint[] = [];
  for (const chunk of chunks) {
    if (chunk.requiresExactProjection) return DEFERRED_BOUNDS;
    if (chunk.bounds.kind !== "bounded") return DEFERRED_BOUNDS;
    points.push(
      Object.freeze({
        horizontal: chunk.bounds.minHorizontal,
        horizontalDomain: chunk.bounds.horizontalDomain,
        price: chunk.bounds.minPrice,
      }),
      Object.freeze({
        horizontal: chunk.bounds.maxHorizontal,
        horizontalDomain: chunk.bounds.horizontalDomain,
        price: chunk.bounds.maxPrice,
      }),
    );
  }
  return boundedFromPoints(points);
}

function strokePointToBoundPoint(
  stroke: FreehandStroke,
  point: FreehandStrokeV3Point,
): DrawingBoundPoint | null {
  if (!finiteNumber(point.price)) return null;
  if ("time" in point && finiteNumber(point.time)) {
    return Object.freeze({ horizontal: point.time, horizontalDomain: "time", price: point.price });
  }
  if ("anchor" in point && finiteNumber(point.anchor?.time)) {
    return Object.freeze({
      horizontal: point.anchor.time,
      horizontalDomain: "time",
      price: point.price,
    });
  }
  if (!("span" in point) || !Number.isSafeInteger(point.span) || !finiteNumber(point.ratio)) {
    return null;
  }
  const span = stroke.spans[point.span];
  const fromTime = span?.fallback?.fromTime;
  const toTime = span?.fallback?.toTime;
  const leftRatio = span?.fallback?.leftRatio;
  const rightRatio = span?.fallback?.rightRatio;
  if (!finiteNumber(fromTime) || !finiteNumber(toTime)
    || !finiteNumber(leftRatio) || !finiteNumber(rightRatio)) return null;
  const effectiveRatio = leftRatio + ((rightRatio - leftRatio) * point.ratio);
  return Object.freeze({
    horizontal: fromTime + ((toTime - fromTime) * effectiveRatio),
    horizontalDomain: "time",
    price: point.price,
  });
}

function freehandSourcePoints(entity: DrawingEntity): readonly unknown[] {
  if (entity.geometry.kind !== "freehand" && entity.geometry.kind !== "highlighter") return [];
  if (Array.isArray(entity.geometry.dataPoints)) return entity.geometry.dataPoints;
  return Array.isArray(entity.geometry.stroke?.points) ? entity.geometry.stroke.points : [];
}

function canonicalFreehandPoint(
  entity: DrawingEntity,
  point: unknown,
): DrawingBoundPoint | null {
  if (entity.geometry.kind !== "freehand" && entity.geometry.kind !== "highlighter") return null;
  if (Array.isArray(entity.geometry.dataPoints)) return boundPointFromDataPoint(point);
  const stroke = entity.geometry.kind === "freehand" || entity.geometry.kind === "highlighter"
    ? entity.geometry.stroke
    : undefined;
  return stroke && point && typeof point === "object"
    ? strokePointToBoundPoint(stroke, point as FreehandStrokeV3Point)
    : null;
}

function buildFreehandChunks(
  points: readonly (DrawingBoundPoint | null)[],
  requiresExactProjection: readonly boolean[],
): {
  chunks: readonly DrawingBoundsChunk[];
  gapPointIndexes: readonly number[];
} {
  const chunks: DrawingBoundsChunk[] = [];
  const gaps: number[] = [];
  let cursor = 0;
  while (cursor < points.length) {
    if (!points[cursor]) {
      gaps.push(cursor);
      cursor += 1;
      continue;
    }
    const runStart = cursor;
    while (cursor < points.length && points[cursor]) cursor += 1;
    const runEnd = cursor;
    for (let start = runStart; start < runEnd; start += DRAWING_FREEHAND_BOUNDS_CHUNK_POINTS) {
      const end = Math.min(runEnd, start + DRAWING_FREEHAND_BOUNDS_CHUNK_POINTS);
      const segmentStart = start === runStart ? start : start - 1;
      const chunkPoints: DrawingBoundPoint[] = [];
      for (let index = segmentStart; index < end; index += 1) {
        const point = points[index];
        if (point) chunkPoints.push(point);
      }
      chunks.push(Object.freeze({
        startPointIndex: start,
        endPointIndex: end,
        segmentStartPointIndex: segmentStart,
        requiresExactProjection: requiresExactProjection
          .slice(segmentStart, end)
          .some(Boolean),
        bounds: boundedFromPoints(chunkPoints),
      }));
    }
  }
  return {
    chunks: Object.freeze(chunks),
    gapPointIndexes: Object.freeze(gaps),
  };
}

function freehandBounds(
  entity: DrawingEntity,
  resolveFreehandPoint?: DrawingFreehandBoundsPointResolver,
): DrawingEntityGeometryBounds {
  const sourcePoints = freehandSourcePoints(entity);
  const points = sourcePoints.map((point, pointIndex) => {
    const canonicalPoint = canonicalFreehandPoint(entity, point);
    if (!resolveFreehandPoint) return canonicalPoint;
    try {
      return normalizeBoundPoint(resolveFreehandPoint({
        canonicalPoint,
        entity,
        point,
        pointIndex,
      }));
    } catch {
      return null;
    }
  });
  const stroke = entity.geometry.kind === "freehand" || entity.geometry.kind === "highlighter"
    ? entity.geometry.stroke
    : undefined;
  const requiresExactProjection = sourcePoints.map((point) => Boolean(
    stroke && point && typeof point === "object" && "span" in point,
  ));
  const { chunks, gapPointIndexes } = buildFreehandChunks(points, requiresExactProjection);
  return Object.freeze({
    bounds: unionChunkBounds(chunks),
    chunks,
    gapPointIndexes,
    pointCount: sourcePoints.length,
  });
}

function dataPointBounds(points: readonly DrawingDataPoint[] | undefined): DrawingGeometryBounds {
  if (!Array.isArray(points)) return DEFERRED_BOUNDS;
  const normalized = points.map(boundPointFromDataPoint);
  if (normalized.some((point) => point === null)) return DEFERRED_BOUNDS;
  return boundedFromPoints(normalized as DrawingBoundPoint[]);
}

function positionBounds(entity: DrawingEntity): DrawingGeometryBounds {
  if (entity.geometry.kind !== "position") return DEFERRED_BOUNDS;
  const { entryPrice, slPrice, timeRange, tpPrice } = entity.geometry;
  if (!finiteNumber(entryPrice) || !timeRange) return DEFERRED_BOUNDS;
  const start = boundPointFromHorizontalAnchor(timeRange.start, entryPrice);
  const end = boundPointFromHorizontalAnchor(timeRange.end, entryPrice);
  if (!start || !end || start.horizontalDomain !== end.horizontalDomain) return DEFERRED_BOUNDS;
  const prices = [entryPrice, tpPrice, slPrice].filter(finiteNumber);
  return Object.freeze({
    kind: "bounded",
    horizontalDomain: start.horizontalDomain,
    minHorizontal: Math.min(start.horizontal, end.horizontal),
    maxHorizontal: Math.max(start.horizontal, end.horizontal),
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
  });
}

/** Build canonical/data-space bounds without mutating the document entity. */
export function createDrawingEntityGeometryBounds(
  entity: DrawingEntity,
  options: DrawingGeometryBoundsOptions = {},
): DrawingEntityGeometryBounds {
  if (entity.kind === "freehand" || entity.kind === "highlighter") {
    return freehandBounds(entity, options.resolveFreehandPoint);
  }

  let bounds: DrawingGeometryBounds = DEFERRED_BOUNDS;
  switch (entity.geometry.kind) {
    case "line": {
      const points = dataPointBounds(entity.geometry.dataPoints);
      bounds = entity.geometry.lineType === "line-ray"
        || entity.geometry.lineType === "line-infinite"
        ? explicitUnbounded("both", null)
        : points;
      break;
    }
    case "axis-line": {
      const point = boundPointFromDataPoint(entity.geometry.dataPoint);
      const axisLineType = entity.geometry.axisLineType ?? "horizontal";
      bounds = axisLineType === "cross"
        ? explicitUnbounded("both", point)
        : explicitUnbounded(axisLineType, point);
      break;
    }
    case "angle-measure":
    case "fibonacci":
    case "shape":
      bounds = dataPointBounds(entity.geometry.dataPoints);
      break;
    case "text":
      bounds = dataPointBounds(entity.geometry.dataPoint ? [entity.geometry.dataPoint] : undefined);
      break;
    case "position":
      bounds = positionBounds(entity);
      break;
    case "freehand":
    case "highlighter":
      break;
  }
  return Object.freeze({
    bounds,
    chunks: EMPTY_CHUNKS,
    gapPointIndexes: EMPTY_INDEXES,
    pointCount: 0,
  });
}

export function isValidDrawingBoundsViewport(
  viewport: DrawingBoundsViewport,
): boolean {
  return (viewport.horizontalDomain === "time" || viewport.horizontalDomain === "logical")
    && finiteNumber(viewport.minHorizontal)
    && finiteNumber(viewport.maxHorizontal)
    && finiteNumber(viewport.minPrice)
    && finiteNumber(viewport.maxPrice)
    && viewport.minHorizontal <= viewport.maxHorizontal
    && viewport.minPrice <= viewport.maxPrice;
}

/** Deferred or incomparable bounds stay visible so culling always fails open. */
export function drawingGeometryBoundsIntersectsViewport(
  bounds: DrawingGeometryBounds,
  viewport: DrawingBoundsViewport,
): boolean {
  if (!isValidDrawingBoundsViewport(viewport)) return false;
  if (bounds.kind === "deferred") return true;
  const horizontalUnbounded = bounds.kind === "unbounded"
    && (bounds.axis === "horizontal" || bounds.axis === "both");
  const verticalUnbounded = bounds.kind === "unbounded"
    && (bounds.axis === "vertical" || bounds.axis === "both");
  const domain = bounds.horizontalDomain;
  const horizontalComparable = domain === null || domain === viewport.horizontalDomain;
  const horizontalIntersects = horizontalUnbounded
    || !horizontalComparable
    || bounds.minHorizontal === null
    || bounds.maxHorizontal === null
    || (bounds.maxHorizontal >= viewport.minHorizontal
      && bounds.minHorizontal <= viewport.maxHorizontal);
  const priceIntersects = verticalUnbounded
    || bounds.minPrice === null
    || bounds.maxPrice === null
    || (bounds.maxPrice >= viewport.minPrice && bounds.minPrice <= viewport.maxPrice);
  return horizontalIntersects && priceIntersects;
}
