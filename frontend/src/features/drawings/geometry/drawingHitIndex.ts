import {
  hitTestDrawingScreenDisplayList,
} from "../rendering/drawingDisplayList.js";
import type {
  DrawingDisplayHitCandidates,
  DrawingDisplayHitResult,
  DrawingScreenDisplayList,
} from "../rendering/drawingDisplayList.js";

export const DRAWING_HIT_INDEX_CELL_SIZE_CSS_PX = 64;

export interface DrawingHitIndexSegmentReference {
  readonly entityIndex: number;
  /** Entity-local point index of the segment's first endpoint. */
  readonly segmentStart: number;
}

export interface DrawingHitIndexBucket {
  readonly entityIndexes: readonly number[];
  readonly segments: readonly DrawingHitIndexSegmentReference[];
}

export interface DrawingHitIndexStats {
  readonly bucketCount: number;
  readonly cellSizeCssPx: number;
  readonly entityReferenceCount: number;
  readonly globalEntityCount: number;
  readonly segmentCount: number;
  readonly segmentReferenceCount: number;
}

export interface DrawingHitIndex {
  readonly list: DrawingScreenDisplayList;
  readonly buckets: ReadonlyMap<string, DrawingHitIndexBucket>;
  readonly globalEntityIndexes: readonly number[];
  readonly stats: DrawingHitIndexStats;
}

export interface DrawingHitIndexQuery {
  readonly candidates: DrawingDisplayHitCandidates;
  readonly candidateEntityCount: number;
  readonly candidateSegmentCount: number;
}

interface MutableBucket {
  readonly entityIndexes: Set<number>;
  /**
   * One reference object is shared across every cell touched by its segment.
   * Segment registration is contiguous, so repeated DDA neighborhood visits
   * can de-duplicate against the bucket's last reference without a second Set.
   */
  readonly segments: DrawingHitIndexSegmentReference[];
}

type MutableBucketGrid = Map<number, Map<number, MutableBucket>>;

interface ClippedSegment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

function cellCoordinate(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function mutableBucket(
  buckets: MutableBucketGrid,
  x: number,
  y: number,
): MutableBucket {
  let column = buckets.get(x);
  if (!column) {
    column = new Map<number, MutableBucket>();
    buckets.set(x, column);
  }
  const existing = column.get(y);
  if (existing) return existing;
  const created: MutableBucket = {
    entityIndexes: new Set<number>(),
    segments: [],
  };
  column.set(y, created);
  return created;
}

function clipSegmentToRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): ClippedSegment | null {
  const dx = bx - ax;
  const dy = by - ay;
  let minimum = 0;
  let maximum = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const ratio = q / p;
    if (p < 0) {
      if (ratio > maximum) return false;
      minimum = Math.max(minimum, ratio);
    } else {
      if (ratio < minimum) return false;
      maximum = Math.min(maximum, ratio);
    }
    return minimum <= maximum;
  };
  if (!clip(-dx, ax - left)
    || !clip(dx, right - ax)
    || !clip(-dy, ay - top)
    || !clip(dy, bottom - ay)) return null;
  return {
    ax: ax + minimum * dx,
    ay: ay + minimum * dy,
    bx: ax + maximum * dx,
    by: ay + maximum * dy,
  };
}

function registerSegmentCell(
  buckets: MutableBucketGrid,
  reference: DrawingHitIndexSegmentReference,
  cellX: number,
  cellY: number,
): number {
  const bucket = mutableBucket(buckets, cellX, cellY);
  if (bucket.segments[bucket.segments.length - 1] === reference) return 0;
  bucket.entityIndexes.add(reference.entityIndex);
  bucket.segments.push(reference);
  return 1;
}

function registerSegmentNeighborhood(
  buckets: MutableBucketGrid,
  reference: DrawingHitIndexSegmentReference,
  baseX: number,
  baseY: number,
  neighborRadius: number,
): number {
  let references = 0;
  for (let offsetY = -neighborRadius; offsetY <= neighborRadius; offsetY += 1) {
    for (let offsetX = -neighborRadius; offsetX <= neighborRadius; offsetX += 1) {
      references += registerSegmentCell(buckets, reference, baseX + offsetX, baseY + offsetY);
    }
  }
  return references;
}

