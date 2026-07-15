import type { DrawingFrameSnapshot } from "../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  CoordinateDataPoint,
  SourceLineageSpanInput,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  DrawingDocument,
  DrawingEntity,
  DrawingStyle,
} from "../core/drawingDocument.js";
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
  createDrawingScreenDisplayList,
} from "../rendering/drawingDisplayList.js";
import type {
  DrawingDisplayHitZone,
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

const BOX_HANDLE_NAMES = Object.freeze(["tl", "t", "tr", "r", "br", "b", "bl", "l"]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
): BatchProjection {
  try {
    const projected = adapter.projectDrawingFrameDataPoints(frame, points);
    return validProjectedBuffer(projected, points.length) ? projected : PROJECTION_FAILED;
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
): readonly [number, number, number, number] | null {
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
      let visible = previousX >= 0 && previousX <= widthCssPx
        && previousY >= 0 && previousY <= heightCssPx
        && x >= 0 && x <= widthCssPx
        && y >= 0 && y <= heightCssPx;
      if (!visible) {
        let minT = 0;
        let maxT = 1;
        visible = true;
        if (dx === 0) {
          visible = previousX >= 0 && previousX <= widthCssPx;
        } else {
          let first = -previousX / dx;
          let second = (widthCssPx - previousX) / dx;
          if (first > second) [first, second] = [second, first];
          minT = Math.max(minT, first);
          maxT = Math.min(maxT, second);
          visible = minT <= maxT;
        }
        if (visible) {
          if (dy === 0) {
            visible = previousY >= 0 && previousY <= heightCssPx;
          } else {
            let first = -previousY / dy;
            let second = (heightCssPx - previousY) / dy;
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
  const projected = projectBatch(adapter, frame, [first, second]);
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
  }
  if (requests.length === 0) return anchorsById;
  const projected = projectBatch(adapter, frame, requests);
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
): readonly [ScreenPoint, ScreenPoint] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return a.x >= 0 && a.x <= width && a.y >= 0 && a.y <= height
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

  if (!clipAxis(a.x, dx, 0, width) || !clipAxis(a.y, dy, 0, height)) return null;
  if (!finiteNumber(minimum) || !finiteNumber(maximum)) return null;
  return Object.freeze([
    Object.freeze({ x: a.x + minimum * dx, y: a.y + minimum * dy }),
    Object.freeze({ x: a.x + maximum * dx, y: a.y + maximum * dy }),
  ]);
}

function projectLine(
  entity: LineDrawingRenderEntity,
  frame: DrawingFrameSnapshot,
  anchors: TwoPointProjection,
): EntityProjection {
  if (anchors === PROJECTION_FAILED || anchors === null) return anchors;
  const [a, b] = anchors;
  const unbounded = entity.geometry.lineType === "line-ray"
    || entity.geometry.lineType === "line-infinite";
  const line = clipParametricLine(
    a,
    b,
    frame.widthCssPx,
    frame.heightCssPx,
    entity.geometry.lineType,
  );
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
  const projected = projectBatch(adapter, frame, [anchor]);
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
  for (const level of entity.style.levels) {
    if (!level.enabled || !finiteNumber(level.level)) continue;
    const y = startY + (endY - startY) * level.level;
    const offset = pushPair(values, { x: left, y }, { x: right, y });
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
): EntityProjection {
  const projected = projectBatch(adapter, frame, [entity.geometry.dataPoint]);
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
  const measuredWidth = lines.reduce((width, line) => Math.max(width, measure(line)), 0);
  const innerWidth = innerWidthCap ?? measuredWidth;
  const width = innerWidth + padding * 2;
  const height = lines.length * (entity.style.fontSize * 1.3) + padding * 2;
  const right = anchor.x + width;
  const bottom = anchor.y + height;
  return createProjectedEntity(entity, new Float64Array([
    anchor.x, anchor.y,
    right, bottom,
  ]), {
    bbox: Object.freeze([anchor.x, anchor.y, right, bottom]),
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

function formatPositionPrice(price: number): string {
  if (price >= 1_000) {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}

function positionPnlPercent(entryPrice: number, price: number, isLong: boolean): number {
  if (!entryPrice) return 0;
  return isLong
    ? ((price - entryPrice) / entryPrice) * 100
    : ((entryPrice - price) / entryPrice) * 100;
}

function positionCurrentPrice(frame: DrawingFrameSnapshot): number | null {
  const last = frame.seriesData.at(-1);
  if (!last) return null;
  if (finiteNumber(last.close)) return last.close;
  return finiteNumber(last.value) ? last.value : null;
}

function positionPanelLines(
  entity: PositionDrawingRenderEntity,
  currentPrice: number | null,
): readonly string[] {
  const { direction, entryPrice, slPrice, tpPrice } = entity.geometry;
  const size = entity.style.positionSize;
  const isLong = direction === "long";
  const lines = [`入场: ${formatPositionPrice(entryPrice)}`];
  if (tpPrice !== null) {
    const percent = positionPnlPercent(entryPrice, tpPrice, isLong);
    const pnl = size ? size * percent / 100 : null;
    lines.push(`止盈: ${formatPositionPrice(tpPrice)} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)${pnl === null ? "" : ` ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}`);
  }
  if (slPrice !== null) {
    const percent = positionPnlPercent(entryPrice, slPrice, isLong);
    const pnl = size ? size * percent / 100 : null;
    lines.push(`止损: ${formatPositionPrice(slPrice)} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)${pnl === null ? "" : ` ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}`);
  }
  if (currentPrice !== null && finiteNumber(currentPrice)) {
    const percent = positionPnlPercent(entryPrice, currentPrice, isLong);
    const pnl = size ? size * percent / 100 : null;
    lines.push(`现价: ${formatPositionPrice(currentPrice)} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)${pnl === null ? "" : ` ${percent >= 0 ? "+" : ""}${pnl.toFixed(2)}`}`);
  }
  if (tpPrice !== null && slPrice !== null && entryPrice) {
    const reward = Math.abs(tpPrice - entryPrice);
    const risk = Math.abs(slPrice - entryPrice);
    if (risk > 0) lines.push(`盈亏比: 1 : ${(reward / risk).toFixed(2)}`);
  }
  if (size) lines.push(`仓位: $${size.toFixed(0)}`);
  return Object.freeze(lines);
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
  const projected = projectBatch(adapter, frame, requests);
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
  const appendPriceZone = (name: "tp" | "sl", y: number): void => {
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
  };
  if (tpY !== null) appendPriceZone("tp", tpY);
  if (slY !== null) appendPriceZone("sl", slY);

  const panelLines = positionPanelLines(entity, positionCurrentPrice(frame));
  const panelFont = 11;
  const panelTextWidth = panelLines.reduce((width, text) => Math.max(width, measuredTextWidth(adapter, {
    text,
    fontFamily: "sans-serif",
    fontSize: panelFont,
    bold: false,
    italic: false,
  })), 0);
  const panelWidth = panelTextWidth + 16;
  const panelHeight = panelLines.length * 17 + 12;
  const panelLeft = right - panelWidth - 8 + entity.style.infoPanelOffset.x;
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
  return createProjectedEntity(entity, new Float64Array(values), {
    bbox: unionBboxes(mainBbox, panelBbox),
    handles: new Float64Array([left, middleY, right, middleY]),
    handleNames: Object.freeze(["left", "right"]),
    handleResults: Object.freeze([null, null]),
    hitZones: Object.freeze(orderedHitZones),
  });
}

function chunkProjectionRequests(
  chunks: readonly DrawingBoundsChunk[],
): {
  readonly indexes: readonly number[];
  readonly points: readonly CoordinateDataPoint[];
} {
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
  return { indexes, points };
}

function visibleFreehandChunks(
  node: DrawingSceneNode,
  chunks: readonly DrawingBoundsChunk[],
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
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
  if (incomparable.length > 0) {
    const request = chunkProjectionRequests(incomparable);
    const projected = projectBatch(adapter, frame, request.points);
    if (projected === PROJECTION_FAILED) return projected;
    request.indexes.forEach((incomparableIndex, requestIndex) => {
      const chunk = incomparable[incomparableIndex];
      if (!chunk) return;
      const first = screenPointAt(projected, requestIndex * 2);
      const second = screenPointAt(projected, requestIndex * 2 + 1);
      // Unresolved chunk corners fail open; this is still bounded to chunk size.
      if (!first || !second || (
        Math.max(first.x, second.x) >= 0
        && Math.min(first.x, second.x) <= frame.widthCssPx
        && Math.max(first.y, second.y) >= 0
        && Math.min(first.y, second.y) <= frame.heightCssPx
      )) visible.add(chunk);
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

function selectedFreehandRanges(
  node: DrawingSceneNode,
  pointCount: number,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
): readonly PointRange[] | ProjectionFailure {
  if (pointCount === 0) return Object.freeze([]);
  if (node.bounds.chunks.length === 0 || !frame.drawingViewport) {
    return Object.freeze([Object.freeze({ start: 0, end: pointCount })]);
  }
  const chunks = visibleFreehandChunks(node, node.bounds.chunks, frame, adapter);
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

  const projected = projectBatch(adapter, frame, requests);
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
    const projected = projectBatch(adapter, frame, requests);
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
      bbox: bboxFromDrawablePolyline(points, frame.widthCssPx, frame.heightCssPx),
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
  const projected = projectBatch(adapter, frame, requests);
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
    bbox: bboxFromDrawablePolyline(points, frame.widthCssPx, frame.heightCssPx),
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
): EntityProjection {
  const sourcePointCount = entity.geometry.stroke?.points.length
    ?? entity.geometry.dataPoints.length;
  const ranges = selectedFreehandRanges(node, sourcePointCount, frame, adapter);
  if (ranges === PROJECTION_FAILED) return ranges;
  return projectFreehandRanges(entity, ranges, frame, adapter);
}

function projectEntity(
  entity: DrawingRenderEntity,
  node: DrawingSceneNode,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  selected: boolean,
  ordinaryAnchorsById: ReadonlyMap<string, TwoPointAnchors>,
): EntityProjection {
  switch (entity.kind) {
    case "line": return projectLine(
      entity,
      frame,
      ordinaryTwoPointAnchors(ordinaryAnchorsById, entity.id),
    );
    case "axis-line": return projectAxisLine(entity, frame, adapter, selected);
    case "angle-measure": return projectAngle(entity, frame, adapter);
    case "text": return projectText(entity, frame, adapter);
    case "fibonacci": return projectFibonacci(entity, frame, adapter);
    case "position": return projectPosition(entity, frame, adapter, selected);
    case "shape": return projectShape(
      entity,
      frame,
      ordinaryTwoPointAnchors(ordinaryAnchorsById, entity.id),
    );
    case "freehand":
    case "highlighter": return projectFreehand(entity, node, frame, adapter);
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
  if (!bbox
    || bbox[2] < 0
    || bbox[0] > frame.widthCssPx
    || bbox[3] < 0
    || bbox[1] > frame.heightCssPx) return null;
  return Object.freeze({
    ...entity,
    bbox: Object.freeze([
      Math.max(0, bbox[0]),
      Math.max(0, bbox[1]),
      Math.min(frame.widthCssPx, bbox[2]),
      Math.min(frame.heightCssPx, bbox[3]),
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
