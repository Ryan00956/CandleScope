import type { DrawingFrameSnapshot } from "../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  CoordinateDataPoint,
  DrawingCoordinateResolution,
  SourceLineageSpanInput,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  DrawingDocument,
  DrawingEntity,
  DrawingStyle,
} from "../core/drawingDocument.js";
import { MAX_DRAWING_DOCUMENT_ENTITIES } from "../core/drawingDocument.js";
import type {
  DrawingDataPoint,
  DrawingHit,
  FreehandStroke,
  FreehandStrokeV3Point,
  HorizontalDrawingAnchor,
  SourceLineageSpan,
} from "../drawingTypes.js";
import {
  drawingGeometryBoundsIntersectsViewport,
} from "../geometry/drawingBounds.js";
import type {
  DrawingBoundsChunk,
  DrawingBoundsViewport,
} from "../geometry/drawingBounds.js";
import {
  createDrawingLodHierarchy,
  DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES,
  DRAWING_LOD_MAX_CACHE_BUDGET_BYTES,
  DRAWING_LOD_TOLERANCE_CSS_PX,
  DrawingByteWeightedLruCache,
  selectDrawingLod,
} from "../geometry/drawingLod.js";
import type {
  DrawingByteWeightedLruSnapshot,
  DrawingLodHierarchy,
  DrawingLodSelection,
  DrawingLodToleranceClass,
} from "../geometry/drawingLod.js";
import { drawingPerfCounters } from "../performance/drawingPerfCounters.js";
import {
  createDrawingScreenDisplayList,
} from "../rendering/drawingDisplayList.js";
import type {
  DrawingDisplayHitZone,
  DrawingDisplayRenderSpec,
  DrawingDisplayUnboundedAxis,
  DrawingScreenDisplayList,
  ProjectedDrawingEntity,
} from "../rendering/drawingDisplayList.js";
import {
  normalizeDrawingEntityForRender,
} from "../rendering/drawingRenderDefaults.js";
import type {
  AngleDrawingRenderEntity,
  AxisLineDrawingRenderEntity,
  DrawingRenderEntity,
  FibonacciDrawingRenderEntity,
  FreehandDrawingRenderEntity,
  LineDrawingRenderEntity,
  PositionDrawingRenderEntity,
  ShapeDrawingRenderEntity,
  TextDrawingRenderEntity,
} from "../rendering/drawingRenderDefaults.js";
import type { DrawingRenderRevisionStamp } from "./drawingRenderScheduler.js";
import type { DrawingSceneNode } from "./drawingSceneRegistry.js";
import {
  drawingPositionCurrentPrice,
  drawingPositionLevelPresentation,
  drawingPositionPanelLines,
} from "../drawingPositionPresentation.js";
import { positionInfoPanelLeft } from "../positionInfoPanelLayout.js";

export interface DrawingSceneTextMeasureRequest {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly fontWeight?: number | "normal" | "bold";
}

export type DrawingSceneTextMeasurement = number | Readonly<{ width: number }>;

/** The projector intentionally cannot reach chart, series, canvas, or lifecycle APIs. */
export interface DrawingSceneProjectionAdapter {
  projectDrawingFrameDataPoints(
    frame: DrawingFrameSnapshot,
    dataPoints: readonly CoordinateDataPoint[],
  ): Float64Array | null;
  /** Pure source/world resolution; this result is reusable across viewport revisions. */
  resolveDrawingFrameDataPoints?(
    frame: DrawingFrameSnapshot,
    dataPoints: readonly CoordinateDataPoint[],
  ): readonly (DrawingCoordinateResolution | null)[] | null;
  /** Public LWC-bound final projection for a previously resolved subset. */
  projectDrawingFrameResolvedDataPoints?(
    frame: DrawingFrameSnapshot,
    resolutions: readonly (DrawingCoordinateResolution | null)[],
    dataPoints: readonly CoordinateDataPoint[],
  ): Float64Array | null;
  projectDrawingFrameSourceLineageSpan(
    frame: DrawingFrameSnapshot,
    span: SourceLineageSpanInput,
  ): Readonly<{ left: number; right: number }> | null;
  measureText?(
    request: DrawingSceneTextMeasureRequest,
  ): DrawingSceneTextMeasurement | null;
}

export interface DrawingSceneProjectionInput {
  readonly document: DrawingDocument;
  /** Registry-cull result. The projector restores canonical document order defensively. */
  readonly nodes: readonly DrawingSceneNode[];
  readonly frame: DrawingFrameSnapshot;
  readonly stamp: DrawingRenderRevisionStamp;
  readonly adapter: DrawingSceneProjectionAdapter;
  readonly selectedId: string | null;
  readonly lodToleranceClass?: DrawingLodToleranceClass;
}

export interface DrawingSceneWorldWarmupInput {
  readonly document: DrawingDocument;
  /** Complete scene-owned node set before viewport culling. */
  readonly nodes: readonly DrawingSceneNode[];
  readonly frame: DrawingFrameSnapshot;
  readonly adapter: DrawingSceneProjectionAdapter;
}

export interface DrawingSceneCanonicalGapProjectionInput {
  readonly document: DrawingDocument;
  /** Only visible display-list entities need a strict legacy gap comparison. */
  readonly plan: DrawingScreenDisplayList;
  readonly frame: DrawingFrameSnapshot;
  readonly adapter: DrawingSceneProjectionAdapter;
}

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

interface PointRange {
  readonly start: number;
  readonly end: number;
}

interface SceneProjectionEntry {
  readonly node: DrawingSceneNode;
  readonly renderEntity: DrawingRenderEntity;
}

interface ProjectedEntityOptions {
  readonly bbox?: readonly [number, number, number, number] | null;
  readonly handles?: Float64Array;
  readonly handleNames?: readonly string[];
  readonly handleResults?: readonly (Readonly<DrawingHit> | null)[];
  readonly handleTolerance?: number;
  readonly hitZones?: readonly DrawingDisplayHitZone[];
  readonly pathBreaks?: Uint32Array;
  readonly unresolvedSourcePointIndexes?: Uint32Array;
  readonly canonicalGapCoverageComplete?: boolean;
  readonly unboundedAxis?: DrawingDisplayUnboundedAxis;
  readonly renderSpec?: DrawingDisplayRenderSpec;
}

const PROJECTION_FAILED = Symbol("drawing-scene-projection-failed");
type ProjectionFailure = typeof PROJECTION_FAILED;
type EntityProjection = ProjectedDrawingEntity | null | ProjectionFailure;
type BatchProjection = Float64Array | ProjectionFailure;
type TwoPointAnchors = readonly [ScreenPoint, ScreenPoint] | null;
type TwoPointProjection = TwoPointAnchors | ProjectionFailure;

interface NormalizedRenderEntityCacheEntry {
  readonly geometry: DrawingEntity["geometry"];
  readonly geometryRevision: number;
  readonly normalized: DrawingRenderEntity | null;
  readonly style: DrawingEntity["style"];
  readonly styleRevision: number;
}

const normalizedRenderEntityCache = new WeakMap<DrawingEntity, NormalizedRenderEntityCacheEntry>();
interface FreehandChunkProjectionRequest {
  readonly indexes: readonly number[];
  readonly points: readonly CoordinateDataPoint[];
}

const freehandChunkProjectionRequestCache = new WeakMap<
  object,
  Map<string, FreehandChunkProjectionRequest>
>();

const BOX_HANDLE_NAMES = Object.freeze(["tl", "t", "tr", "r", "br", "b", "bl", "l"]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function legacyLineAlpha(color: string, alpha: number): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  if (color.length === 4 && color.startsWith("#")) {
    red = parseInt(color.charAt(1).repeat(2), 16);
    green = parseInt(color.charAt(2).repeat(2), 16);
    blue = parseInt(color.charAt(3).repeat(2), 16);
  } else if (color.length === 7 && color.startsWith("#")) {
    red = parseInt(color.slice(1, 3), 16);
    green = parseInt(color.slice(3, 5), 16);
    blue = parseInt(color.slice(5, 7), 16);
  } else {
    return color;
  }
  return `rgba(${red},${green},${blue},${alpha})`;
}

function legacyPaintAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return "transparent";
  const boundedAlpha = Math.max(0, Math.min(1, Number(alpha)));
  if (color.startsWith("rgba")) {
    const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (match) {
      const baseAlpha = Math.max(0, Math.min(1, Number(match[4])));
      return `rgba(${match[1]},${match[2]},${match[3]},${baseAlpha * boundedAlpha})`;
    }
  }
  if (color.startsWith("rgb")) {
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) return `rgba(${match[1]},${match[2]},${match[3]},${boundedAlpha})`;
  }
  let red = 0;
  let green = 0;
  let blue = 0;
  if (color.length === 4 && color.startsWith("#")) {
    red = parseInt(color.charAt(1).repeat(2), 16);
    green = parseInt(color.charAt(2).repeat(2), 16);
    blue = parseInt(color.charAt(3).repeat(2), 16);
  } else if (color.length === 7 && color.startsWith("#")) {
    red = parseInt(color.slice(1, 3), 16);
    green = parseInt(color.slice(3, 5), 16);
    blue = parseInt(color.slice(5, 7), 16);
  } else {
    return color;
  }
  return `rgba(${red},${green},${blue},${boundedAlpha})`;
}

function normalizeDrawingEntityForScene(entity: DrawingEntity): DrawingRenderEntity | null {
  const cached = normalizedRenderEntityCache.get(entity);
  if (cached
    && cached.geometry === entity.geometry
    && cached.style === entity.style
    && cached.geometryRevision === entity.geometryRevision
    && cached.styleRevision === entity.styleRevision) return cached.normalized;
  const normalized = normalizeDrawingEntityForRender(entity);
  normalizedRenderEntityCache.set(entity, Object.freeze({
    geometry: entity.geometry,
    geometryRevision: entity.geometryRevision,
    normalized,
    style: entity.style,
    styleRevision: entity.styleRevision,
  }));
  return normalized;
}

function validProjectedBuffer(value: unknown, pointCount: number): value is Float64Array {
  if (!(value instanceof Float64Array) || value.length !== pointCount * 2) return false;
  for (let index = 0; index < value.length; index += 2) {
    const x = value[index];
    const y = value[index + 1];
    if ((!finiteNumber(x) && !Number.isNaN(x))
      || (!finiteNumber(y) && !Number.isNaN(y))) return false;
  }
  return true;
}

function projectBatch(
  adapter: DrawingSceneProjectionAdapter,
  frame: DrawingFrameSnapshot,
  points: readonly CoordinateDataPoint[],
  requestIdentity?: object,
): BatchProjection {
  if (adapter.resolveDrawingFrameDataPoints && adapter.projectDrawingFrameResolvedDataPoints) {
    const resolutions = resolveCachedDrawingWorldBatch(
      adapter,
      frame,
      points,
      requestIdentity,
    );
    if (!resolutions) return PROJECTION_FAILED;
    return projectResolvedBatch(adapter, frame, resolutions, points);
  }
  try {
    const projected = adapter.projectDrawingFrameDataPoints(frame, points);
    return validProjectedBuffer(projected, points.length) ? projected : PROJECTION_FAILED;
  } catch {
    return PROJECTION_FAILED;
  }
}

function projectResolvedBatch(
  adapter: DrawingSceneProjectionAdapter,
  frame: DrawingFrameSnapshot,
  resolutions: readonly (DrawingCoordinateResolution | null)[],
  points: readonly CoordinateDataPoint[],
): BatchProjection {
  const finalProject = adapter.projectDrawingFrameResolvedDataPoints;
  if (!finalProject || resolutions.length !== points.length) return PROJECTION_FAILED;
  try {
    const projected = finalProject(frame, resolutions, points);
    if (!validProjectedBuffer(projected, points.length)) return PROJECTION_FAILED;
    drawingPerfCounters.recordFinalProjection(points.length);
    return projected;
  } catch {
    return PROJECTION_FAILED;
  }
}

function screenPointAt(buffer: Float64Array, pointIndex: number): ScreenPoint | null {
  const x = buffer[pointIndex * 2];
  const y = buffer[pointIndex * 2 + 1];
  return finiteNumber(x) && finiteNumber(y) ? Object.freeze({ x, y }) : null;
}

function pushPoint(target: number[], point: ScreenPoint): number {
  const offset = target.length / 2;
  target.push(point.x, point.y);
  return offset;
}

function pushPair(target: number[], a: ScreenPoint, b: ScreenPoint): number {
  const offset = pushPoint(target, a);
  pushPoint(target, b);
  return offset;
}

function bboxFromValues(values: ArrayLike<number>): readonly [number, number, number, number] | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (!finiteNumber(x) || !finiteNumber(y)) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return Number.isFinite(left)
    ? Object.freeze([left, top, right, bottom])
    : null;
}

/** Match the legacy canvas path: a finite singleton between gaps is not painted. */
function bboxFromDrawablePolyline(
  values: ArrayLike<number>,
  widthCssPx: number,
  heightCssPx: number,
  paintOutsetCssPx = 0,
): readonly [number, number, number, number] | null {
  const clipLeft = -Math.max(0, paintOutsetCssPx);
  const clipTop = clipLeft;
  const clipRight = widthCssPx + Math.max(0, paintOutsetCssPx);
  const clipBottom = heightCssPx + Math.max(0, paintOutsetCssPx);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let previousX = 0;
  let previousY = 0;
  let hasPrevious = false;
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (!finiteNumber(x) || !finiteNumber(y)) {
      hasPrevious = false;
      continue;
    }
    if (hasPrevious) {
      const dx = x - previousX;
      const dy = y - previousY;
      let firstX = previousX;
      let firstY = previousY;
      let secondX = x;
      let secondY = y;
      let visible = previousX >= clipLeft && previousX <= clipRight
        && previousY >= clipTop && previousY <= clipBottom
        && x >= clipLeft && x <= clipRight
        && y >= clipTop && y <= clipBottom;
      if (!visible) {
        let minT = 0;
        let maxT = 1;
        visible = true;
        if (dx === 0) {
          visible = previousX >= clipLeft && previousX <= clipRight;
        } else {
          let first = (clipLeft - previousX) / dx;
          let second = (clipRight - previousX) / dx;
          if (first > second) [first, second] = [second, first];
          minT = Math.max(minT, first);
          maxT = Math.min(maxT, second);
          visible = minT <= maxT;
        }
        if (visible) {
          if (dy === 0) {
            visible = previousY >= clipTop && previousY <= clipBottom;
          } else {
            let first = (clipTop - previousY) / dy;
            let second = (clipBottom - previousY) / dy;
            if (first > second) [first, second] = [second, first];
            minT = Math.max(minT, first);
            maxT = Math.min(maxT, second);
            visible = minT <= maxT;
          }
        }
        if (visible) {
          firstX = previousX + dx * minT;
          firstY = previousY + dy * minT;
          secondX = previousX + dx * maxT;
          secondY = previousY + dy * maxT;
        }
      }
      if (visible) {
        left = Math.min(left, firstX, secondX);
        top = Math.min(top, firstY, secondY);
        right = Math.max(right, firstX, secondX);
        bottom = Math.max(bottom, firstY, secondY);
      }
    }
    previousX = x;
    previousY = y;
    hasPrevious = true;
  }
  return Number.isFinite(left) ? Object.freeze([left, top, right, bottom]) : null;
}

/**
 * Match traceFreehandRun's midpoint-quadratic path while keeping culling
 * fail-open. A quadratic can enter the pane even when neither adjacent raw
 * polyline segment does, so its exact axis extrema (rather than the raw
 * chords) own the conservative visibility box. Finite singleton runs remain
 * non-drawable, exactly like the renderer.
 */