function registerTraversedSegmentCells(
  buckets: MutableBucketGrid,
  reference: DrawingHitIndexSegmentReference,
  segment: ClippedSegment,
  cellSize: number,
  neighborRadius: number,
): number {
  let cellX = cellCoordinate(segment.ax, cellSize);
  let cellY = cellCoordinate(segment.ay, cellSize);
  const endX = cellCoordinate(segment.bx, cellSize);
  const endY = cellCoordinate(segment.by, cellSize);
  let references = registerSegmentNeighborhood(
    buckets,
    reference,
    cellX,
    cellY,
    neighborRadius,
  );
  if (cellX === endX && cellY === endY) return references;

  const dx = segment.bx - segment.ax;
  const dy = segment.by - segment.ay;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const deltaX = stepX === 0 ? Number.POSITIVE_INFINITY : cellSize / Math.abs(dx);
  const deltaY = stepY === 0 ? Number.POSITIVE_INFINITY : cellSize / Math.abs(dy);
  const boundaryX = stepX > 0 ? (cellX + 1) * cellSize : cellX * cellSize;
  const boundaryY = stepY > 0 ? (cellY + 1) * cellSize : cellY * cellSize;
  let maximumX = stepX === 0
    ? Number.POSITIVE_INFINITY
    : (boundaryX - segment.ax) / dx;
  let maximumY = stepY === 0
    ? Number.POSITIVE_INFINITY
    : (boundaryY - segment.ay) / dy;
  const iterationLimit = Math.abs(endX - cellX) + Math.abs(endY - cellY) + 4;
  for (let iteration = 0; iteration < iterationLimit
    && (cellX !== endX || cellY !== endY); iteration += 1) {
    if (maximumX < maximumY) {
      cellX += stepX;
      maximumX += deltaX;
    } else if (maximumY < maximumX) {
      cellY += stepY;
      maximumY += deltaY;
    } else {
      cellX += stepX;
      cellY += stepY;
      maximumX += deltaX;
      maximumY += deltaY;
    }
    references += registerSegmentNeighborhood(
      buckets,
      reference,
      cellX,
      cellY,
      neighborRadius,
    );
  }
  return references;
}

function registerSegment(
  buckets: MutableBucketGrid,
  reference: DrawingHitIndexSegmentReference,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tolerance: number,
  widthCssPx: number,
  heightCssPx: number,
  cellSize: number,
): number {
  const padding = Math.max(0, tolerance);
  // Most LOD segments are shorter than one cell. Their expanded AABB is a
  // conservative superset of every point within the exact hit tolerance, so
  // it can be registered directly without clipping or a DDA walk.
  const expandedLeft = Math.min(ax, bx) - padding;
  const expandedRight = Math.max(ax, bx) + padding;
  const expandedTop = Math.min(ay, by) - padding;
  const expandedBottom = Math.max(ay, by) + padding;
  if (expandedRight < 0 || expandedLeft > widthCssPx
    || expandedBottom < 0 || expandedTop > heightCssPx) return 0;
  const firstX = cellCoordinate(expandedLeft, cellSize);
  const lastX = cellCoordinate(expandedRight, cellSize);
  const firstY = cellCoordinate(expandedTop, cellSize);
  const lastY = cellCoordinate(expandedBottom, cellSize);
  const expandedCellCount = (lastX - firstX + 1) * (lastY - firstY + 1);
  if (expandedCellCount <= 9) {
    let references = 0;
    for (let cellY = firstY; cellY <= lastY; cellY += 1) {
      for (let cellX = firstX; cellX <= lastX; cellX += 1) {
        references += registerSegmentCell(buckets, reference, cellX, cellY);
      }
    }
    return references;
  }
  const clipped = clipSegmentToRect(
    ax,
    ay,
    bx,
    by,
    -padding,
    -padding,
    widthCssPx + padding,
    heightCssPx + padding,
  );
  if (!clipped) return 0;
  const neighborRadius = Math.ceil(padding / cellSize);
  return registerTraversedSegmentCells(
    buckets,
    reference,
    clipped,
    cellSize,
    neighborRadius,
  );
}

function registerEntityBox(
  buckets: MutableBucketGrid,
  entityIndex: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  cellSize: number,
): number {
  const firstX = cellCoordinate(left, cellSize);
  const lastX = cellCoordinate(right, cellSize);
  const firstY = cellCoordinate(top, cellSize);
  const lastY = cellCoordinate(bottom, cellSize);
  let references = 0;
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      const bucket = mutableBucket(buckets, x, y);
      if (bucket.entityIndexes.has(entityIndex)) continue;
      bucket.entityIndexes.add(entityIndex);
      references += 1;
    }
  }
  return references;
}

export function createDrawingHitIndex(
  list: DrawingScreenDisplayList,
  cellSizeCssPx = DRAWING_HIT_INDEX_CELL_SIZE_CSS_PX,
): DrawingHitIndex {
  const cellSize = Number.isFinite(cellSizeCssPx) && cellSizeCssPx >= 16
    ? Math.min(128, cellSizeCssPx)
    : DRAWING_HIT_INDEX_CELL_SIZE_CSS_PX;
  // Numeric x/y maps keep the hot segment-registration path allocation-free.
  // Public query keys are materialized once per finished bucket below.
  const buckets: MutableBucketGrid = new Map();
  const globalEntities = new Set<number>();
  let entityReferenceCount = 0;
  let segmentCount = 0;
  let segmentReferenceCount = 0;

  list.entities.forEach((entity, entityIndex) => {
    let ownsIndexedZone = false;
    let maximumNonPolylineTolerance = 0;
    for (const zone of entity.hitZones) {
      if (zone.kind !== "polyline") {
        maximumNonPolylineTolerance = Math.max(maximumNonPolylineTolerance, zone.tolerance);
        continue;
      }
      ownsIndexedZone = true;
      const firstLocalPoint = Math.max(0, zone.pointOffset);
      const lastExclusive = Math.min(entity.pointCount, zone.pointOffset + zone.pointCount);
      for (let localPoint = firstLocalPoint; localPoint + 1 < lastExclusive; localPoint += 1) {
        const firstOffset = (entity.pointOffset + localPoint) * 2;
        const secondOffset = firstOffset + 2;
        const ax = list.points[firstOffset];
        const ay = list.points[firstOffset + 1];
        const bx = list.points[secondOffset];
        const by = list.points[secondOffset + 1];
        if (!Number.isFinite(ax) || !Number.isFinite(ay)
          || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
        segmentCount += 1;
        segmentReferenceCount += registerSegment(
          buckets,
          Object.freeze({ entityIndex, segmentStart: localPoint }),
          Number(ax),
          Number(ay),
          Number(bx),
          Number(by),
          zone.tolerance,
          list.stamp.widthCssPx,
          list.stamp.heightCssPx,
          cellSize,
        );
      }
    }
    if (entity.hitZones.some((zone) => zone.kind !== "polyline")) {
      ownsIndexedZone = true;
      const offset = entityIndex * 4;
      const left = list.bboxes[offset];
      const top = list.bboxes[offset + 1];
      const right = list.bboxes[offset + 2];
      const bottom = list.bboxes[offset + 3];
      if (Number.isFinite(left) && Number.isFinite(top)
        && Number.isFinite(right) && Number.isFinite(bottom)) {
        entityReferenceCount += registerEntityBox(
          buckets,
          entityIndex,
          Math.max(-cellSize, Number(left) - maximumNonPolylineTolerance),
          Math.max(-cellSize, Number(top) - maximumNonPolylineTolerance),
          Math.min(list.stamp.widthCssPx + cellSize, Number(right) + maximumNonPolylineTolerance),
          Math.min(list.stamp.heightCssPx + cellSize, Number(bottom) + maximumNonPolylineTolerance),
          cellSize,
        );
      } else {
        globalEntities.add(entityIndex);
      }
    }
    if (!ownsIndexedZone && entity.hitZones.length > 0) globalEntities.add(entityIndex);
  });

  const frozenBuckets = new Map<string, DrawingHitIndexBucket>();
  for (const [x, column] of buckets) {
    for (const [y, bucket] of column) {
      frozenBuckets.set(cellKey(x, y), Object.freeze({
        entityIndexes: Object.freeze([...bucket.entityIndexes].sort((a, b) => b - a)),
        segments: Object.freeze([...bucket.segments]),
      }));
    }
  }
  const globalEntityIndexes = Object.freeze([...globalEntities].sort((a, b) => b - a));
  return Object.freeze({
    list,
    buckets: frozenBuckets,
    globalEntityIndexes,
    stats: Object.freeze({
      bucketCount: frozenBuckets.size,
      cellSizeCssPx: cellSize,
      entityReferenceCount,
      globalEntityCount: globalEntityIndexes.length,
      segmentCount,
      segmentReferenceCount,
    }),
  });
}

export function queryDrawingHitIndex(
  index: DrawingHitIndex,
  x: number,
  y: number,
): DrawingHitIndexQuery {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return Object.freeze({
      candidates: Object.freeze({ entityIndexes: Object.freeze([]) }),
      candidateEntityCount: 0,
      candidateSegmentCount: 0,
    });
  }
  const cellSize = index.stats.cellSizeCssPx;
  const bucket = index.buckets.get(cellKey(
    cellCoordinate(x, cellSize),
    cellCoordinate(y, cellSize),
  ));
  const entities = new Set<number>(index.globalEntityIndexes);
  const segmentsByEntity = new Map<number, Set<number>>();
  for (const entityIndex of bucket?.entityIndexes ?? []) entities.add(entityIndex);
  for (const segment of bucket?.segments ?? []) {
    entities.add(segment.entityIndex);
    let starts = segmentsByEntity.get(segment.entityIndex);
    if (!starts) {
      starts = new Set<number>();
      segmentsByEntity.set(segment.entityIndex, starts);
    }
    starts.add(segment.segmentStart);
  }
  const frozenSegments = new Map<number, readonly number[]>();
  let candidateSegmentCount = 0;
  for (const [entityIndex, starts] of segmentsByEntity) {
    const values = Object.freeze([...starts].sort((a, b) => a - b));
    candidateSegmentCount += values.length;
    frozenSegments.set(entityIndex, values);
  }
  const entityIndexes = Object.freeze([...entities].sort((a, b) => b - a));
  return Object.freeze({
    candidates: Object.freeze({
      entityIndexes,
      polylineSegmentStartsByEntity: frozenSegments,
    }),
    candidateEntityCount: entityIndexes.length,
    candidateSegmentCount,
  });
}

export function hitTestDrawingHitIndex(
  index: DrawingHitIndex,
  x: number,
  y: number,
  selectedId: string | null = null,
): DrawingDisplayHitResult | null {
  const query = queryDrawingHitIndex(index, x, y);
  return hitTestDrawingScreenDisplayList(index.list, x, y, selectedId, query.candidates);
}