function bboxFromDrawableQuadraticPath(
  values: ArrayLike<number>,
  widthCssPx: number,
  heightCssPx: number,
  paintOutsetCssPx = 0,
): readonly [number, number, number, number] | null {
  const outset = Math.max(0, paintOutsetCssPx);
  const clipLeft = -outset;
  const clipTop = -outset;
  const clipRight = widthCssPx + outset;
  const clipBottom = heightCssPx + outset;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const includeClippedBounds = (
    segmentLeft: number,
    segmentTop: number,
    segmentRight: number,
    segmentBottom: number,
  ): void => {
    if (segmentRight < clipLeft || segmentLeft > clipRight
      || segmentBottom < clipTop || segmentTop > clipBottom) return;
    left = Math.min(left, Math.max(clipLeft, segmentLeft));
    top = Math.min(top, Math.max(clipTop, segmentTop));
    right = Math.max(right, Math.min(clipRight, segmentRight));
    bottom = Math.max(bottom, Math.min(clipBottom, segmentBottom));
  };

  const includeLine = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): void => {
    const dx = endX - startX;
    const dy = endY - startY;
    let minimum = 0;
    let maximum = 1;
    const clipAxis = (origin: number, delta: number, lower: number, upper: number): boolean => {
      if (delta === 0) return origin >= lower && origin <= upper;
      const first = (lower - origin) / delta;
      const second = (upper - origin) / delta;
      minimum = Math.max(minimum, Math.min(first, second));
      maximum = Math.min(maximum, Math.max(first, second));
      return minimum <= maximum;
    };
    if (!clipAxis(startX, dx, clipLeft, clipRight)
      || !clipAxis(startY, dy, clipTop, clipBottom)) return;
    const firstX = startX + dx * minimum;
    const firstY = startY + dy * minimum;
    const secondX = startX + dx * maximum;
    const secondY = startY + dy * maximum;
    includeClippedBounds(
      Math.min(firstX, secondX),
      Math.min(firstY, secondY),
      Math.max(firstX, secondX),
      Math.max(firstY, secondY),
    );
  };

  const includeQuadratic = (
    startX: number,
    startY: number,
    controlX: number,
    controlY: number,
    endX: number,
    endY: number,
  ): void => {
    const ax = startX - 2 * controlX + endX;
    const bx = 2 * (controlX - startX);
    const ay = startY - 2 * controlY + endY;
    const by = 2 * (controlY - startY);
    const evaluate = (a: number, b: number, start: number, ratio: number): number => (
      (a * ratio + b) * ratio + start
    );
    const xAt = (ratio: number): number => evaluate(ax, bx, startX, ratio);
    const yAt = (ratio: number): number => evaluate(ay, by, startY, ratio);
    const boundaries = [0, 1];
    const appendBoundaryRoots = (a: number, b: number, start: number, bound: number): void => {
      const c = start - bound;
      if (Math.abs(a) <= Number.EPSILON) {
        if (Math.abs(b) <= Number.EPSILON) return;
        const ratio = -c / b;
        if (ratio > 0 && ratio < 1) boundaries.push(ratio);
        return;
      }
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) return;
      const root = Math.sqrt(Math.max(0, discriminant));
      const first = (-b - root) / (2 * a);
      const second = (-b + root) / (2 * a);
      if (first > 0 && first < 1) boundaries.push(first);
      if (second > 0 && second < 1) boundaries.push(second);
    };
    appendBoundaryRoots(ax, bx, startX, clipLeft);
    appendBoundaryRoots(ax, bx, startX, clipRight);
    appendBoundaryRoots(ay, by, startY, clipTop);
    appendBoundaryRoots(ay, by, startY, clipBottom);
    boundaries.sort((first, second) => first - second);
    const uniqueBoundaries = boundaries.filter((ratio, index) => (
      index === 0 || Math.abs(ratio - Number(boundaries[index - 1])) > 1e-12
    ));
    const inside = (ratio: number): boolean => {
      const x = xAt(ratio);
      const y = yAt(ratio);
      const epsilon = 1e-9;
      return x >= clipLeft - epsilon && x <= clipRight + epsilon
        && y >= clipTop - epsilon && y <= clipBottom + epsilon;
    };
    const includeInterval = (minimum: number, maximum: number): void => {
      const ratios = [minimum, maximum];
      const xExtremum = ax === 0 ? Number.NaN : -bx / (2 * ax);
      const yExtremum = ay === 0 ? Number.NaN : -by / (2 * ay);
      if (xExtremum > minimum && xExtremum < maximum) ratios.push(xExtremum);
      if (yExtremum > minimum && yExtremum < maximum) ratios.push(yExtremum);
      let segmentLeft = Number.POSITIVE_INFINITY;
      let segmentTop = Number.POSITIVE_INFINITY;
      let segmentRight = Number.NEGATIVE_INFINITY;
      let segmentBottom = Number.NEGATIVE_INFINITY;
      for (const ratio of ratios) {
        const x = xAt(ratio);
        const y = yAt(ratio);
        segmentLeft = Math.min(segmentLeft, x);
        segmentTop = Math.min(segmentTop, y);
        segmentRight = Math.max(segmentRight, x);
        segmentBottom = Math.max(segmentBottom, y);
      }
      includeClippedBounds(segmentLeft, segmentTop, segmentRight, segmentBottom);
    };
    for (let index = 0; index < uniqueBoundaries.length - 1; index += 1) {
      const minimum = Number(uniqueBoundaries[index]);
      const maximum = Number(uniqueBoundaries[index + 1]);
      if (inside((minimum + maximum) / 2)) includeInterval(minimum, maximum);
    }
    // Retain a tangent-only contact where no positive-length interval lies in
    // the pane. Canvas can still cover pixels there once stroke width applies.
    for (const ratio of uniqueBoundaries) {
      if (!inside(ratio)) continue;
      const x = xAt(ratio);
      const y = yAt(ratio);
      includeClippedBounds(x, y, x, y);
    }
  };

  const pointCount = Math.floor(values.length / 2);
  let runStart = -1;
  const processRun = (runEnd: number): void => {
    if (runStart < 0 || runEnd - runStart < 2) return;
    const startX = Number(values[runStart * 2]);
    const startY = Number(values[runStart * 2 + 1]);
    if (runEnd - runStart === 2) {
      includeLine(
        startX,
        startY,
        Number(values[(runEnd - 1) * 2]),
        Number(values[(runEnd - 1) * 2 + 1]),
      );
      return;
    }
    let currentX = startX;
    let currentY = startY;
    for (let pointIndex = runStart + 1; pointIndex < runEnd - 1; pointIndex += 1) {
      const controlX = Number(values[pointIndex * 2]);
      const controlY = Number(values[pointIndex * 2 + 1]);
      const nextX = Number(values[(pointIndex + 1) * 2]);
      const nextY = Number(values[(pointIndex + 1) * 2 + 1]);
      const endX = (controlX + nextX) / 2;
      const endY = (controlY + nextY) / 2;
      includeQuadratic(currentX, currentY, controlX, controlY, endX, endY);
      currentX = endX;
      currentY = endY;
    }
    const penultimateIndex = runEnd - 2;
    includeQuadratic(
      currentX,
      currentY,
      Number(values[penultimateIndex * 2]),
      Number(values[penultimateIndex * 2 + 1]),
      Number(values[(runEnd - 1) * 2]),
      Number(values[(runEnd - 1) * 2 + 1]),
    );
  };

  for (let pointIndex = 0; pointIndex <= pointCount; pointIndex += 1) {
    const finite = pointIndex < pointCount
      && finiteNumber(values[pointIndex * 2])
      && finiteNumber(values[pointIndex * 2 + 1]);
    if (finite && runStart < 0) runStart = pointIndex;
    if (finite || runStart < 0) continue;
    processRun(pointIndex);
    runStart = -1;
  }
  return Number.isFinite(left) ? Object.freeze([left, top, right, bottom]) : null;
}

function freehandPaintOutsetCssPx(
  lineWidthCssPx: number,
  brushShape: "round" | "square",
): number {
  const halfStroke = Math.max(0, lineWidthCssPx) / 2;
  // A 45-degree square cap reaches halfStroke along both the tangent and the
  // normal. The selected freehand paint replaces the stroke color/opacity but
  // keeps the same width, so it needs the same conservative extent.
  return brushShape === "square" ? halfStroke * Math.SQRT2 : halfStroke;
}

function bboxFromDrawableFreehand(
  values: ArrayLike<number>,
  widthCssPx: number,
  heightCssPx: number,
  paintOutsetCssPx: number,
  pathInterpolation: "linear" | "quadratic",
): readonly [number, number, number, number] | null {
  return pathInterpolation === "quadratic"
    ? bboxFromDrawableQuadraticPath(values, widthCssPx, heightCssPx, paintOutsetCssPx)
    : bboxFromDrawablePolyline(values, widthCssPx, heightCssPx, paintOutsetCssPx);
}

function unionBboxes(
  first: readonly [number, number, number, number] | null,
  second: readonly [number, number, number, number] | null,
): readonly [number, number, number, number] | null {
  if (!first) return second;
  if (!second) return first;
  return Object.freeze([
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[2], second[2]),
    Math.max(first[3], second[3]),
  ]);
}

function createProjectedEntity(
  entity: DrawingRenderEntity,
  points: Float64Array,
  options: ProjectedEntityOptions = {},
): ProjectedDrawingEntity {
  const projected: ProjectedDrawingEntity = {
    id: entity.id,
    kind: entity.kind,
    geometryRevision: entity.geometryRevision,
    styleRevision: entity.styleRevision,
    style: entity.style as DrawingStyle,
    ...(options.renderSpec ? { renderSpec: options.renderSpec } : {}),
    points,
    bbox: options.bbox === undefined ? bboxFromValues(points) : options.bbox,
    ...(options.handles ? { handles: options.handles } : {}),
    ...(options.handleNames ? { handleNames: options.handleNames } : {}),
    ...(options.handleResults ? { handleResults: options.handleResults } : {}),
    ...(options.handleTolerance !== undefined
      ? { handleTolerance: options.handleTolerance }
      : {}),
    ...(options.pathBreaks ? { pathBreaks: options.pathBreaks } : {}),
    ...(options.unresolvedSourcePointIndexes
      ? { unresolvedSourcePointIndexes: options.unresolvedSourcePointIndexes }
      : {}),
    ...(options.canonicalGapCoverageComplete !== undefined
      ? { canonicalGapCoverageComplete: options.canonicalGapCoverageComplete }
      : {}),
    ...(options.hitZones ? { hitZones: options.hitZones } : {}),
    ...(options.unboundedAxis !== undefined
      ? { unboundedAxis: options.unboundedAxis }
      : {}),
  };
  return Object.freeze(projected);
}

function projectTwoDataPoints(
  entity: LineDrawingRenderEntity | AngleDrawingRenderEntity
    | FibonacciDrawingRenderEntity | ShapeDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
): TwoPointProjection {
  const first = entity.geometry.dataPoints[0];
  const second = entity.geometry.dataPoints[1];
  if (!first || !second) return null;
  const projected = projectBatch(adapter, frame, [first, second], entity.geometry);
  if (projected === PROJECTION_FAILED) return projected;
  const a = screenPointAt(projected, 0);
  const b = screenPointAt(projected, 1);
  return a && b ? Object.freeze([a, b] as const) : null;
}

function projectOrdinaryTwoPointBatch(
  entries: readonly SceneProjectionEntry[],
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
): ReadonlyMap<string, TwoPointAnchors> | ProjectionFailure {
  const anchorsById = new Map<string, TwoPointAnchors>();
  const ids: string[] = [];
  const pointOffsets: number[] = [];
  const requests: CoordinateDataPoint[] = [];
  const resolutions: (DrawingCoordinateResolution | null)[] = [];
  const splitProjection = !!adapter.resolveDrawingFrameDataPoints
    && !!adapter.projectDrawingFrameResolvedDataPoints;
  for (const { renderEntity } of entries) {
    if (renderEntity.kind !== "line" && renderEntity.kind !== "shape") continue;
    const first = renderEntity.geometry.dataPoints[0];
    const second = renderEntity.geometry.dataPoints[1];
    if (!first || !second) {
      anchorsById.set(renderEntity.id, null);
      continue;
    }
    ids.push(renderEntity.id);
    pointOffsets.push(requests.length);
    requests.push(first, second);
    if (splitProjection) {
      const entityResolutions = resolveCachedDrawingWorldBatch(
        adapter,
        frame,
        renderEntity.geometry.dataPoints,
        renderEntity.geometry,
      );
      if (!entityResolutions || entityResolutions.length !== 2) return PROJECTION_FAILED;
      resolutions.push(...entityResolutions);
    }
  }
  if (requests.length === 0) return anchorsById;
  const projected = splitProjection
    ? projectResolvedBatch(adapter, frame, resolutions, requests)
    : projectBatch(adapter, frame, requests);
  if (projected === PROJECTION_FAILED) return projected;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const pointOffset = pointOffsets[index];
    if (id === undefined || pointOffset === undefined) return PROJECTION_FAILED;
    const first = screenPointAt(projected, pointOffset);
    const second = screenPointAt(projected, pointOffset + 1);
    anchorsById.set(id, first && second ? Object.freeze([first, second] as const) : null);
  }
  return anchorsById;
}

function ordinaryTwoPointAnchors(
  anchorsById: ReadonlyMap<string, TwoPointAnchors>,
  entityId: string,
): TwoPointProjection {
  return anchorsById.has(entityId) ? anchorsById.get(entityId) ?? null : PROJECTION_FAILED;
}

function clipParametricLine(
  a: ScreenPoint,
  b: ScreenPoint,
  width: number,
  height: number,
  mode: "line-segment" | "line-ray" | "line-infinite",
  paintOutset: number,
): readonly [ScreenPoint, ScreenPoint] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return a.x >= -paintOutset && a.x <= width + paintOutset
      && a.y >= -paintOutset && a.y <= height + paintOutset
      ? Object.freeze([a, b])
      : null;
  }
  let minimum = mode === "line-infinite" ? Number.NEGATIVE_INFINITY : 0;
  let maximum = mode === "line-segment" ? 1 : Number.POSITIVE_INFINITY;

  const clipAxis = (origin: number, delta: number, lower: number, upper: number): boolean => {
    if (delta === 0) return origin >= lower && origin <= upper;
    const first = (lower - origin) / delta;
    const second = (upper - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    return minimum <= maximum;
  };

  if (!clipAxis(a.x, dx, -paintOutset, width + paintOutset)
    || !clipAxis(a.y, dy, -paintOutset, height + paintOutset)) return null;
  if (!finiteNumber(minimum) || !finiteNumber(maximum)) return null;
  return Object.freeze([
    Object.freeze({ x: a.x + minimum * dx, y: a.y + minimum * dy }),
    Object.freeze({ x: a.x + maximum * dx, y: a.y + maximum * dy }),
  ]);
}

function linePaintOutsetCssPx(
  lineWidthCssPx: number,
  selected: boolean,
  drawEndpointDots: boolean,
): number {
  if (selected) return Math.max(lineWidthCssPx / 2 + 6, 12);
  return drawEndpointDots
    ? Math.max(lineWidthCssPx, 3)
    : lineWidthCssPx / 2;
}

function linePathPaintOutsetCssPx(lineWidthCssPx: number, selected: boolean): number {
  return selected
    ? Math.max(lineWidthCssPx / 2 + 6, 8)
    : lineWidthCssPx / 2;
}

function pointPaintIntersectsPane(
  point: ScreenPoint,
  outset: number,
  width: number,
  height: number,
): boolean {
  return point.x + outset >= 0
    && point.x - outset <= width
    && point.y + outset >= 0
    && point.y - outset <= height;
}

function projectLine(
  entity: LineDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  anchors: TwoPointProjection,
  selected: boolean,
): EntityProjection {
  if (anchors === PROJECTION_FAILED || anchors === null) return anchors;
  const [a, b] = anchors;
  const unbounded = entity.geometry.lineType === "line-ray"
    || entity.geometry.lineType === "line-infinite";
  let line = clipParametricLine(
    a,
    b,
    frame.widthCssPx,
    frame.heightCssPx,
    entity.geometry.lineType,
    0,
  );
  line ??= clipParametricLine(
    a,
    b,
    frame.widthCssPx,
    frame.heightCssPx,
    entity.geometry.lineType,
    linePathPaintOutsetCssPx(entity.style.lineWidth, selected),
  );
  if (!line && (selected || entity.geometry.lineType === "line-segment")) {
    const anchorOutset = selected ? 12 : Math.max(entity.style.lineWidth, 3);
    if (pointPaintIntersectsPane(a, anchorOutset, frame.widthCssPx, frame.heightCssPx)
      || pointPaintIntersectsPane(b, anchorOutset, frame.widthCssPx, frame.heightCssPx)) {
      line = Object.freeze([a, b]);
    }
  }
  if (!line) return null;
  const points = new Float64Array([
    line[0].x, line[0].y, line[1].x, line[1].y,
    a.x, a.y, b.x, b.y,
  ]);
  const tolerance = 8 + entity.style.lineWidth / 2;
  return createProjectedEntity(entity, points, {
    bbox: Object.freeze([
      Math.min(line[0].x, line[1].x),
      Math.min(line[0].y, line[1].y),
      Math.max(line[0].x, line[1].x),
      Math.max(line[0].y, line[1].y),
    ]),
    handles: new Float64Array([a.x, a.y, b.x, b.y]),
    handleNames: Object.freeze(["start", "end"]),
    handleResults: Object.freeze([null, null]),
    hitZones: Object.freeze([
      Object.freeze({
        kind: "point" as const,
        name: "start",
        pointOffset: 2,
        pointCount: 1,
        tolerance: 7 + entity.style.lineWidth,
        result: Object.freeze({ pointIndex: 0 }),
      }),
      Object.freeze({
        kind: "point" as const,
        name: "end",
        pointOffset: 3,
        pointCount: 1,
        tolerance: 7 + entity.style.lineWidth,
        result: Object.freeze({ pointIndex: 1 }),
      }),
      Object.freeze({
        kind: "polyline" as const,
        name: "line",
        pointOffset: 0,
        pointCount: 2,
        tolerance,
        result: Object.freeze({ pointIndex: -1 }),
      }),
    ]),
    ...(unbounded ? { unboundedAxis: "both" as const } : {}),
    renderSpec: Object.freeze({
      op: "line" as const,
      lineType: entity.geometry.lineType,
      strokeColor: entity.style.color,
      selectionHighlightColor: legacyLineAlpha(entity.style.color, 0.15),
      lineWidthCssPx: entity.style.lineWidth,
      selected,
      mainPointOffset: 0 as const,
      anchorPointOffset: 2 as const,
      drawEndpointDots: entity.geometry.lineType === "line-segment",
    }),
  });
}

function projectAxisLine(
  entity: AxisLineDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const anchor = entity.geometry.dataPoint;
  if (!anchor) return null;
  const projected = projectBatch(adapter, frame, [anchor], entity.geometry);
  if (projected === PROJECTION_FAILED) return projected;
  const x = finiteNumber(projected[0]) ? Number(projected[0]) : null;
  const y = finiteNumber(projected[1]) ? Number(projected[1]) : null;
  const values: number[] = [];
  const hitZones: DrawingDisplayHitZone[] = [];
  const tolerance = 8 + entity.style.lineWidth / 2;
  const type = entity.geometry.axisLineType;
  const horizontal = y !== null && (type === "horizontal" || type === "cross");
  const vertical = x !== null && (type === "vertical" || type === "cross");
  if (horizontal) {
    const offset = pushPair(values, { x: 0, y }, { x: frame.widthCssPx, y });
    hitZones.push(Object.freeze({
      kind: "polyline", name: "horizontal", pointOffset: offset, pointCount: 2, tolerance,
      result: Object.freeze({ pointIndex: -1, zone: "horizontal" }),
    }));
  }
  if (vertical) {
    const offset = pushPair(values, { x, y: 0 }, { x, y: frame.heightCssPx });
    hitZones.push(Object.freeze({
      kind: "polyline", name: "vertical", pointOffset: offset, pointCount: 2, tolerance,
      result: Object.freeze({ pointIndex: -1, zone: "vertical" }),
    }));
  }
  if (!horizontal && !vertical) return null;
  const lineBbox = bboxFromValues(values);
  if (selected && x !== null && y !== null) {
    const anchorOffset = pushPoint(values, { x, y });
    hitZones.unshift(Object.freeze({
      kind: "point",
      name: "center",
      pointOffset: anchorOffset,
      pointCount: 1,
      tolerance: 7 + entity.style.lineWidth,
      result: Object.freeze({ pointIndex: 0, zone: "center" }),
    }));
  }
  const unboundedAxis: DrawingDisplayUnboundedAxis = horizontal && vertical
    ? "both"
    : horizontal ? "horizontal" : "vertical";
  return createProjectedEntity(entity, new Float64Array(values), {
    bbox: lineBbox,
    ...(x !== null && y !== null ? {
      handles: new Float64Array([x, y]),
      handleNames: Object.freeze(["center"]),
      handleResults: Object.freeze([null]),
    } : {}),
    hitZones: Object.freeze(hitZones),
    unboundedAxis,
    renderSpec: Object.freeze({
      op: "axis-line" as const,
      axisLineType: type,
      strokeColor: entity.style.color,
      selectionHighlightColor: legacyPaintAlpha(entity.style.color, 0.18),
      lineWidthCssPx: entity.style.lineWidth,
      selected,
      segmentPointOffset: 0 as const,
      segmentCount: horizontal && vertical ? 2 as const : 1 as const,
      anchorPointOffset: selected && x !== null && y !== null
        ? (horizontal && vertical ? 4 : 2)
        : null,
    }),
  });
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function angleWithinSweep(angle: number, start: number, delta: number): boolean {
  const offset = shortestAngleDelta(start, angle);
  return delta >= 0 ? offset >= 0 && offset <= delta : offset <= 0 && offset >= delta;
}

function formatAngle(degrees: number): string {
  const rounded = degrees >= 10
    ? Math.round(degrees * 10) / 10
    : Math.round(degrees * 100) / 100;
  return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}°`;
}

function measuredTextWidth(
  adapter: DrawingSceneProjectionAdapter,
  request: DrawingSceneTextMeasureRequest,
): number {
  try {
    const measured = adapter.measureText?.(request);
    const width = typeof measured === "number" ? measured : measured?.width;
    if (finiteNumber(width) && width >= 0) return width;
  } catch {
    // Deterministic fallback keeps shadow projection available without canvas.
  }
  return [...request.text].reduce((width, character) => (
    width + (character.charCodeAt(0) > 0xff ? request.fontSize : request.fontSize * 0.62)
  ), 0);
}

function projectAngle(
  entity: AngleDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const anchors = projectTwoDataPoints(entity, frame, adapter);
  if (anchors === PROJECTION_FAILED || anchors === null) return anchors;
  const [a, b] = anchors;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return null;
  const refDir = dx >= 0 ? 1 : -1;
  const refLen = Math.max(Math.abs(dx), Math.min(distance, 80), 32);
  const startAngle = refDir > 0 ? 0 : Math.PI;
  const delta = shortestAngleDelta(startAngle, Math.atan2(dy, dx));
  const radius = Math.min(Math.max(18, distance * 0.28), 54);
  const labelAngle = startAngle + delta / 2;
  const labelRadius = radius + 16;
  const labelCenter = {
    x: a.x + Math.cos(labelAngle) * labelRadius,
    y: a.y + Math.sin(labelAngle) * labelRadius,
  };
  const values: number[] = [];
  const tolerance = 8 + entity.style.lineWidth / 2;
  const hitZones: DrawingDisplayHitZone[] = [];
  const lineOffset = pushPair(values, a, b);
  hitZones.push(
    Object.freeze({
      kind: "point",
      name: "vertex",
      pointOffset: lineOffset,
      pointCount: 1,
      tolerance: 7 + entity.style.lineWidth,
      result: Object.freeze({ pointIndex: 0, zone: "vertex" }),
    }),
    Object.freeze({
      kind: "point",
      name: "ray",
      pointOffset: lineOffset + 1,
      pointCount: 1,
      tolerance: 7 + entity.style.lineWidth,
      result: Object.freeze({ pointIndex: 1, zone: "ray" }),
    }),
  );
  hitZones.push(Object.freeze({
    kind: "polyline", name: "line", pointOffset: lineOffset, pointCount: 2, tolerance,
    result: Object.freeze({ pointIndex: -1, zone: "line" }),
  }));
  const baselineOffset = pushPair(
    values,
    a,
    { x: a.x + refDir * refLen, y: a.y },
  );
  hitZones.push(Object.freeze({
    kind: "polyline", name: "baseline", pointOffset: baselineOffset, pointCount: 2, tolerance,
    result: Object.freeze({ pointIndex: -1, zone: "baseline" }),
  }));
  const arcSegments = Math.max(8, Math.ceil(Math.abs(delta) * 12));
  const arcOffset = values.length / 2;
  for (let index = 0; index <= arcSegments; index += 1) {
    const angle = startAngle + delta * (index / arcSegments);
    pushPoint(values, {
      x: a.x + Math.cos(angle) * radius,
      y: a.y + Math.sin(angle) * radius,
    });
  }
  hitZones.push(Object.freeze({
    kind: "arc",
    name: "arc",
    pointOffset: lineOffset,
    pointCount: 1,
    tolerance,
    startAngle,
    angleDelta: delta,
    radius,
    angleTolerance: 0.08,
    result: Object.freeze({ pointIndex: -1, zone: "arc" }),
  }));
  const label = formatAngle(Math.abs(delta) * 180 / Math.PI);
  const fontSize = 11;
  const labelWidth = measuredTextWidth(adapter, {
    text: label,
    fontFamily: "sans-serif",
    fontSize,
    bold: false,
    italic: false,
    fontWeight: 600,
  }) + 10;
  const labelHeight = fontSize + 6;
  const labelOffset = pushPair(values, {
    x: labelCenter.x - labelWidth / 2,
    y: labelCenter.y - labelHeight / 2,
  }, {
    x: labelCenter.x + labelWidth / 2,
    y: labelCenter.y + labelHeight / 2,
  });
  hitZones.unshift(Object.freeze({
    kind: "box", name: "label", pointOffset: labelOffset, pointCount: 2, tolerance: 0,
    result: Object.freeze({ pointIndex: -1, zone: "label" }),
  }));
  const exactBboxValues = [
    a.x, a.y,
    b.x, b.y,
    a.x + refDir * refLen, a.y,
    labelCenter.x - labelWidth / 2, labelCenter.y - labelHeight / 2,
    labelCenter.x + labelWidth / 2, labelCenter.y + labelHeight / 2,
  ];
  for (const angle of [startAngle, startAngle + delta, 0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (!angleWithinSweep(angle, startAngle, delta)) continue;
    exactBboxValues.push(
      a.x + Math.cos(angle) * radius,
      a.y + Math.sin(angle) * radius,
    );
  }
  return createProjectedEntity(entity, new Float64Array(values), {
    bbox: bboxFromValues(exactBboxValues),
    renderSpec: Object.freeze({
      op: "angle" as const,
      strokeColor: entity.style.color,
      selectionHighlightColor: legacyPaintAlpha(entity.style.color, 0.18),
      lineWidthCssPx: entity.style.lineWidth,
      selected,
      rayPointOffset: lineOffset,
      baselinePointOffset: baselineOffset,
      arcPointOffset: arcOffset,
      arcPointCount: arcSegments + 1,
      labelBoxPointOffset: labelOffset,
      labelText: label,
    }),
    handles: new Float64Array([a.x, a.y, b.x, b.y]),
    handleNames: Object.freeze(["vertex", "ray"]),
    handleResults: Object.freeze([null, null]),
    hitZones: Object.freeze(hitZones),
  });
}

function projectFibonacci(
  entity: FibonacciDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const anchors = projectTwoDataPoints(entity, frame, adapter);
  if (anchors === PROJECTION_FAILED || anchors === null) return anchors;
  const [a, b] = anchors;
  const values: number[] = [];
  const hitZones: DrawingDisplayHitZone[] = [];
  const tolerance = 8 + entity.style.lineWidth / 2;
  const trendOffset = pushPair(values, a, b);
  hitZones.push(
    Object.freeze({
      kind: "point",
      name: "start",
      pointOffset: trendOffset,
      pointCount: 1,
      tolerance: 7 + entity.style.lineWidth,
      result: Object.freeze({ pointIndex: 0 }),
    }),
    Object.freeze({
      kind: "point",
      name: "end",
      pointOffset: trendOffset + 1,
      pointCount: 1,
      tolerance: 7 + entity.style.lineWidth,
      result: Object.freeze({ pointIndex: 1 }),
    }),
    Object.freeze({
      kind: "polyline",
      name: "trend",
      pointOffset: trendOffset,
      pointCount: 2,
      tolerance,
      result: Object.freeze({ pointIndex: -1 }),
    }),
  );
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const startY = entity.geometry.inverted ? b.y : a.y;
  const endY = entity.geometry.inverted ? a.y : b.y;
  const firstPrice = entity.geometry.dataPoints[0]?.price ?? 0;
  const secondPrice = entity.geometry.dataPoints[1]?.price ?? 0;
  const startPrice = entity.geometry.inverted ? secondPrice : firstPrice;
  const endPrice = entity.geometry.inverted ? firstPrice : secondPrice;
  let labelBbox: readonly [number, number, number, number] | null = null;
  const labelFontSize = 11;
  const levelLines: Array<Readonly<{
    color: string;
    level: number;
    logicalPrice: number;
    pointOffset: number;
  }>> = [];
  for (const level of entity.style.levels) {
    if (!level.enabled || !finiteNumber(level.level)) continue;
    const y = startY + (endY - startY) * level.level;
    const logicalPrice = startPrice + (endPrice - startPrice) * level.level;
    const offset = pushPair(values, { x: left, y }, { x: right, y });
    levelLines.push(Object.freeze({
      color: level.color,
      level: level.level,
      logicalPrice,
      pointOffset: offset,
    }));
    const labelText = `${level.level} (${logicalPrice.toFixed(2)})`;
    const labelLeft = left + 4;
    const labelBottom = y - 2;
    labelBbox = unionBboxes(labelBbox, Object.freeze([
      labelLeft,
      labelBottom - labelFontSize,
      labelLeft + measuredTextWidth(adapter, {
        text: labelText,
        fontFamily: "sans-serif",
        fontSize: labelFontSize,
        bold: false,
        italic: false,
      }),
      labelBottom,
    ]));
    hitZones.push(Object.freeze({
      kind: "polyline",
      name: `level:${level.level}`,
      pointOffset: offset,
      pointCount: 2,
      tolerance,
      result: Object.freeze({ pointIndex: -1 }),
    }));
  }
  return createProjectedEntity(entity, new Float64Array(values), {
    bbox: unionBboxes(bboxFromValues(values), labelBbox),
    renderSpec: Object.freeze({
      op: "fibonacci" as const,
      strokeColor: entity.style.color,
      selectionHighlightColor: legacyPaintAlpha(entity.style.color, 0.15),
      lineWidthCssPx: entity.style.lineWidth,
      selected,
      trendPointOffset: trendOffset,
      startPrice,
      endPrice,
      levelLines: Object.freeze(levelLines),
    }),
    handles: new Float64Array([a.x, a.y, b.x, b.y]),
    handleNames: Object.freeze(["start", "end"]),
    handleResults: Object.freeze([null, null]),
    hitZones: Object.freeze(hitZones),
  });
}

function boxHandles(
  left: number,
  top: number,
  right: number,
  bottom: number,
): Float64Array {
  const middleX = (left + right) / 2;
  const middleY = (top + bottom) / 2;
  return new Float64Array([
    left, top,
    middleX, top,
    right, top,
    right, middleY,
    right, bottom,
    middleX, bottom,
    left, bottom,
    left, middleY,
  ]);
}

function projectShape(
  entity: ShapeDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  anchors: TwoPointProjection,
  selected: boolean,
): EntityProjection {
  if (anchors === PROJECTION_FAILED || anchors === null) return anchors;
  const [a, b] = anchors;
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const values: number[] = [left, top, right, bottom];
  if (entity.geometry.shapeType === "rectangle") {
    values.push(
      left, top,
      right, top,
      right, bottom,
      left, bottom,
      left, top,
    );
  } else {
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const radiusX = (right - left) / 2;
    const radiusY = (bottom - top) / 2;
    const segments = 48;
    for (let index = 0; index <= segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      values.push(
        centerX + Math.cos(angle) * radiusX,
        centerY + Math.sin(angle) * radiusY,
      );
    }
  }
  const tolerance = 8 + entity.style.lineWidth / 2;
  const handles = boxHandles(left, top, right, bottom);
  return createProjectedEntity(entity, new Float64Array(values), {
    bbox: Object.freeze([left, top, right, bottom]),
    handles,
    handleNames: BOX_HANDLE_NAMES,
    handleTolerance: 7 + entity.style.lineWidth,
    handleResults: Object.freeze(BOX_HANDLE_NAMES.map((name) => Object.freeze({
      zone: name,
      handle: name,
      pointIndex: -1,
    }))),
    hitZones: Object.freeze([
      Object.freeze({
        kind: entity.geometry.shapeType === "ellipse" ? "ellipse" as const : "box" as const,
        name: entity.geometry.shapeType,
        pointOffset: 0,
        pointCount: 2,
        tolerance,
        result: Object.freeze({ zone: "body", pointIndex: -1 }),
      }),
    ]),
    renderSpec: Object.freeze({
      op: "shape" as const,
      shapeType: entity.geometry.shapeType,
      strokeColor: entity.style.color,
      fillPaintColor: entity.style.fillColor !== "transparent" && entity.style.fillOpacity > 0
        ? legacyPaintAlpha(entity.style.fillColor, entity.style.fillOpacity)
        : null,
      lineWidthCssPx: entity.style.lineWidth,
      lineStyle: entity.style.lineStyle,
      selected,
      boxPointOffset: 0 as const,
    }),
  });
}

function wrapTextLine(
  line: string,
  maxWidth: number | null,
  measure: (text: string) => number,
): string[] {
  if (!line) return [""];
  if (maxWidth === null || maxWidth <= 0 || measure(line) <= maxWidth) return [line];
  const output: string[] = [];
  let buffer = "";
  for (const token of line.split(/(\s+)/)) {
    const candidate = buffer + token;
    if (measure(candidate) <= maxWidth) {
      buffer = candidate;
      continue;
    }
    if (buffer) output.push(buffer.trimEnd());
    buffer = "";
    if (measure(token) <= maxWidth) {
      buffer = token;
      continue;
    }
    let chunk = "";
    for (const character of token) {
      if (!chunk || measure(chunk + character) <= maxWidth) {
        chunk += character;
      } else {
        output.push(chunk);
        chunk = character;
      }
    }
    buffer = chunk;
  }
  if (buffer) output.push(buffer.trimEnd());
  return output.length > 0 ? output : [""];
}

function projectText(
  entity: TextDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const projected = projectBatch(
    adapter,
    frame,
    [entity.geometry.dataPoint],
    entity.geometry,
  );
  if (projected === PROJECTION_FAILED) return projected;
  const anchor = screenPointAt(projected, 0);
  if (!anchor) return null;
  const requestBase = {
    fontFamily: entity.style.fontFamily,
    fontSize: entity.style.fontSize,
    bold: entity.style.bold,
    italic: entity.style.italic,
  };
  const measure = (text: string) => measuredTextWidth(adapter, { text, ...requestBase });
  const padding = entity.style.padding;
  const innerWidthCap = entity.style.widthPx
    ? Math.max(0, entity.style.widthPx - 2 * padding)
    : null;
  const lines = entity.style.text.split("\n").flatMap(
    (line) => wrapTextLine(line, innerWidthCap, measure),
  );
  if (lines.length === 0) lines.push("");
  const measuredLines = lines.map((text) => Object.freeze({
    text,
    widthCssPx: measure(text),
  }));
  const measuredWidth = measuredLines.reduce(
    (width, line) => Math.max(width, line.widthCssPx),
    0,
  );
  const innerWidth = innerWidthCap ?? measuredWidth;
  const lineHeight = entity.style.fontSize * 1.3;
  const width = innerWidth + padding * 2;
  const height = measuredLines.length * lineHeight + padding * 2;
  const right = anchor.x + width;
  const bottom = anchor.y + height;
  return createProjectedEntity(entity, new Float64Array([
    anchor.x, anchor.y,
    right, bottom,
  ]), {
    bbox: Object.freeze([anchor.x, anchor.y, right, bottom]),
    renderSpec: Object.freeze({
      op: "text" as const,
      strokeColor: entity.style.color,
      lineWidthCssPx: Math.max(1, entity.style.borderWidth),
      selected,
      boxPointOffset: 0,
      lines: Object.freeze(measuredLines),
      textColor: entity.style.color,
      fontSizeCssPx: entity.style.fontSize,
      fontFamily: entity.style.fontFamily,
      bold: entity.style.bold,
      italic: entity.style.italic,
      underline: entity.style.underline,
      align: entity.style.align,
      backgroundColor: entity.style.bgColor,
      borderColor: entity.style.borderColor,
      borderWidthCssPx: entity.style.borderWidth,
      paddingCssPx: padding,
      lineHeightCssPx: lineHeight,
      selectionColor: "#3b82f6",
    }),
    handles: boxHandles(anchor.x, anchor.y, right, bottom),
    handleNames: BOX_HANDLE_NAMES,
    handleTolerance: 7,
    handleResults: Object.freeze(BOX_HANDLE_NAMES.map((handle) => Object.freeze({ handle }))),
    hitZones: Object.freeze([Object.freeze({
      kind: "box" as const,
      name: "body",
      pointOffset: 0,
      pointCount: 2,
      tolerance: 2,
      result: Object.freeze({ body: true }),
    })]),
  });
}

function horizontalAnchorDataPoint(
  anchor: HorizontalDrawingAnchor | null,
  price: number,
): DrawingDataPoint | null {
  if (typeof anchor === "number") return finiteNumber(anchor) ? { time: anchor, price } : null;
  return anchor && typeof anchor === "object" ? { ...anchor, price } : null;
}

function projectPosition(
  entity: PositionDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const { entryPrice, slPrice, timeRange, tpPrice } = entity.geometry;
  const start = horizontalAnchorDataPoint(timeRange.start, entryPrice);
  const end = horizontalAnchorDataPoint(timeRange.end, entryPrice);
  if (!start || !end) return null;
  const requests: DrawingDataPoint[] = [start, end];
  const tpIndex = tpPrice === null ? -1 : requests.push({ ...start, price: tpPrice }) - 1;
  const slIndex = slPrice === null ? -1 : requests.push({ ...start, price: slPrice }) - 1;
  const projected = projectBatch(adapter, frame, requests, entity.geometry);
  if (projected === PROJECTION_FAILED) return projected;
  const startPoint = screenPointAt(projected, 0);
  const endPoint = screenPointAt(projected, 1);
  if (!startPoint || !endPoint) return null;
  const requestedWidth = Math.max(24, Math.min(40, frame.barSpacing));
  let left = Math.min(startPoint.x, endPoint.x);
  let right = Math.max(startPoint.x, endPoint.x);
  if (right - left < requestedWidth) {
    const center = (left + right) / 2;
    left = center - requestedWidth / 2;
    right = center + requestedWidth / 2;
  }
  const entryY = startPoint.y;
  const tpPoint = tpIndex < 0 ? null : screenPointAt(projected, tpIndex);
  const slPoint = slIndex < 0 ? null : screenPointAt(projected, slIndex);
  const tpY = tpPoint?.y ?? null;
  const slY = slPoint?.y ?? null;
  const values: number[] = [];
  const hitZones: DrawingDisplayHitZone[] = [];
  const entryOffset = pushPair(values, { x: left, y: entryY }, { x: right, y: entryY });
  hitZones.push(Object.freeze({
    kind: "polyline", name: "entry", pointOffset: entryOffset, pointCount: 2, tolerance: 8,
    result: Object.freeze({ zone: "entry", pointIndex: -1 }),
  }));
  const bodyBounds: Array<readonly [number, number, number, number]> = [];
  const appendPriceZone = (name: "tp" | "sl", y: number): Readonly<{
    bodyOffset: number;
    lineOffset: number;
  }> => {
    const lineOffset = pushPair(values, { x: left, y }, { x: right, y });
    hitZones.push(Object.freeze({
      kind: "polyline", name, pointOffset: lineOffset, pointCount: 2, tolerance: 8,
      result: Object.freeze({ zone: name, pointIndex: -1 }),
    }));
    const top = Math.min(entryY, y);
    const bottom = Math.max(entryY, y);
    const bodyOffset = pushPair(values, { x: left, y: top }, { x: right, y: bottom });
    hitZones.push(Object.freeze({
      kind: "box", name: "body", pointOffset: bodyOffset, pointCount: 2, tolerance: 0,
      result: Object.freeze({ zone: "body", pointIndex: -1 }),
    }));
    bodyBounds.push(Object.freeze([left, top, right, bottom]));
    return Object.freeze({ bodyOffset, lineOffset });
  };
  const tpOffsets = tpY === null ? null : appendPriceZone("tp", tpY);
  const slOffsets = slY === null ? null : appendPriceZone("sl", slY);

  const { upColor, downColor } = frame.themePalette;
  const panelLines = drawingPositionPanelLines({
    currentPrice: drawingPositionCurrentPrice(frame),
    direction: entity.geometry.direction,
    entryPrice,
    positionSize: entity.style.positionSize,
    slPrice,
    themePalette: frame.themePalette,
    tpPrice,
  });
  const panelFont = 11;
  const panelTextWidth = panelLines.reduce((width, line) => {
    const text = `${line.label}: ${line.value}${line.extra ? ` ${line.extra}` : ""}`;
    return Math.max(width, measuredTextWidth(adapter, {
      text,
      fontFamily: "sans-serif",
      fontSize: panelFont,
      bold: false,
      italic: false,
    }));
  }, 0);
  const panelWidth = panelTextWidth + 16;
  const panelHeight = panelLines.length * 17 + 12;
  const panelLeft = positionInfoPanelLeft(
    left,
    right,
    panelWidth,
    entity.style.infoPanelOffset,
  );
  const panelTop = Math.max(4, entryY - panelHeight - 8 + entity.style.infoPanelOffset.y);
  const panelOffset = pushPair(values, {
    x: panelLeft,
    y: panelTop,
  }, {
    x: panelLeft + panelWidth,
    y: panelTop + panelHeight,
  });
  hitZones.push(Object.freeze({
    kind: "box", name: "panel", pointOffset: panelOffset, pointCount: 2, tolerance: 0,
    result: Object.freeze({ zone: "panel", pointIndex: -1 }),
  }));

  const verticalValues = [entryY, ...(tpY === null ? [] : [tpY]), ...(slY === null ? [] : [slY])];
  const top = Math.min(...verticalValues);
  const bottom = Math.max(...verticalValues);
  const mainBbox: readonly [number, number, number, number] = Object.freeze([left, top, right, bottom]);
  const panelBbox: readonly [number, number, number, number] = Object.freeze([
    panelLeft, panelTop, panelLeft + panelWidth, panelTop + panelHeight,
  ]);
  const directionBadgeBbox: readonly [number, number, number, number] = Object.freeze([
    left + 4,
    entryY - 24,
    left + 52,
    entryY - 4,
  ]);
  const middleY = (top + bottom) / 2;
  if (selected) {
    const leftOffset = pushPair(values, { x: left, y: top }, { x: left, y: bottom });
    const rightOffset = pushPair(values, { x: right, y: top }, { x: right, y: bottom });
    hitZones.push(
      Object.freeze({
        kind: "polyline",
        name: "left",
        pointOffset: leftOffset,
        pointCount: 2,
        tolerance: 10,
        result: Object.freeze({ zone: "left", pointIndex: -1 }),
      }),
      Object.freeze({
        kind: "polyline",
        name: "right",
        pointOffset: rightOffset,
        pointCount: 2,
        tolerance: 10,
        result: Object.freeze({ zone: "right", pointIndex: -1 }),
      }),
    );
  }
  const zonePriority = new Map([
    ["panel", 0], ["tp", 1], ["sl", 2], ["entry", 3],
    ["left", 4], ["right", 5], ["body", 6],
  ]);
  const orderedHitZones = [...hitZones].sort(
    (leftZone, rightZone) => Number(zonePriority.get(leftZone.name ?? "") ?? 99)
      - Number(zonePriority.get(rightZone.name ?? "") ?? 99),
  );
  const isLong = entity.geometry.direction === "long";
  const positionLevelSpec = (
    price: number | null,
    offsets: Readonly<{ bodyOffset: number; lineOffset: number }> | null,
  ) => {
    if (price === null || !offsets) return null;
    const presentation = drawingPositionLevelPresentation({
      direction: entity.geometry.direction,
      entryPrice,
      positionSize: entity.style.positionSize,
      themePalette: frame.themePalette,
    }, price);
    return Object.freeze({
      linePointOffset: offsets.lineOffset,
      bodyPointOffset: offsets.bodyOffset,
      ...presentation,
    });
  };
  const tpLevel = positionLevelSpec(tpPrice, tpOffsets);
  const slLevel = positionLevelSpec(slPrice, slOffsets);
  const priceBadgeBbox = (
    level: Readonly<{
      priceText: string;
      percentText: string;
      pnlText: string | null;
    }> | null,
    y: number | null,
  ): readonly [number, number, number, number] | null => {
    if (!level || y === null) return null;
    const text = [
      level.priceText,
      level.percentText,
      ...(level.pnlText ? [level.pnlText] : []),
    ].join("  ");
    const badgeLeft = right + 4;
    const badgeHeight = 18;
    return Object.freeze([
      badgeLeft,
      y - badgeHeight / 2,
      badgeLeft + measuredTextWidth(adapter, {
        text,
        fontFamily: "sans-serif",
        fontSize: 10,
        bold: false,
        italic: false,
      }) + 12,
      y + badgeHeight / 2,
    ]);
  };
  const paintBbox = unionBboxes(
    unionBboxes(
      unionBboxes(mainBbox, panelBbox),
      directionBadgeBbox,
    ),
    unionBboxes(
      priceBadgeBbox(tpLevel, tpY),
      priceBadgeBbox(slLevel, slY),
    ),
  );
  const middleX = (left + right) / 2;
  const handleValues: number[] = [middleX, entryY];
  const handleNames: string[] = ["entry"];
  if (tpY !== null) {
    handleValues.push(middleX, tpY);
    handleNames.push("tp");
  }
  if (slY !== null) {
    handleValues.push(middleX, slY);
    handleNames.push("sl");
  }
  handleValues.push(left, middleY, right, middleY);
  handleNames.push("left", "right");
  if (tpY !== null && slY !== null) {
    handleValues.push(
      left, top,
      right, top,
      left, bottom,
      right, bottom,
    );
    handleNames.push("top-left", "top-right", "bottom-left", "bottom-right");
  }
  return createProjectedEntity(entity, new Float64Array(values), {
    bbox: paintBbox,
    renderSpec: Object.freeze({
      op: "position" as const,
      strokeColor: "#2196f3",
      lineWidthCssPx: 2.5,
      selected,
      entryLinePointOffset: entryOffset,
      entryColor: "#2196f3",
      upColor,
      downColor,
      direction: entity.geometry.direction,
      tpLevel,
      slLevel,
      panelBoxPointOffset: panelOffset,
      panelLines,
      badgeText: isLong ? "LONG" as const : "SHORT" as const,
      badgeColor: isLong ? upColor : downColor,
    }),
    handles: new Float64Array(handleValues),
    handleNames: Object.freeze(handleNames),
    handleResults: Object.freeze(handleNames.map(() => null)),
    hitZones: Object.freeze(orderedHitZones),
  });
}

function chunkProjectionRequests(
  chunks: readonly DrawingBoundsChunk[],
): FreehandChunkProjectionRequest {
  const indexes: number[] = [];
  const points: CoordinateDataPoint[] = [];
  chunks.forEach((chunk, chunkIndex) => {
    const bounds = chunk.bounds;
    if (bounds.kind !== "bounded") return;
    const horizontalMinimum = bounds.horizontalDomain === "time"
      ? { time: bounds.minHorizontal }
      : { logical: bounds.minHorizontal };
    const horizontalMaximum = bounds.horizontalDomain === "time"
      ? { time: bounds.maxHorizontal }
      : { logical: bounds.maxHorizontal };
    indexes.push(chunkIndex);
    points.push(
      { ...horizontalMinimum, price: bounds.minPrice },
      { ...horizontalMaximum, price: bounds.maxPrice },
    );
  });
  return Object.freeze({
    indexes: Object.freeze(indexes),
    points: Object.freeze(points),
  });
}

function cachedChunkProjectionRequests(
  node: DrawingSceneNode,
  chunks: readonly DrawingBoundsChunk[],
  cacheKey: string,
): FreehandChunkProjectionRequest {
  const boundsIdentity = node.entity.geometry as object;
  let byDomain = freehandChunkProjectionRequestCache.get(boundsIdentity);
  if (!byDomain) {
    byDomain = new Map();
    freehandChunkProjectionRequestCache.set(boundsIdentity, byDomain);
  }
  const cached = byDomain.get(cacheKey);
  if (cached) return cached;
  const created = chunkProjectionRequests(chunks);
  byDomain.set(cacheKey, created);
  return created;
}

function visibleFreehandChunks(
  node: DrawingSceneNode,
  chunks: readonly DrawingBoundsChunk[],
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  paintRadiusCssPx: number,
): readonly DrawingBoundsChunk[] | ProjectionFailure {
  const viewport = frame.drawingViewport as DrawingBoundsViewport | null;
  if (!viewport || chunks.length === 0) return chunks;
  const comparable: DrawingBoundsChunk[] = [];
  const incomparable: DrawingBoundsChunk[] = [];
  const lineageFailOpen: DrawingBoundsChunk[] = [];
  const geometry = node.entity.geometry;
  const stroke = geometry.kind === "freehand" || geometry.kind === "highlighter"
    ? geometry.stroke
    : undefined;
  const chunkContainsExactLineage = (chunk: DrawingBoundsChunk): boolean => {
    if (!stroke) {
      const dataPoints = geometry.kind === "freehand" || geometry.kind === "highlighter"
        ? geometry.dataPoints
        : undefined;
      if (!dataPoints) return false;
      for (let index = chunk.segmentStartPointIndex; index < chunk.endPointIndex; index += 1) {
        const point = dataPoints[index];
        if (point && (point.sourceOrdinal !== undefined
          || point.sourceProjection !== undefined
          || point.sourceProjectionConfig !== undefined)) return true;
      }
      return false;
    }
    for (let index = chunk.segmentStartPointIndex; index < chunk.endPointIndex; index += 1) {
      const point = stroke.points[index];
      if (point && ("span" in point || "anchor" in point)) return true;
    }
    return false;
  };
  for (const chunk of chunks) {
    if (chunk.requiresExactProjection) {
      lineageFailOpen.push(chunk);
      continue;
    }
    const domain = chunk.bounds.kind === "deferred" ? null : chunk.bounds.horizontalDomain;
    if (domain === null || domain === viewport.horizontalDomain) comparable.push(chunk);
    else if (chunkContainsExactLineage(chunk)) lineageFailOpen.push(chunk);
    else incomparable.push(chunk);
  }
  // A plain-time bbox cannot safely represent same-source-time ordinals on a
  // derived axis. Keep those bounded chunks as candidates and let the exact
  // lineage projector decide their screen visibility.
  const visible = new Set<DrawingBoundsChunk>([
    ...lineageFailOpen,
    ...comparable.filter((chunk) => drawingGeometryBoundsIntersectsViewport(chunk.bounds, viewport)),
  ]);
  const projectedChunkIntersectsPane = (
    first: ScreenPoint | null,
    second: ScreenPoint | null,
  ): boolean => !first || !second || (
    Math.max(first.x, second.x) >= -paintRadiusCssPx
      && Math.min(first.x, second.x) <= frame.widthCssPx + paintRadiusCssPx
      && Math.max(first.y, second.y) >= -paintRadiusCssPx
      && Math.min(first.y, second.y) <= frame.heightCssPx + paintRadiusCssPx
  );
  // Data-space culling owns the common case. Project bounded corners only for
  // chunks it rejected so thick round/square paint entering a pane edge cannot
  // disappear before the exact screen bbox clip.
  if (paintRadiusCssPx > 0) {
    const rejectedComparable = comparable.filter((chunk) => !visible.has(chunk));
    const request = cachedChunkProjectionRequests(
      node,
      comparable,
      `paint-extent:${viewport.horizontalDomain}`,
    );
    // Warm immutable corner anchors before measured viewport gestures even if
    // every chunk is currently data-visible. Final projection remains lazy.
    if (request.points.length > 0
      && adapter.resolveDrawingFrameDataPoints
      && adapter.projectDrawingFrameResolvedDataPoints) {
      resolveCachedDrawingWorldBatch(adapter, frame, request.points, request.points as object);
    }
    if (rejectedComparable.length > 0) {
      const projected = projectBatch(adapter, frame, request.points, request.points as object);
      if (projected === PROJECTION_FAILED) return projected;
      request.indexes.forEach((comparableIndex, requestIndex) => {
        const chunk = comparable[comparableIndex];
        if (!chunk || visible.has(chunk)) return;
        if (projectedChunkIntersectsPane(
          screenPointAt(projected, requestIndex * 2),
          screenPointAt(projected, requestIndex * 2 + 1),
        )) visible.add(chunk);
      });
    }
    for (const chunk of comparable) {
      if (chunk.bounds.kind !== "bounded") visible.add(chunk);
    }
  }
  if (incomparable.length > 0) {
    const request = cachedChunkProjectionRequests(
      node,
      incomparable,
      `cross-domain:${viewport.horizontalDomain}`,
    );
    const projected = projectBatch(adapter, frame, request.points, request.points as object);
    if (projected === PROJECTION_FAILED) return projected;
    request.indexes.forEach((incomparableIndex, requestIndex) => {
      const chunk = incomparable[incomparableIndex];
      if (!chunk) return;
      const first = screenPointAt(projected, requestIndex * 2);
      const second = screenPointAt(projected, requestIndex * 2 + 1);
      // Unresolved chunk corners fail open; this is still bounded to chunk size.
      if (projectedChunkIntersectsPane(first, second)) visible.add(chunk);
    });
    for (const chunk of incomparable) {
      if (chunk.bounds.kind !== "bounded") visible.add(chunk);
    }
  }
  return Object.freeze(chunks.filter((chunk) => visible.has(chunk)));
}

function mergeChunkRanges(chunks: readonly DrawingBoundsChunk[]): readonly PointRange[] {
  const sorted = [...chunks].sort(
    (left, right) => left.segmentStartPointIndex - right.segmentStartPointIndex,
  );
  const ranges: Array<{ start: number; end: number }> = [];
  for (const chunk of sorted) {
    const start = Math.max(0, chunk.segmentStartPointIndex);
    const end = Math.max(start, chunk.endPointIndex);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)));
}

function expandAndMergePointRanges(
  ranges: readonly PointRange[],
  pointCount: number,
  haloPointCount: number,
): readonly PointRange[] {
  if (haloPointCount <= 0 || ranges.length === 0) return ranges;
  const expanded: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const start = Math.max(0, range.start - haloPointCount);
    const end = Math.min(pointCount, range.end + haloPointCount);
    const previous = expanded.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else expanded.push({ start, end });
  }
  return Object.freeze(expanded.map((range) => Object.freeze(range)));
}

function selectedFreehandRanges(
  node: DrawingSceneNode,
  pointCount: number,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  paintRadiusCssPx: number,
): readonly PointRange[] | ProjectionFailure {
  if (pointCount === 0) return Object.freeze([]);
  if (node.bounds.chunks.length === 0 || !frame.drawingViewport) {
    return Object.freeze([Object.freeze({ start: 0, end: pointCount })]);
  }
  const chunks = visibleFreehandChunks(
    node,
    node.bounds.chunks,
    frame,
    adapter,
    paintRadiusCssPx,
  );
  if (chunks === PROJECTION_FAILED) return chunks;
  return mergeChunkRanges(chunks).map((range) => Object.freeze({
    start: Math.min(pointCount, range.start),
    end: Math.min(pointCount, range.end),
  })).filter((range) => range.start < range.end);
}

function spanProjectionInput(
  stroke: FreehandStroke,
  span: SourceLineageSpan,
): SourceLineageSpanInput {
  return {
    sourceProjection: stroke.sourceProjection,
    sourceProjectionConfig: stroke.sourceProjectionConfig,
    exact: span.exact,
    fallback: span.fallback,
  };
}

function strokeBatchRequest(
  point: FreehandStrokeV3Point,
  stroke: FreehandStroke,
): CoordinateDataPoint | null {
  // A canonical time point still inherits the stroke's source projection
  // identity. The adapter needs that identity to resolve the same source time
  // against derived axes; passing the bare point would silently fall back to
  // plain-time projection and manufacture parity gaps.
  if ("time" in point) {
    return Object.freeze({
      time: point.time,
      sourceProjection: stroke.sourceProjection,
      sourceProjectionConfig: stroke.sourceProjectionConfig,
      price: point.price,
    });
  }
  if ("anchor" in point) {
    return Object.freeze({
      time: point.anchor.time,
      sourceOrdinal: point.anchor.sourceOrdinal,
      sourceProjection: stroke.sourceProjection,
      sourceProjectionConfig: stroke.sourceProjectionConfig,
      price: point.price,
    });
  }
  const span = stroke.spans[point.span];
  if (!span) return null;
  return Object.freeze({
    time: span.exact.left.time,
    sourceOrdinal: span.exact.left.sourceOrdinal,
    sourceProjection: stroke.sourceProjection,
    sourceProjectionConfig: stroke.sourceProjectionConfig,
    price: point.price,
  });
}

// Canonical documents and their strokes are immutable. Retain the adapter
// request wrappers that add stroke-level projection identity so repeated
// viewport scene builds do not allocate one short-lived object per point.
const strokeBatchRequestCache = new WeakMap<
  FreehandStroke,
  readonly CoordinateDataPoint[] | null
>();

function strokeBatchRequests(
  stroke: FreehandStroke,
): readonly CoordinateDataPoint[] | null {
  if (strokeBatchRequestCache.has(stroke)) return strokeBatchRequestCache.get(stroke) ?? null;
  const requests = new Array<CoordinateDataPoint>(stroke.points.length);
  for (let pointIndex = 0; pointIndex < stroke.points.length; pointIndex += 1) {
    const point = stroke.points[pointIndex];
    const request = point ? strokeBatchRequest(point, stroke) : null;
    if (!request) {
      strokeBatchRequestCache.set(stroke, null);
      return null;
    }
    requests[pointIndex] = request;
  }
  const frozen = Object.freeze(requests);
  strokeBatchRequestCache.set(stroke, frozen);
  return frozen;
}

function projectLineageSpanCoordinates(
  stroke: FreehandStroke,
  sourcePointIndexes: Iterable<number>,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
): ReadonlyMap<number, LineageSpanScreenCoordinates> {
  const coordinates = new Map<number, LineageSpanScreenCoordinates>();
  const attempted = new Set<number>();
  for (const pointIndex of sourcePointIndexes) {
    const point = stroke.points[pointIndex];
    if (!point || !("span" in point) || attempted.has(point.span)) continue;
    attempted.add(point.span);
    const span = stroke.spans[point.span];
    if (!span) continue;
    let projected: Readonly<{ left: number; right: number }> | null = null;
    try {
      projected = adapter.projectDrawingFrameSourceLineageSpan(
        frame,
        spanProjectionInput(stroke, span),
      );
    } catch {
      projected = null;
    }
    if (!projected || !finiteNumber(projected.left) || !finiteNumber(projected.right)
      || projected.left >= projected.right) continue;
    coordinates.set(point.span, Object.freeze({
      left: projected.left,
      right: projected.right,
    }));
  }
  return coordinates;
}

function projectedLineageX(
  stroke: FreehandStroke | null,
  sourcePointIndex: number,
  coordinates: ReadonlyMap<number, LineageSpanScreenCoordinates> | null,
): number | null {
  if (!stroke || !coordinates) return null;
  const point = stroke.points[sourcePointIndex];
  if (!point || !("span" in point)) return null;
  const span = coordinates.get(point.span);
  if (!span) return Number.NaN;
  const projected = span.left + (span.right - span.left) * point.ratio;
  return finiteNumber(projected) ? projected : Number.NaN;
}

interface CachedDrawingWorldResolution {
  readonly kind: "world";
  readonly resolutions: readonly (DrawingCoordinateResolution | null)[];
}

interface CachedDrawingLodSelection {
  readonly kind: "lod";
  readonly pathInterpolation: "linear";
  readonly publicationAffinePriceProjection: CertifiedAffinePriceProjection | null;
  readonly selection: DrawingLodSelection;
}

interface CachedDrawingScreenHierarchy {
  readonly kind: "screen-hierarchy";
  readonly hierarchy: DrawingLodHierarchy;
  readonly priceProjectionResidualCssPx: number;
  readonly publicationAffinePriceProjection: CertifiedAffinePriceProjection | null;
  readonly quadraticSmoothingDeviationCssPx: number;
  readonly screenCoordinates: Float64Array;
}

interface LineageSpanScreenCoordinates {
  readonly left: number;
  readonly right: number;
}

interface FreehandLodPlan {
  readonly selection: DrawingLodSelection;
  readonly lineageSpanCoordinates: ReadonlyMap<number, LineageSpanScreenCoordinates> | null;
  readonly pathInterpolation: "linear";
  readonly publicationAffinePriceProjection: CertifiedAffinePriceProjection | null;
}

interface CertifiedAffinePriceProjection {
  readonly interceptCssPx: number;
  readonly maximumPrice: number;
  readonly minimumPrice: number;
  readonly residualCssPx: number;
  readonly slopeCssPxPerPrice: number;
}

const DRAWING_AFFINE_PRICE_PROJECTION_RESIDUAL_LIMIT_CSS_PX = 0.25;
const DRAWING_AFFINE_PRICE_PUBLICATION_ULP_FACTOR = 256;

function certifiedAffinePriceProjection(
  samples: readonly Readonly<{ price: number; coordinateCssPx: number }>[],
  residualLimitCssPx = DRAWING_AFFINE_PRICE_PROJECTION_RESIDUAL_LIMIT_CSS_PX,
): CertifiedAffinePriceProjection | null {
  if (samples.length < 3) return null;
  const ordered = [...samples].sort((left, right) => left.price - right.price);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last || !finiteNumber(first.price) || !finiteNumber(last.price)
    || !finiteNumber(first.coordinateCssPx) || !finiteNumber(last.coordinateCssPx)
    || first.price === last.price) return null;
  const slopeCssPxPerPrice = (last.coordinateCssPx - first.coordinateCssPx)
    / (last.price - first.price);
  const interceptCssPx = first.coordinateCssPx - slopeCssPxPerPrice * first.price;
  if (!finiteNumber(slopeCssPxPerPrice) || !finiteNumber(interceptCssPx)) return null;
  let residualCssPx = 0;
  for (const sample of ordered) {
    if (!finiteNumber(sample.price) || !finiteNumber(sample.coordinateCssPx)) return null;
    const predicted = slopeCssPxPerPrice * sample.price + interceptCssPx;
    residualCssPx = Math.max(residualCssPx, Math.abs(predicted - sample.coordinateCssPx));
  }
  if (!finiteNumber(residualCssPx) || residualCssPx > residualLimitCssPx) return null;
  return Object.freeze({
    interceptCssPx,
    maximumPrice: last.price,
    minimumPrice: first.price,
    residualCssPx,
    slopeCssPxPerPrice,
  });
}

/**
 * Publication is stricter than hierarchy construction. The hierarchy may use
 * a sub-pixel affine proxy because its residual is charged to the LOD error
 * budget; published vertices may bypass the public price projector only when
 * public samples over the actual candidate price domain agree to floating
 * point round-off. The magnitude includes the two potentially cancelling
 * affine terms, not only the small final CSS coordinate.
 */
function certifiedPublicationAffinePriceProjection(
  samples: readonly Readonly<{ price: number; coordinateCssPx: number }>[],
): CertifiedAffinePriceProjection | null {
  let numericMagnitude = 1;
  for (const sample of samples) {
    if (!finiteNumber(sample.price) || !finiteNumber(sample.coordinateCssPx)) return null;
    numericMagnitude = Math.max(numericMagnitude, Math.abs(sample.coordinateCssPx));
  }
  const loose = certifiedAffinePriceProjection(samples);
  if (!loose) return null;
  numericMagnitude = Math.max(numericMagnitude, Math.abs(loose.interceptCssPx));
  for (const sample of samples) {
    numericMagnitude = Math.max(
      numericMagnitude,
      Math.abs(loose.slopeCssPxPerPrice * sample.price),
    );
  }
  const residualLimitCssPx = numericMagnitude
    * Number.EPSILON
    * DRAWING_AFFINE_PRICE_PUBLICATION_ULP_FACTOR;
  return certifiedAffinePriceProjection(samples, residualLimitCssPx);
}

type CachedDrawingProjectionValue =
  | CachedDrawingWorldResolution
  | CachedDrawingLodSelection
  | CachedDrawingScreenHierarchy;

interface DrawingProjectionCache {
  readonly entries: DrawingByteWeightedLruCache<string, CachedDrawingProjectionValue>;
  readonly recentScreenHierarchyKeys: Map<number, string[]>;
  readonly requestIds: WeakMap<object, number>;
  readonly warmedSceneWorldKeys: WeakMap<object, string>;
  nextRequestId: number;
}

const drawingProjectionCaches = new WeakMap<object, DrawingProjectionCache>();
const DRAWING_RECENT_SCREEN_HIERARCHIES_PER_REQUEST = 3;
const DRAWING_RECENT_SCREEN_HIERARCHY_REQUEST_LIMIT = MAX_DRAWING_DOCUMENT_ENTITIES;
const DRAWING_SCREEN_HIERARCHY_METADATA_BUDGET_BYTES = 1024 * 1024;
const DRAWING_SCREEN_HIERARCHY_REQUEST_METADATA_BYTES = 128;
const DRAWING_SCREEN_HIERARCHY_KEY_REFERENCE_BYTES = 16;

function removeRecentDrawingScreenHierarchyKey(
  recentByRequest: Map<number, string[]>,
  hierarchyKey: string,
): void {
  for (const [requestId, recent] of recentByRequest) {
    const index = recent.indexOf(hierarchyKey);
    if (index < 0) continue;
    recent.splice(index, 1);
    if (recent.length === 0) recentByRequest.delete(requestId);
  }
}

function drawingProjectionCache(adapter: DrawingSceneProjectionAdapter): DrawingProjectionCache {
  const key = adapter as object;
  const cached = drawingProjectionCaches.get(key);
  if (cached) return cached;
  const recentScreenHierarchyKeys = new Map<number, string[]>();
  const created: DrawingProjectionCache = {
    entries: new DrawingByteWeightedLruCache({
      budgetBytes: DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES
        - DRAWING_SCREEN_HIERARCHY_METADATA_BUDGET_BYTES,
      onRemove: (value, hierarchyKey) => {
        if (value.kind === "screen-hierarchy") {
          removeRecentDrawingScreenHierarchyKey(
            recentScreenHierarchyKeys,
            hierarchyKey,
          );
        }
      },
    }),
    recentScreenHierarchyKeys,
    requestIds: new WeakMap(),
    warmedSceneWorldKeys: new WeakMap(),
    nextRequestId: 1,
  };
  drawingProjectionCaches.set(key, created);
  return created;
}

/** @internal Exported for a low-cost bound regression without projecting 256 scenes. */
export function retainBoundedDrawingScreenHierarchyMetadata(
  recentByRequest: Map<number, string[]>,
  requestId: number,
  hierarchyKey: string,
  options: Readonly<{
    onEvict: (hierarchyKey: string) => void;
    perRequestLimit: number;
    requestLimit: number;
  }>,
): void {
  const recent = recentByRequest.get(requestId) ?? [];
  recentByRequest.delete(requestId);
  const priorIndex = recent.indexOf(hierarchyKey);
  if (priorIndex >= 0) recent.splice(priorIndex, 1);
  recent.push(hierarchyKey);
  while (recent.length > options.perRequestLimit) {
    const evictedHierarchyKey = recent.shift();
    if (!evictedHierarchyKey) continue;
    options.onEvict(evictedHierarchyKey);
  }
  recentByRequest.set(requestId, recent);
  while (recentByRequest.size > options.requestLimit) {
    const oldest = recentByRequest.entries().next().value as
      | [number, string[]]
      | undefined;
    if (!oldest) break;
    recentByRequest.delete(oldest[0]);
    for (const staleHierarchyKey of oldest[1]) {
      options.onEvict(staleHierarchyKey);
    }
  }
}

function retainRecentDrawingScreenHierarchy(
  cache: DrawingProjectionCache,
  requestId: number,
  hierarchyKey: string,
): void {
  retainBoundedDrawingScreenHierarchyMetadata(
    cache.recentScreenHierarchyKeys,
    requestId,
    hierarchyKey,
    {
      onEvict: (staleHierarchyKey) => {
        deleteDrawingScreenHierarchy(cache, staleHierarchyKey);
      },
      perRequestLimit: DRAWING_RECENT_SCREEN_HIERARCHIES_PER_REQUEST,
      requestLimit: DRAWING_RECENT_SCREEN_HIERARCHY_REQUEST_LIMIT,
    },
  );
}

function deleteDrawingScreenHierarchy(
  cache: DrawingProjectionCache,
  hierarchyKey: string,
): void {
  cache.entries.delete(hierarchyKey);
  for (const toleranceClass of Object.keys(
    DRAWING_LOD_TOLERANCE_CSS_PX,
  ) as DrawingLodToleranceClass[]) {
    cache.entries.delete([
      "lod",
      hierarchyKey,
      toleranceClass,
      "quadratic-source",
    ].join(":"));
    cache.entries.delete([
      "lod",
      hierarchyKey,
      toleranceClass,
      "linear-source",
    ].join(":"));
  }
}

function takeReusableDrawingScreenHierarchy(
  cache: DrawingProjectionCache,
  requestId: number,
  hierarchyKey: string,
  pointCount: number,
): CachedDrawingScreenHierarchy | null {
  const recent = cache.recentScreenHierarchyKeys.get(requestId);
  if (!recent) return null;
  const staleCurrentIndex = recent.indexOf(hierarchyKey);
  if (staleCurrentIndex >= 0) recent.splice(staleCurrentIndex, 1);
  if (recent.length < DRAWING_RECENT_SCREEN_HIERARCHIES_PER_REQUEST) return null;
  const reusableKey = recent.shift();
  if (!reusableKey) return null;
  const reusable = cache.entries.peek(reusableKey);
  deleteDrawingScreenHierarchy(cache, reusableKey);
  return reusable?.kind === "screen-hierarchy"
    && reusable.screenCoordinates.length === pointCount * 2
    && reusable.hierarchy.importanceCssPx.length === pointCount
    ? reusable
    : null;
}

function drawingProjectionRequestId(
  cache: DrawingProjectionCache,
  requestIdentity: object,
): number {
  const cached = cache.requestIds.get(requestIdentity);
  if (cached !== undefined) return cached;
  const created = cache.nextRequestId;
  cache.nextRequestId += 1;
  cache.requestIds.set(requestIdentity, created);
  return created;
}

function projectionRequestIdentityKey(
  cache: DrawingProjectionCache,
  requests: readonly CoordinateDataPoint[],
  requestIdentity?: object,
): string {
  if (requestIdentity) return `object-${drawingProjectionRequestId(cache, requestIdentity)}`;
  // Short-lived batching arrays must not determine cache identity. Canonical
  // coordinate point objects are immutable, so their ordered identities form
  // the request identity while the WeakMap avoids retaining them.
  return `points-${requests.map(
    (point) => drawingProjectionRequestId(cache, point as object),
  ).join(".")}`;
}

/** Surface/symbol lifecycle boundary for world and LOD caches. */
export function clearDrawingSceneProjectorCaches(
  adapter: DrawingSceneProjectionAdapter,
): void {
  const key = adapter as object;
  const cache = drawingProjectionCaches.get(key);
  cache?.entries.dispose();
  drawingProjectionCaches.delete(key);
}

/** Read-only Phase 9 evidence for the adapter-scoped world/LOD cache. */
export interface DrawingSceneProjectorCacheSnapshot
  extends DrawingByteWeightedLruSnapshot<string> {
  readonly entryBudgetBytes: number;
  readonly entryBytes: number;
  readonly metadataBudgetBytes: number;
  readonly metadataBytes: number;
  readonly recentHierarchyKeyCount: number;
  readonly recentHierarchyKeysPerRequestLimit: number;
  readonly recentRequestCount: number;
  readonly recentRequestLimit: number;
}

export function readDrawingSceneProjectorCacheSnapshot(
  adapter: DrawingSceneProjectionAdapter,
): DrawingSceneProjectorCacheSnapshot | null {
  const cache = drawingProjectionCaches.get(adapter as object);
  if (!cache) return null;
  const entries = cache.entries.snapshot();
  const recentRequestCount = cache.recentScreenHierarchyKeys.size;
  const recentHierarchyKeyCount = [...cache.recentScreenHierarchyKeys.values()]
    .reduce((total, keys) => total + keys.length, 0);
  const metadataBytes = recentRequestCount * DRAWING_SCREEN_HIERARCHY_REQUEST_METADATA_BYTES
    + recentHierarchyKeyCount * DRAWING_SCREEN_HIERARCHY_KEY_REFERENCE_BYTES;
  return Object.freeze({
    ...entries,
    budgetBytes: DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES,
    entryBudgetBytes: entries.budgetBytes,
    entryBytes: entries.totalBytes,
    hardLimitBytes: DRAWING_LOD_MAX_CACHE_BUDGET_BYTES,
    metadataBudgetBytes: DRAWING_SCREEN_HIERARCHY_METADATA_BUDGET_BYTES,
    metadataBytes,
    totalBytes: entries.totalBytes + metadataBytes,
    recentHierarchyKeyCount,
    recentHierarchyKeysPerRequestLimit: DRAWING_RECENT_SCREEN_HIERARCHIES_PER_REQUEST,
    recentRequestCount,
    recentRequestLimit: DRAWING_RECENT_SCREEN_HIERARCHY_REQUEST_LIMIT,
  });
}

function pointToSegmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) {
    const pointDx = px - ax;
    const pointDy = py - ay;
    return pointDx * pointDx + pointDy * pointDy;
  }
  const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const nearestX = ax + ratio * dx;
  const nearestY = ay + ratio * dy;
  const pointDx = px - nearestX;
  const pointDy = py - nearestY;
  return pointDx * pointDx + pointDy * pointDy;
}

/**
 * Conservative distance budget between the legacy midpoint-quadratic stroke
 * and its raw polyline. Each quadratic segment stays inside S-C-E; the
 * control-point distance to chord S-E bounds every point in that triangle.
 */
function quadraticSmoothingDeviationUpperBound(coordinates: Float64Array): number {
  const pointCount = coordinates.length / 2;
  let maximumSquared = 0;
  let runStart = 0;
  while (runStart < pointCount) {
    while (runStart < pointCount && (!finiteNumber(coordinates[runStart * 2])
      || !finiteNumber(coordinates[runStart * 2 + 1]))) runStart += 1;
    if (runStart >= pointCount) break;
    let runEnd = runStart + 1;
    while (runEnd < pointCount && finiteNumber(coordinates[runEnd * 2])
      && finiteNumber(coordinates[runEnd * 2 + 1])) runEnd += 1;
    for (let pointIndex = runStart + 1; pointIndex < runEnd - 1; pointIndex += 1) {
      const controlX = Number(coordinates[pointIndex * 2]);
      const controlY = Number(coordinates[pointIndex * 2 + 1]);
      const startX = pointIndex === runStart + 1
        ? Number(coordinates[runStart * 2])
        : (Number(coordinates[(pointIndex - 1) * 2]) + controlX) / 2;
      const startY = pointIndex === runStart + 1
        ? Number(coordinates[runStart * 2 + 1])
        : (Number(coordinates[(pointIndex - 1) * 2 + 1]) + controlY) / 2;
      const endX = (controlX + Number(coordinates[(pointIndex + 1) * 2])) / 2;
      const endY = (controlY + Number(coordinates[(pointIndex + 1) * 2 + 1])) / 2;
      maximumSquared = Math.max(maximumSquared, pointToSegmentDistanceSquared(
        controlX,
        controlY,
        startX,
        startY,
        endX,
        endY,
      ));
    }
    runStart = runEnd + 1;
  }
  return Math.sqrt(maximumSquared);
}

function resolveCachedDrawingWorldBatch(
  adapter: DrawingSceneProjectionAdapter,
  frame: DrawingFrameSnapshot,
  requests: readonly CoordinateDataPoint[],
  requestIdentity?: object,
): readonly (DrawingCoordinateResolution | null)[] | null {
  if (!adapter.resolveDrawingFrameDataPoints || !adapter.projectDrawingFrameResolvedDataPoints) {
    return null;
  }
  const cache = drawingProjectionCache(adapter);
  const identityKey = projectionRequestIdentityKey(cache, requests, requestIdentity);
  const cacheKey = `world:${identityKey}:${frame.worldRevisionKey}`;
  const cached = cache.entries.get(cacheKey);
  if (cached?.kind === "world" && cached.resolutions.length === requests.length) {
    drawingPerfCounters.setGauge("cacheBytes", cache.entries.totalBytes());
    return cached.resolutions;
  }
  let resolutions: readonly (DrawingCoordinateResolution | null)[] | null = null;
  try {
    resolutions = adapter.resolveDrawingFrameDataPoints(frame, requests);
  } catch {
    resolutions = null;
  }
  if (!resolutions || resolutions.length !== requests.length) return null;
  const owned = Object.freeze(Array.from(resolutions));
  cache.entries.set(cacheKey, Object.freeze({
    kind: "world" as const,
    resolutions: owned,
  }), Math.max(64, cacheKey.length * 2 + owned.length * 32));
  drawingPerfCounters.recordAnchorResolve(requests.length);
  drawingPerfCounters.setGauge("cacheBytes", cache.entries.totalBytes());
  return owned;
}

function resolveFreehandWorldBatch(
  adapter: DrawingSceneProjectionAdapter,
  frame: DrawingFrameSnapshot,
  requests: readonly CoordinateDataPoint[],
): readonly (DrawingCoordinateResolution | null)[] | null {
  return resolveCachedDrawingWorldBatch(adapter, frame, requests, requests as object);
}

/**
 * Resolve every scene-owned source anchor once at the document/world boundary.
 * Viewport culling may then change the visible subset without manufacturing a
 * new source-resolution batch key or touching canonical lineage again.
 */
export function warmDrawingSceneWorldResolutions({
  document,
  nodes,
  frame,
  adapter,
}: DrawingSceneWorldWarmupInput): boolean {
  if (!adapter.resolveDrawingFrameDataPoints || !adapter.projectDrawingFrameResolvedDataPoints) {
    return true;
  }
  const orderedNodes = orderedCurrentNodes(document, nodes);
  if (!orderedNodes) return false;
  const cache = drawingProjectionCache(adapter);
  const warmKey = [
    frame.worldRevisionKey,
    ...orderedNodes.map((node) => `${node.id}:${node.geometryRevision}`),
  ].join("|");
  if (cache.warmedSceneWorldKeys.get(document as object) === warmKey) return true;
  for (const node of orderedNodes) {
    const entity = normalizeDrawingEntityForScene(node.entity);
    if (!entity) continue;
    let requests: readonly CoordinateDataPoint[] | null = null;
    let requestIdentity: object | undefined;
    if (entity.kind === "line" || entity.kind === "shape") {
      requests = entity.geometry.dataPoints;
      requestIdentity = entity.geometry;
    } else if (entity.kind === "axis-line") {
      if (entity.geometry.dataPoint) {
        requests = Object.freeze([entity.geometry.dataPoint]);
        requestIdentity = entity.geometry;
      }
    } else if (entity.kind === "freehand" || entity.kind === "highlighter") {
      requests = entity.geometry.stroke
        ? strokeBatchRequests(entity.geometry.stroke)
        : entity.geometry.dataPoints;
      requestIdentity = requests ?? undefined;
    }
    if (!requests || requests.length === 0) continue;
    if (!resolveCachedDrawingWorldBatch(adapter, frame, requests, requestIdentity)) return false;
  }
  cache.warmedSceneWorldKeys.set(document as object, warmKey);
  return true;
}

function selectFreehandLod(
  adapter: DrawingSceneProjectionAdapter,
  requests: readonly CoordinateDataPoint[],
  resolutions: readonly (DrawingCoordinateResolution | null)[],
  ranges: readonly PointRange[],
  frame: DrawingFrameSnapshot,
  toleranceClass: DrawingLodToleranceClass,
  stroke: FreehandStroke | null,
  quadraticSmoothing: boolean,
): FreehandLodPlan | null {
  const viewport = frame.drawingViewport;
  if (!viewport
    || !finiteNumber(viewport.minLogical)
    || !finiteNumber(viewport.maxLogical)
    || viewport.minLogical === viewport.maxLogical) return null;
  const cache = drawingProjectionCache(adapter);
  const requestId = drawingProjectionRequestId(cache, requests);
  const priceProjectionSamples = viewport.priceProjectionSamples ?? [];
  const priceSignature = priceProjectionSamples.map(
    (sample) => `${sample.price}:${sample.coordinateCssPx}`,
  ).join(",");
  const rangeSignature = ranges.map((range) => `${range.start}-${range.end}`).join(",");
  // Lightweight Charts' horizontal data-coordinate transform is a uniform
  // scale (`barSpacing`) plus translation. RDP distances and the quadratic
  // smoothing bound are translation invariant, so panning must not rebuild a
  // hierarchy whose exact CSS geometry only moved left/right. Keep multiple
  // recent zoom scales in the byte-LRU by keying the scale, not the mutable
  // visible range. The three public inverse-price samples identify the full
  // vertical coordinate frame used by production (including log,
  // percentage/indexed and inverted scales). If a test/partial adapter cannot
  // provide that frame evidence, retain the conservative viewport boundary.
  const viewportGeometryKey = priceProjectionSamples.length >= 3
    ? [
        "translation-invariant",
        frame.axisKind,
        frame.barSpacing,
        viewport.minPrice,
        viewport.maxPrice,
        priceSignature,
      ].join(":")
    : ["viewport", frame.viewportRevision].join(":");
  const hierarchyKey = [
    "screen-hierarchy",
    "public-exact",
    stroke && stroke.spans.length > 0 ? "lineage" : "ordinary",
    requestId,
    frame.worldRevisionKey,
    frame.widthCssPx,
    frame.heightCssPx,
    viewportGeometryKey,
    rangeSignature,
  ].join(":");
  const lodKey = [
    "lod",
    hierarchyKey,
    toleranceClass,
    quadraticSmoothing ? "quadratic-source" : "linear-source",
  ].join(":");
  const cached = cache.entries.get(lodKey);
  if (cached?.kind === "lod") {
    if (cache.entries.has(hierarchyKey)) {
      retainRecentDrawingScreenHierarchy(cache, requestId, hierarchyKey);
    }
    drawingPerfCounters.setGauge("cacheBytes", cache.entries.totalBytes());
    const lineageSpanCoordinates = stroke && stroke.spans.length > 0
      ? projectLineageSpanCoordinates(
          stroke,
          cached.selection.pointIndexes,
          frame,
          adapter,
        )
      : null;
    return Object.freeze({
      selection: cached.selection,
      lineageSpanCoordinates,
      pathInterpolation: cached.pathInterpolation,
      publicationAffinePriceProjection: cached.publicationAffinePriceProjection,
    });
  }

  let hierarchy: DrawingLodHierarchy | null = null;
  let lineageSpanCoordinates: ReadonlyMap<number, LineageSpanScreenCoordinates> | null = null;
  let priceProjectionResidualCssPx = 0;
  let publicationAffinePriceProjection: CertifiedAffinePriceProjection | null = null;
  let quadraticSmoothingDeviationCssPx = 0;
  let screenCoordinates: Float64Array | null = null;
  const cachedHierarchy = cache.entries.get(hierarchyKey);
  if (cachedHierarchy?.kind === "screen-hierarchy") {
    retainRecentDrawingScreenHierarchy(cache, requestId, hierarchyKey);
    hierarchy = cachedHierarchy.hierarchy;
    priceProjectionResidualCssPx = cachedHierarchy.priceProjectionResidualCssPx;
    publicationAffinePriceProjection = cachedHierarchy.publicationAffinePriceProjection;
    quadraticSmoothingDeviationCssPx = cachedHierarchy.quadraticSmoothingDeviationCssPx;
    screenCoordinates = cachedHierarchy.screenCoordinates;
  } else {
    const reusableHierarchy = takeReusableDrawingScreenHierarchy(
      cache,
      requestId,
      hierarchyKey,
      requests.length,
    );
    const candidateIndexes: number[] = [];
    for (const range of ranges) {
      for (let pointIndex = range.start; pointIndex < range.end; pointIndex += 1) {
        candidateIndexes.push(pointIndex);
      }
    }
    if (stroke && stroke.spans.length > 0) {
      lineageSpanCoordinates = projectLineageSpanCoordinates(
        stroke,
        candidateIndexes,
        frame,
        adapter,
      );
    }
    const proxy = reusableHierarchy?.screenCoordinates
      ?? new Float64Array(requests.length * 2);
    proxy.fill(Number.NaN);
    let affinePriceProjection = stroke && stroke.spans.length > 0
      ? certifiedAffinePriceProjection(priceProjectionSamples)
      : null;
    let usedAffineLineageProxy = affinePriceProjection !== null;
    if (affinePriceProjection) {
      let minimumCandidatePrice = Number.POSITIVE_INFINITY;
      let maximumCandidatePrice = Number.NEGATIVE_INFINITY;
      let minimumCandidateIndex = -1;
      let maximumCandidateIndex = -1;
      for (const sourcePointIndex of candidateIndexes) {
        const request = requests[sourcePointIndex];
        const lineageX = projectedLineageX(stroke, sourcePointIndex, lineageSpanCoordinates);
        const price = request?.price;
        if (!request || lineageX === null || !finiteNumber(price)) {
          usedAffineLineageProxy = false;
          break;
        }
        if (price < minimumCandidatePrice) {
          minimumCandidatePrice = price;
          minimumCandidateIndex = sourcePointIndex;
        }
        if (price > maximumCandidatePrice) {
          maximumCandidatePrice = price;
          maximumCandidateIndex = sourcePointIndex;
        }
      }
      const priceEnvelopeEpsilon = Math.max(
        1,
        Math.abs(affinePriceProjection.minimumPrice),
        Math.abs(affinePriceProjection.maximumPrice),
      ) * Number.EPSILON * 8;
      const candidateOutsideSampleEnvelope = usedAffineLineageProxy
        && (minimumCandidatePrice < affinePriceProjection.minimumPrice - priceEnvelopeEpsilon
          || maximumCandidatePrice > affinePriceProjection.maximumPrice + priceEnvelopeEpsilon);
      if (usedAffineLineageProxy) {
        // The inverse pane samples are sufficient for a bounded-error LOD
        // proxy, but not for replacing public priceToCoordinate at
        // publication. Always extend the evidence over the actual candidate
        // domain with public extrema + midpoint projections. This also keeps
        // the existing extrapolation guard for offscreen chunk points.
        const middleCandidatePrice = minimumCandidatePrice / 2 + maximumCandidatePrice / 2;
        const minimumCandidateRequest = requests[minimumCandidateIndex];
        const maximumCandidateRequest = requests[maximumCandidateIndex];
        const evidenceRequests = minimumCandidateRequest && maximumCandidateRequest
          ? Object.freeze([
              minimumCandidateRequest,
              Object.freeze({
                ...minimumCandidateRequest,
                price: middleCandidatePrice,
              }),
              maximumCandidateRequest,
            ])
          : [];
        // Evidence certifies only price -> Y. Null X resolutions avoid three
        // irrelevant time-scale projections and also make the synthetic exact
        // domain midpoint independent of any source anchor.
        const evidenceResolutions = evidenceRequests.map(() => null);
        const finalProject = adapter.projectDrawingFrameResolvedDataPoints;
        let exactEvidence: Float64Array | null = null;
        if (finalProject && evidenceRequests.length === 3) {
          try {
            exactEvidence = finalProject(frame, evidenceResolutions, evidenceRequests);
          } catch {
            exactEvidence = null;
          }
        }
        if (evidenceRequests.length !== 3
          || !validProjectedBuffer(exactEvidence, evidenceRequests.length)) {
          // Failure to cover an extrapolated candidate domain invalidates the
          // proxy. Inside the pane sample envelope, retain the existing loose
          // hierarchy certificate but keep publication on the exact path.
          if (candidateOutsideSampleEnvelope) usedAffineLineageProxy = false;
        } else {
          drawingPerfCounters.recordFinalProjection(evidenceRequests.length);
          const extendedSamples = [...priceProjectionSamples];
          let evidenceComplete = true;
          for (let index = 0; index < evidenceRequests.length; index += 1) {
            const price = evidenceRequests[index]?.price;
            const coordinateCssPx = exactEvidence[index * 2 + 1];
            if (!finiteNumber(price) || !finiteNumber(coordinateCssPx)) {
              evidenceComplete = false;
              break;
            }
            extendedSamples.push(Object.freeze({ price, coordinateCssPx }));
          }
          const extendedAffinePriceProjection = evidenceComplete
            ? certifiedAffinePriceProjection(extendedSamples)
            : null;
          if (extendedAffinePriceProjection) {
            affinePriceProjection = extendedAffinePriceProjection;
            publicationAffinePriceProjection = certifiedPublicationAffinePriceProjection(
              extendedSamples,
            );
          } else if (evidenceComplete || candidateOutsideSampleEnvelope) {
            // Public evidence that disagrees with the proxy is authoritative.
            // A malformed extrapolation sample is equally insufficient to
            // cover the candidate domain.
            usedAffineLineageProxy = false;
          }
        }
      }
    }
    if (affinePriceProjection && usedAffineLineageProxy) {
      for (const sourcePointIndex of candidateIndexes) {
        const request = requests[sourcePointIndex];
        const lineageX = projectedLineageX(stroke, sourcePointIndex, lineageSpanCoordinates);
        const price = request?.price;
        if (!request || lineageX === null || !finiteNumber(price)) {
          usedAffineLineageProxy = false;
          break;
        }
        if (!finiteNumber(lineageX)) continue;
        const y = affinePriceProjection.slopeCssPxPerPrice * price
          + affinePriceProjection.interceptCssPx;
        if (!finiteNumber(y)) {
          usedAffineLineageProxy = false;
          break;
        }
        proxy[sourcePointIndex * 2] = lineageX;
        proxy[sourcePointIndex * 2 + 1] = y;
      }
      if (usedAffineLineageProxy) {
        priceProjectionResidualCssPx = affinePriceProjection.residualCssPx;
      } else {
        proxy.fill(Number.NaN);
      }
    }
    if (!usedAffineLineageProxy) {
      // Non-lineage strokes and price modes whose three public samples do not
      // prove an affine map keep the exact public final projector as the
      // screen-error oracle. The certified lineage fast path above only
      // chooses a hierarchy. Publication bypasses this projector only when a
      // separate machine-precision certificate covers the candidate domain.
      const candidateRequests = candidateIndexes.map(
        (pointIndex) => requests[pointIndex],
      ).filter((request): request is CoordinateDataPoint => request !== undefined);
      const candidateResolutions = candidateIndexes.map(
        (pointIndex) => resolutions[pointIndex] ?? null,
      );
      const finalProject = adapter.projectDrawingFrameResolvedDataPoints;
      if (!finalProject || candidateRequests.length !== candidateIndexes.length) return null;
      let exactProjected: Float64Array | null = null;
      try {
        exactProjected = finalProject(frame, candidateResolutions, candidateRequests);
      } catch {
        exactProjected = null;
      }
      if (!validProjectedBuffer(exactProjected, candidateRequests.length)) return null;
      drawingPerfCounters.recordFinalProjection(candidateRequests.length);
      candidateIndexes.forEach((sourcePointIndex, candidateIndex) => {
        const projectedX = exactProjected?.[candidateIndex * 2];
        const y = exactProjected?.[candidateIndex * 2 + 1];
        const lineageX = projectedLineageX(
          stroke,
          sourcePointIndex,
          lineageSpanCoordinates,
        );
        const x = lineageX ?? projectedX;
        if (!finiteNumber(x) || !finiteNumber(y)) return;
        proxy[sourcePointIndex * 2] = x;
        proxy[sourcePointIndex * 2 + 1] = y;
      });
    }
    quadraticSmoothingDeviationCssPx = quadraticSmoothingDeviationUpperBound(proxy);
    screenCoordinates = proxy;
    const projectionResidualBudgetCssPx = priceProjectionResidualCssPx * 2;
    const supportedImportanceFloors = Object.values(DRAWING_LOD_TOLERANCE_CSS_PX).flatMap(
      (targetToleranceCssPx) => {
        const linearFloor = targetToleranceCssPx - projectionResidualBudgetCssPx;
        const quadraticFloor = linearFloor - quadraticSmoothingDeviationCssPx;
        return [linearFloor, quadraticFloor].filter((floor) => floor >= 0);
      },
    );
    const minimumImportanceCssPx = supportedImportanceFloors.length > 0
      ? Math.min(...supportedImportanceFloors)
      : 0;
    hierarchy = createDrawingLodHierarchy(proxy, {
      ...(reusableHierarchy ? {
        importanceBuffer: reusableHierarchy.hierarchy.importanceCssPx as Float64Array,
      } : {}),
      minimumImportanceCssPx,
    });
    if (hierarchy.finitePointCount === 0) return null;
    const hierarchyCached = cache.entries.set(hierarchyKey, Object.freeze({
      kind: "screen-hierarchy" as const,
      hierarchy,
      priceProjectionResidualCssPx,
      publicationAffinePriceProjection,
      quadraticSmoothingDeviationCssPx,
      screenCoordinates,
    }), Math.max(
      64,
      hierarchyKey.length * 2
        + hierarchy.estimatedByteSize
        + screenCoordinates.byteLength,
    ));
    if (hierarchyCached) retainRecentDrawingScreenHierarchy(cache, requestId, hierarchyKey);
  }

  if (!hierarchy || !screenCoordinates) return null;
  const targetToleranceCssPx = DRAWING_LOD_TOLERANCE_CSS_PX[toleranceClass];
  const smoothingDeviationCssPx = quadraticSmoothing
    ? quadraticSmoothingDeviationCssPx
    : 0;
  const simplificationToleranceCssPx = targetToleranceCssPx
    - smoothingDeviationCssPx
    - priceProjectionResidualCssPx * 2;
  if (!finiteNumber(simplificationToleranceCssPx) || simplificationToleranceCssPx < 0) {
    return null;
  }
  const selection = selectDrawingLod(hierarchy, {
    toleranceClass,
    simplificationToleranceCssPx,
    visibleWidthCssPx: frame.widthCssPx,
  });
  // Nested effective importance is the conservative error certificate for
  // every selected chord: refinement stops only after the owning segment's
  // true maximum error is at or below this threshold. Avoid rescanning every
  // raw point after the hierarchy already proved the same bound.
  const certifiedPolylineErrorCssPx = selection.effectiveToleranceCssPx;
  if (!selection.capSatisfied
    || selection.selectedPointCount >= hierarchy.finitePointCount
    || certifiedPolylineErrorCssPx + smoothingDeviationCssPx
      + priceProjectionResidualCssPx * 2
      > targetToleranceCssPx + 1e-9) return null;
  // Cached hierarchy coordinates may belong to a translated viewport. Never
  // retain those absolute span coordinates in the LOD cache: selected output
  // is always projected against the current atomic frame before publication.
  lineageSpanCoordinates ??= stroke && stroke.spans.length > 0
    ? projectLineageSpanCoordinates(stroke, selection.pointIndexes, frame, adapter)
    : null;
  const plan = Object.freeze({
    selection,
    lineageSpanCoordinates,
    pathInterpolation: "linear" as const,
    publicationAffinePriceProjection,
  });
  cache.entries.set(lodKey, Object.freeze({
    kind: "lod" as const,
    pathInterpolation: plan.pathInterpolation,
    publicationAffinePriceProjection: plan.publicationAffinePriceProjection,
    selection: plan.selection,
  }), Math.max(
    64,
    lodKey.length * 2
      + selection.pointIndexes.byteLength
      + selection.pathBreaks.byteLength
      + selection.paths.length * 32,
  ));
  drawingPerfCounters.setGauge("cacheBytes", cache.entries.totalBytes());
  return plan;
}

function freehandRenderSpec(
  entity: FreehandDrawingRenderEntity,
  selected: boolean,
  pathInterpolation: "linear" | "quadratic" = "quadratic",
): DrawingDisplayRenderSpec {
  return Object.freeze({
    op: "freehand" as const,
    strokeColor: entity.style.color,
    selectionHighlightColor: "#ff6b6b",
    lineWidthCssPx: entity.style.lineWidth,
    opacity: entity.style.opacity,
    compositeOperation: entity.style.compositeOperation,
    brushShape: entity.style.brushShape,
    pathInterpolation,
    selected,
  });
}

function projectFreehandLod(
  entity: FreehandDrawingRenderEntity,
  requests: readonly CoordinateDataPoint[],
  resolutions: readonly (DrawingCoordinateResolution | null)[],
  plan: FreehandLodPlan,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const finalProject = adapter.projectDrawingFrameResolvedDataPoints;
  const { selection } = plan;
  if (selection.selectedPointCount === 0) return null;
  const sourceIndexes = selection.pointIndexes;
  const selectedRequests = new Array<CoordinateDataPoint>(sourceIndexes.length);
  const selectedResolutions = new Array<DrawingCoordinateResolution | null>(sourceIndexes.length);
  // Source-lineage points own X through the already current-frame span
  // projection. Passing their source-anchor resolutions through the public
  // final projector would call timeToCoordinate for every selected point and
  // immediately overwrite those X values below. Keep an explicit ownership
  // bit so unresolved lineage remains a canonical NaN gap, while mixed
  // absolute-time points still receive their ordinary X projection.
  const lineageStroke = entity.geometry.stroke
    && entity.geometry.stroke.spans.length > 0
    && plan.lineageSpanCoordinates
    ? entity.geometry.stroke
    : null;
  const lineageOwnedX = lineageStroke ? new Uint8Array(sourceIndexes.length) : null;
  const selectedLineageX = lineageStroke ? new Float64Array(sourceIndexes.length) : null;
  selectedLineageX?.fill(Number.NaN);
  for (let selectedIndex = 0; selectedIndex < sourceIndexes.length; selectedIndex += 1) {
    const sourcePointIndex = sourceIndexes[selectedIndex];
    const request = sourcePointIndex === undefined ? undefined : requests[sourcePointIndex];
    if (sourcePointIndex === undefined || request === undefined) return PROJECTION_FAILED;
    selectedRequests[selectedIndex] = request;
    const lineageX = lineageStroke
      ? projectedLineageX(
          lineageStroke,
          sourcePointIndex,
          plan.lineageSpanCoordinates,
        )
      : null;
    if (lineageX !== null && lineageOwnedX && selectedLineageX) {
      lineageOwnedX[selectedIndex] = 1;
      selectedLineageX[selectedIndex] = lineageX;
      selectedResolutions[selectedIndex] = null;
    } else {
      selectedResolutions[selectedIndex] = resolutions[sourcePointIndex] ?? null;
    }
  }
  let projected: Float64Array | null = null;
  const publicationAffinePriceProjection = plan.publicationAffinePriceProjection;
  let usePublicationAffinePriceProjection = publicationAffinePriceProjection !== null
    && lineageOwnedX !== null;
  if (usePublicationAffinePriceProjection && publicationAffinePriceProjection) {
    projected = new Float64Array(selectedRequests.length * 2);
    projected.fill(Number.NaN);
    const exactSelectedIndexes: number[] = [];
    const priceDomainEpsilon = Math.max(
      1,
      Math.abs(publicationAffinePriceProjection.minimumPrice),
      Math.abs(publicationAffinePriceProjection.maximumPrice),
    ) * Number.EPSILON * 16;
    for (let selectedIndex = 0; selectedIndex < selectedRequests.length; selectedIndex += 1) {
      if (lineageOwnedX?.[selectedIndex] !== 1) {
        exactSelectedIndexes.push(selectedIndex);
        continue;
      }
      const price = selectedRequests[selectedIndex]?.price;
      if (!finiteNumber(price)
        || price < publicationAffinePriceProjection.minimumPrice - priceDomainEpsilon
        || price > publicationAffinePriceProjection.maximumPrice + priceDomainEpsilon) {
        usePublicationAffinePriceProjection = false;
        break;
      }
      const y = publicationAffinePriceProjection.slopeCssPxPerPrice * price
        + publicationAffinePriceProjection.interceptCssPx;
      if (!finiteNumber(y)) {
        usePublicationAffinePriceProjection = false;
        break;
      }
      projected[selectedIndex * 2 + 1] = y;
    }
    if (usePublicationAffinePriceProjection && exactSelectedIndexes.length > 0) {
      const exactRequests = exactSelectedIndexes.map((index) => selectedRequests[index]).filter(
        (request): request is CoordinateDataPoint => request !== undefined,
      );
      const exactResolutions = exactSelectedIndexes.map(
        (index) => selectedResolutions[index] ?? null,
      );
      let exactProjected: Float64Array | null = null;
      if (finalProject && exactRequests.length === exactSelectedIndexes.length) {
        try {
          exactProjected = finalProject(frame, exactResolutions, exactRequests);
        } catch {
          exactProjected = null;
        }
      }
      if (!validProjectedBuffer(exactProjected, exactRequests.length)) return PROJECTION_FAILED;
      drawingPerfCounters.recordFinalProjection(exactRequests.length);
      exactSelectedIndexes.forEach((selectedIndex, exactIndex) => {
        if (!projected || !exactProjected) return;
        projected[selectedIndex * 2] = exactProjected[exactIndex * 2] ?? Number.NaN;
        projected[selectedIndex * 2 + 1] = exactProjected[exactIndex * 2 + 1] ?? Number.NaN;
      });
    }
  }
  if (!usePublicationAffinePriceProjection) {
    if (!finalProject) return PROJECTION_FAILED;
    try {
      projected = finalProject(frame, selectedResolutions, selectedRequests);
    } catch {
      projected = null;
    }
    if (!validProjectedBuffer(projected, selectedRequests.length)) return PROJECTION_FAILED;
    drawingPerfCounters.recordFinalProjection(selectedRequests.length);
  }
  if (!validProjectedBuffer(projected, selectedRequests.length)) return PROJECTION_FAILED;
  const separatorCount = selection.pathBreaks.length;
  const points = new Float64Array((sourceIndexes.length + separatorCount) * 2);
  const pathBreaks: number[] = [];
  const unresolvedSourcePointIndexes: number[] = [];
  let outputPointIndex = 0;
  let breakOffsetIndex = 0;
  for (let selectedIndex = 0; selectedIndex < sourceIndexes.length; selectedIndex += 1) {
    if (selection.pathBreaks[breakOffsetIndex] === selectedIndex) {
      pathBreaks.push(outputPointIndex);
      points[outputPointIndex * 2] = Number.NaN;
      points[outputPointIndex * 2 + 1] = Number.NaN;
      outputPointIndex += 1;
      breakOffsetIndex += 1;
    }
    const projectedX = projected[selectedIndex * 2];
    const y = projected[selectedIndex * 2 + 1];
    const sourcePointIndex = sourceIndexes[selectedIndex];
    const ownedLineageX = lineageOwnedX?.[selectedIndex] === 1
      ? selectedLineageX?.[selectedIndex]
      : undefined;
    const x = ownedLineageX === undefined ? projectedX : ownedLineageX;
    if (!finiteNumber(x) || !finiteNumber(y)) {
      points[outputPointIndex * 2] = Number.NaN;
      points[outputPointIndex * 2 + 1] = Number.NaN;
      if (sourcePointIndex !== undefined) unresolvedSourcePointIndexes.push(sourcePointIndex);
      pathBreaks.push(outputPointIndex);
    } else {
      points[outputPointIndex * 2] = x;
      points[outputPointIndex * 2 + 1] = y;
    }
    outputPointIndex += 1;
  }
  return createProjectedEntity(entity, points, {
    renderSpec: freehandRenderSpec(entity, selected, plan.pathInterpolation),
    bbox: bboxFromDrawableFreehand(
      points,
      frame.widthCssPx,
      frame.heightCssPx,
      freehandPaintOutsetCssPx(entity.style.lineWidth, entity.style.brushShape),
      plan.pathInterpolation,
    ),
    pathBreaks: new Uint32Array(pathBreaks),
    unresolvedSourcePointIndexes: new Uint32Array(unresolvedSourcePointIndexes),
    canonicalGapCoverageComplete: false,
    hitZones: Object.freeze([Object.freeze({
      kind: "polyline" as const,
      name: "stroke",
      pointOffset: 0,
      pointCount: points.length / 2,
      tolerance: 8 + entity.style.lineWidth / 2,
      result: Object.freeze({ body: true }),
    })]),
  });
}

function projectFreehandCanonicalGapIndexes(
  entity: FreehandDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
): Uint32Array | ProjectionFailure {
  const stroke = entity.geometry.stroke;
  const pointCount = stroke?.points.length ?? entity.geometry.dataPoints.length;
  if (pointCount === 0) return new Uint32Array();
  const requests = stroke ? strokeBatchRequests(stroke) : entity.geometry.dataPoints;
  if (!requests || requests.length !== pointCount) return PROJECTION_FAILED;

  const spanCoordinates = new Map<number, Readonly<{ left: number; right: number }>>();
  if (stroke) {
    for (const point of stroke.points) {
      if (!("span" in point) || spanCoordinates.has(point.span)) continue;
      const span = stroke.spans[point.span];
      if (!span) continue;
      let projected: Readonly<{ left: number; right: number }> | null = null;
      try {
        projected = adapter.projectDrawingFrameSourceLineageSpan(
          frame,
          spanProjectionInput(stroke, span),
        );
      } catch {
        projected = null;
      }
      if (!projected || !finiteNumber(projected.left) || !finiteNumber(projected.right)
        || projected.left >= projected.right) continue;
      spanCoordinates.set(point.span, projected);
    }
  }

  const projected = projectBatch(adapter, frame, requests, requests as object);
  if (projected === PROJECTION_FAILED) return projected;
  const unresolved: number[] = [];
  const splitOnUnresolved = stroke !== null || frame.axisKind === "derived-ordinal";
  if (!splitOnUnresolved) return new Uint32Array();
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    let x = projected[pointIndex * 2];
    const y = projected[pointIndex * 2 + 1];
    const strokePoint = stroke?.points[pointIndex];
    if (strokePoint && "span" in strokePoint) {
      const span = spanCoordinates.get(strokePoint.span);
      x = span
        ? span.left + (span.right - span.left) * strokePoint.ratio
        : Number.NaN;
    }
    if (!finiteNumber(x) || !finiteNumber(y)) unresolved.push(pointIndex);
  }
  return new Uint32Array(unresolved);
}

function projectFreehandRanges(
  entity: FreehandDrawingRenderEntity,
  ranges: readonly PointRange[],
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
): EntityProjection {
  const stroke = entity.geometry.stroke;
  const sourcePointCount = stroke?.points.length ?? entity.geometry.dataPoints.length;
  if (ranges.length === 0) return null;
  const canonicalRequests = stroke ? strokeBatchRequests(stroke) : entity.geometry.dataPoints;
  if (!canonicalRequests) return PROJECTION_FAILED;
  const coversFullSource = ranges.length === 1
    && ranges[0]?.start === 0
    && ranges[0]?.end === sourcePointCount;
  const singleRange = ranges.length === 1 ? ranges[0] : undefined;
  // Canonical V3 time/anchor strokes without lineage spans need no point-index
  // remapping. Reuse the adapter's validated buffer until the display-list
  // builder makes its final owned copy, avoiding two JS index scans and one
  // temporary coordinate-buffer copy on the common full-stroke path.
  if (stroke && stroke.spans.length === 0 && singleRange) {
    const requests = coversFullSource
      ? canonicalRequests
      : canonicalRequests.slice(singleRange.start, singleRange.end);
    if (requests.length !== singleRange.end - singleRange.start) return PROJECTION_FAILED;
    const projected = projectBatch(
      adapter,
      frame,
      requests,
      coversFullSource ? canonicalRequests as object : undefined,
    );
    if (projected === PROJECTION_FAILED) return projected;
    const pathBreaks: number[] = [];
    const unresolvedSourcePointIndexes: number[] = [];
    let points = projected;
    let normalizedCopy: Float64Array | null = null;
    for (let pointIndex = 0; pointIndex < requests.length; pointIndex += 1) {
      const offset = pointIndex * 2;
      const x = projected[offset];
      const y = projected[offset + 1];
      if (finiteNumber(x) && finiteNumber(y)) continue;
      pathBreaks.push(pointIndex);
      unresolvedSourcePointIndexes.push(singleRange.start + pointIndex);
      if (!Number.isNaN(x) || !Number.isNaN(y)) {
        normalizedCopy ??= projected.slice();
        normalizedCopy[offset] = Number.NaN;
        normalizedCopy[offset + 1] = Number.NaN;
      }
    }
    if (normalizedCopy) points = normalizedCopy;
    return createProjectedEntity(entity, points, {
      renderSpec: freehandRenderSpec(entity, selected),
      bbox: bboxFromDrawableFreehand(
        points,
        frame.widthCssPx,
        frame.heightCssPx,
        freehandPaintOutsetCssPx(entity.style.lineWidth, entity.style.brushShape),
        entity.style.brushShape === "square" ? "linear" : "quadratic",
      ),
      pathBreaks: new Uint32Array(pathBreaks),
      unresolvedSourcePointIndexes: new Uint32Array(unresolvedSourcePointIndexes),
      canonicalGapCoverageComplete: coversFullSource,
      hitZones: Object.freeze([Object.freeze({
        kind: "polyline" as const,
        name: "stroke",
        pointOffset: 0,
        pointCount: points.length / 2,
        tolerance: 8 + entity.style.lineWidth / 2,
        result: Object.freeze({ body: true }),
      })]),
    });
  }
  const selectedIndexes: number[] = [];
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) selectedIndexes.push(index);
  }
  const requests: readonly CoordinateDataPoint[] = coversFullSource
    ? canonicalRequests
    : selectedIndexes.map((pointIndex) => canonicalRequests[pointIndex]).filter(
      (request): request is CoordinateDataPoint => request !== undefined,
    );
  if (requests.length !== selectedIndexes.length) return PROJECTION_FAILED;

  const spanCoordinates = new Map<number, Readonly<{ left: number; right: number }>>();
  if (stroke) {
    for (const pointIndex of selectedIndexes) {
      const point = stroke.points[pointIndex];
      if (!point || !("span" in point) || spanCoordinates.has(point.span)) continue;
      const span = stroke.spans[point.span];
      if (!span) continue;
      let projected: Readonly<{ left: number; right: number }> | null = null;
      try {
        projected = adapter.projectDrawingFrameSourceLineageSpan(
          frame,
          spanProjectionInput(stroke, span),
        );
      } catch {
        projected = null;
      }
      // An unresolved lineage span is a canonical path gap, not a scene-wide
      // failure. The final batch projection below still rejects a stale frame
      // atomically, so a null span resolver cannot publish stale geometry.
      if (!projected || !finiteNumber(projected.left) || !finiteNumber(projected.right)
        || projected.left >= projected.right) continue;
      spanCoordinates.set(point.span, projected);
    }
  }
  // This final adapter call also makes a stale frame discovered by an earlier
  // span projection fail the whole scene instead of publishing partial paths.
  const projected = projectBatch(
    adapter,
    frame,
    requests,
    coversFullSource ? canonicalRequests as object : undefined,
  );
  if (projected === PROJECTION_FAILED) return projected;
  const pathBreaks: number[] = [];
  const unresolvedSourcePointIndexes: number[] = [];
  const splitOnUnresolved = stroke !== null || frame.axisKind === "derived-ordinal";
  // Stroke/ordinal paths publish exactly one pair per selected source point
  // plus one separator per disjoint range. Write that known shape directly
  // into its final typed buffer instead of growing a JS array and copying it.
  const fixedValues = splitOnUnresolved
    ? new Float64Array((selectedIndexes.length + Math.max(0, ranges.length - 1)) * 2)
    : null;
  const dynamicValues: number[] = [];
  let outputPointCount = 0;
  let selectedCursor = 0;
  ranges.forEach((range, rangeIndex) => {
    if (rangeIndex > 0) {
      pathBreaks.push(outputPointCount);
      if (fixedValues) {
        fixedValues[outputPointCount * 2] = Number.NaN;
        fixedValues[outputPointCount * 2 + 1] = Number.NaN;
      } else {
        dynamicValues.push(Number.NaN, Number.NaN);
      }
      outputPointCount += 1;
    }
    for (let pointIndex = range.start; pointIndex < range.end; pointIndex += 1) {
      const projectedOffset = selectedCursor * 2;
      const projectedX = projected[projectedOffset];
      const projectedY = projected[projectedOffset + 1];
      selectedCursor += 1;
      // Span projection owns X and can legitimately recover through its
      // lineage envelope when the point request's exact-left X is unresolved.
      // Preserve the independently valid price Y for that recovery path.
      let x = finiteNumber(projectedX) ? projectedX : Number.NaN;
      const y = finiteNumber(projectedY) ? projectedY : Number.NaN;
      const strokePoint = stroke?.points[pointIndex];
      if (strokePoint && "span" in strokePoint) {
        const span = spanCoordinates.get(strokePoint.span);
        x = span
          ? span.left + (span.right - span.left) * strokePoint.ratio
          : Number.NaN;
      }
      if (!finiteNumber(x) || !finiteNumber(y)) {
        if (splitOnUnresolved) {
          unresolvedSourcePointIndexes.push(pointIndex);
          pathBreaks.push(outputPointCount);
          if (fixedValues) {
            fixedValues[outputPointCount * 2] = Number.NaN;
            fixedValues[outputPointCount * 2 + 1] = Number.NaN;
          }
          outputPointCount += 1;
        }
      } else {
        if (fixedValues) {
          fixedValues[outputPointCount * 2] = x;
          fixedValues[outputPointCount * 2 + 1] = y;
        } else {
          dynamicValues.push(x, y);
        }
        outputPointCount += 1;
      }
    }
  });
  if (fixedValues && outputPointCount * 2 !== fixedValues.length) return PROJECTION_FAILED;
  const points = fixedValues ?? new Float64Array(dynamicValues);
  return createProjectedEntity(entity, points, {
    renderSpec: freehandRenderSpec(entity, selected),
    bbox: bboxFromDrawableFreehand(
      points,
      frame.widthCssPx,
      frame.heightCssPx,
      freehandPaintOutsetCssPx(entity.style.lineWidth, entity.style.brushShape),
      entity.style.brushShape === "square" ? "linear" : "quadratic",
    ),
    pathBreaks: new Uint32Array(pathBreaks),
    unresolvedSourcePointIndexes: new Uint32Array(unresolvedSourcePointIndexes),
    canonicalGapCoverageComplete: coversFullSource,
    hitZones: Object.freeze([Object.freeze({
      kind: "polyline" as const,
      name: "stroke",
      pointOffset: 0,
      pointCount: points.length / 2,
      tolerance: 8 + entity.style.lineWidth / 2,
      result: Object.freeze({ body: true }),
    })]),
  });
}

function projectFreehand(
  entity: FreehandDrawingRenderEntity,
  node: DrawingSceneNode,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
  lodToleranceClass: DrawingLodToleranceClass,
): EntityProjection {
  const sourcePointCount = entity.geometry.stroke?.points.length
    ?? entity.geometry.dataPoints.length;
  const selectedRanges = selectedFreehandRanges(
    node,
    sourcePointCount,
    frame,
    adapter,
    freehandPaintOutsetCssPx(entity.style.lineWidth, entity.style.brushShape) + 2,
  );
  if (selectedRanges === PROJECTION_FAILED) return selectedRanges;
  const ranges = expandAndMergePointRanges(
    selectedRanges,
    sourcePointCount,
    entity.style.brushShape === "square" ? 0 : 1,
  );
  const stroke = entity.geometry.stroke;
  const canonicalRequests = stroke ? strokeBatchRequests(stroke) : entity.geometry.dataPoints;
  // Cull first, build each continuous path against its real screen mapping,
  // select nested source indexes, and only then run the public final projector.
  // Span points retain their exact/fallback lineage envelope throughout LOD.
  if (canonicalRequests && ranges.length > 0) {
    const resolutions = resolveFreehandWorldBatch(adapter, frame, canonicalRequests);
    const plan = resolutions
      ? selectFreehandLod(
          adapter,
          canonicalRequests,
          resolutions,
          ranges,
          frame,
          selected ? "selectedEdit" : lodToleranceClass,
          stroke,
          entity.style.brushShape !== "square",
        )
      : null;
    if (resolutions && plan) {
      return projectFreehandLod(
        entity,
        canonicalRequests,
        resolutions,
        plan,
        frame,
        adapter,
        selected,
      );
    }
  }
  return projectFreehandRanges(entity, ranges, frame, adapter, selected);
}

function projectEntity(
  entity: DrawingRenderEntity,
  node: DrawingSceneNode,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
  ordinaryAnchorsById: ReadonlyMap<string, TwoPointAnchors>,
  lodToleranceClass: DrawingLodToleranceClass,
): EntityProjection {
  switch (entity.kind) {
    case "line": return projectLine(
      entity,
      frame,
      ordinaryTwoPointAnchors(ordinaryAnchorsById, entity.id),
      selected,
    );
    case "axis-line": return projectAxisLine(entity, frame, adapter, selected);
    case "angle-measure": return projectAngle(entity, frame, adapter, selected);
    case "text": return projectText(entity, frame, adapter, selected);
    case "fibonacci": return projectFibonacci(entity, frame, adapter, selected);
    case "position": return projectPosition(entity, frame, adapter, selected);
    case "shape": return projectShape(
      entity,
      frame,
      ordinaryTwoPointAnchors(ordinaryAnchorsById, entity.id),
      selected,
    );
    case "freehand":
    case "highlighter": return projectFreehand(
      entity,
      node,
      frame,
      adapter,
      selected,
      lodToleranceClass,
    );
  }
}

function stampMatchesInput(
  stamp: DrawingRenderRevisionStamp,
  document: DrawingDocument,
  frame: DrawingFrameSnapshot,
): boolean {
  return stamp.scopeKey === document.scopeKey
    && stamp.documentRevision === document.documentRevision
    && stamp.surfaceGeneration === frame.surfaceGeneration
    && stamp.dataRevision === frame.dataRevision
    && stamp.projectionRevision === frame.projectionRevision
    && stamp.lineageIndexRevision === frame.lineageIndexRevision
    && stamp.viewportRevision === frame.viewportRevision
    && stamp.themeRevision === frame.themeRevision
    && stamp.widthCssPx === frame.widthCssPx
    && stamp.heightCssPx === frame.heightCssPx
    && stamp.dpr === frame.dpr;
}

function orderedCurrentNodes(
  document: DrawingDocument,
  nodes: readonly DrawingSceneNode[],
): readonly DrawingSceneNode[] | null {
  const zIndexes = new Map(document.zOrder.map((id, index) => [id, index] as const));
  const seen = new Set<string>();
  const current: DrawingSceneNode[] = [];
  for (const node of nodes) {
    const entity = document.entities.get(node.id);
    const zIndex = zIndexes.get(node.id);
    if (!entity || zIndex === undefined || seen.has(node.id)
      || node.entity !== entity
      || node.geometryRevision !== entity.geometryRevision
      || node.styleRevision !== entity.styleRevision) return null;
    seen.add(node.id);
    current.push(node);
  }
  current.sort((left, right) => Number(zIndexes.get(left.id)) - Number(zIndexes.get(right.id)));
  return Object.freeze(current);
}

function clipProjectedEntityToPane(
  entity: ProjectedDrawingEntity,
  frame: DrawingFrameSnapshot,
): ProjectedDrawingEntity | null {
  const bbox = entity.bbox;
  if (!bbox) return null;
  const renderSpec = entity.renderSpec;
  let paintOutset = 0;
  if (renderSpec?.op === "line") {
    paintOutset = linePaintOutsetCssPx(
      renderSpec.lineWidthCssPx,
      renderSpec.selected,
      renderSpec.drawEndpointDots,
    );
  } else if (renderSpec?.op === "axis-line") {
    paintOutset = renderSpec.selected
      ? Math.max(renderSpec.lineWidthCssPx / 2 + 5, 12)
      : renderSpec.lineWidthCssPx / 2;
  } else if (renderSpec?.op === "shape") {
    paintOutset = renderSpec.selected
      ? Math.max(renderSpec.lineWidthCssPx / 2, 9)
      : renderSpec.lineWidthCssPx / 2;
  } else if (renderSpec?.op === "angle") {
    // Selected angle rays paint a halo whose full width is lineWidth + 10px.
    // The 12px floor also covers endpoint handles, stroke, and shadow.
    paintOutset = renderSpec.selected
      ? Math.max(renderSpec.lineWidthCssPx / 2 + 5, 12)
      : Math.max(renderSpec.lineWidthCssPx / 2, 4.5);
  } else if (renderSpec?.op === "fibonacci") {
    // Selected Fibonacci trends paint a halo whose full width is
    // lineWidth + 12px; large imported widths must retain that extra radius.
    paintOutset = renderSpec.selected
      ? Math.max(renderSpec.lineWidthCssPx / 2 + 6, 12)
      : Math.max(renderSpec.lineWidthCssPx, 3);
  } else if (renderSpec?.op === "text") {
    const borderOutset = renderSpec.borderColor
      && renderSpec.borderColor !== "transparent"
      ? (renderSpec.borderWidthCssPx || 1) / 2
      : 0;
    paintOutset = renderSpec.selected ? Math.max(borderOutset, 5) : borderOutset;
  } else if (renderSpec?.op === "position") {
    // The info panel always paints an 8px shadow; selected entry handles add
    // a 5px radius, 2px stroke, and 4px blur outside their projected point.
    paintOutset = renderSpec.selected
      ? Math.max(renderSpec.lineWidthCssPx / 2, 10)
      : Math.max(renderSpec.lineWidthCssPx / 2, 8);
  } else if (renderSpec?.op === "freehand") {
    paintOutset = freehandPaintOutsetCssPx(
      renderSpec.lineWidthCssPx,
      renderSpec.brushShape,
    );
  }
  const paintLeft = bbox[0] - paintOutset;
  const paintTop = bbox[1] - paintOutset;
  const paintRight = bbox[2] + paintOutset;
  const paintBottom = bbox[3] + paintOutset;
  if (paintRight < 0
    || paintLeft > frame.widthCssPx
    || paintBottom < 0
    || paintTop > frame.heightCssPx) return null;
  const geometryLeft = Math.max(0, bbox[0]);
  const geometryTop = Math.max(0, bbox[1]);
  const geometryRight = Math.min(frame.widthCssPx, bbox[2]);
  const geometryBottom = Math.min(frame.heightCssPx, bbox[3]);
  const geometryIntersectsPane = geometryLeft <= geometryRight
    && geometryTop <= geometryBottom;
  return Object.freeze({
    ...entity,
    bbox: geometryIntersectsPane
      ? Object.freeze([
          geometryLeft,
          geometryTop,
          geometryRight,
          geometryBottom,
        ] as const)
      : Object.freeze([
          Math.max(0, paintLeft),
          Math.max(0, paintTop),
          Math.min(frame.widthCssPx, paintRight),
          Math.min(frame.heightCssPx, paintBottom),
        ] as const),
  });
}

/**
 * Build one immutable typed screen display list from a registry-cull subset.
 * Null is an atomic failure: callers must retain the previous plan and retry
 * from a new frame; no partial display list is observable.
 */
export function projectDrawingScene({
  document,
  nodes,
  frame,
  stamp,
  adapter,
  selectedId,
  lodToleranceClass = "normalStatic",
}: DrawingSceneProjectionInput): DrawingScreenDisplayList | null {
  try {
    if (!stampMatchesInput(stamp, document, frame)) return null;
    const orderedNodes = orderedCurrentNodes(document, nodes);
    if (!orderedNodes) return null;
    const entries: SceneProjectionEntry[] = [];
    for (const node of orderedNodes) {
      const renderEntity = normalizeDrawingEntityForScene(node.entity);
      if (renderEntity) entries.push({ node, renderEntity });
    }
    const ordinaryAnchorsById = projectOrdinaryTwoPointBatch(entries, frame, adapter);
    if (ordinaryAnchorsById === PROJECTION_FAILED) return null;
    const projected: ProjectedDrawingEntity[] = [];
    for (const { node, renderEntity } of entries) {
      const result = projectEntity(
        renderEntity,
        node,
        frame,
        adapter,
        node.id === selectedId,
        ordinaryAnchorsById,
        lodToleranceClass,
      );
      if (result === PROJECTION_FAILED) return null;
      if (result) {
        const visible = clipProjectedEntityToPane(result, frame);
        if (visible) projected.push(visible);
      }
    }
    return createDrawingScreenDisplayList(stamp, projected);
  } catch {
    return null;
  }
}

/**
 * Low-frequency strict-parity projection for canonical freehand gap indexes.
 * A full-source display entity reuses its copy-owned gap evidence. Only a
 * chunk-culled entity needs a full-source scan from the same atomic frame.
 */
export function projectDrawingSceneCanonicalGapIndexes({
  document,
  plan,
  frame,
  adapter,
}: DrawingSceneCanonicalGapProjectionInput): ReadonlyMap<string, Readonly<Uint32Array>> | null {
  try {
    if (plan.stamp.scopeKey !== document.scopeKey
      || plan.stamp.documentRevision !== document.documentRevision) return null;
    const gaps = new Map<string, Readonly<Uint32Array>>();
    for (const displayEntity of plan.entities) {
      const entityId = displayEntity.id;
      const entity = document.entities.get(entityId);
      if (!entity
        || entity.kind !== displayEntity.kind
        || entity.geometryRevision !== displayEntity.geometryRevision
        || entity.styleRevision !== displayEntity.styleRevision) return null;
      if (entity.kind !== "freehand" && entity.kind !== "highlighter") {
        if (displayEntity.canonicalGapCoverageComplete) return null;
        continue;
      }
      if (displayEntity.canonicalGapCoverageComplete) {
        const start = displayEntity.unresolvedGapOffset;
        gaps.set(entityId, plan.unresolvedSourcePointIndexes.subarray(
          start,
          start + displayEntity.unresolvedGapCount,
        ));
        continue;
      }
      const renderEntity = normalizeDrawingEntityForScene(entity);
      if (!renderEntity || (renderEntity.kind !== "freehand" && renderEntity.kind !== "highlighter")) {
        return null;
      }
      const projection = projectFreehandCanonicalGapIndexes(renderEntity, frame, adapter);
      if (projection === PROJECTION_FAILED) return null;
      gaps.set(entityId, projection);
    }
    return gaps;
  } catch {
    return null;
  }
}
