import {
  finiteNumber,
  hasOwn,
  isRecord,
  safeProjectionConfig,
  safeSourceOrdinal,
  safeSourceProjection,
} from "./drawingContracts.js";
import type {
  DrawingDataPoint,
  ExactOrdinalAnchor,
  FreehandBatchResolveRequest,
  FreehandAppendResult,
  FreehandCaptureBatch,
  FreehandFinalizeOptions,
  FreehandSpanPoint,
  FreehandSpanResolver,
  FreehandStroke,
  FreehandStrokeDraft,
  FreehandStrokeDraftOptions,
  FreehandStrokeResolvers,
  FreehandStrokeV2,
  FreehandStrokeV3,
  FreehandStrokeV3Point,
  ResolvedFreehandPoint,
  ResolvedFreehandSpan,
  SavedFreehandPayload,
  ScreenPoint,
  SourceLineageSpan,
} from "./drawingTypes.js";

export const FREEHAND_STROKE_VERSION = 2;
export const FREEHAND_STROKE_V3_VERSION = 3;
export const MAX_FREEHAND_STROKE_SPANS = 2_048;
export const MAX_FREEHAND_STROKE_POINTS = 4_096;
export const MAX_LEGACY_FREEHAND_POINTS = MAX_FREEHAND_STROKE_POINTS;
export const FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY = 256;

const MAX_PROJECTION_ID_LENGTH = 64;
const MAX_PROJECTION_CONFIG_LENGTH = 512;
const normalizedStrokes = new WeakMap<object, FreehandStroke>();

type DraftCapture = (
  | { time: number; price: number }
  | { anchor: ExactOrdinalAnchor; price: number }
  | { span: SourceLineageSpan; ratio: number; price: number }
) & { screen: ScreenPoint | null };

const DRAFT_KIND_SPAN = 0;
const DRAFT_KIND_TIME = 1;
const DRAFT_KIND_ANCHOR = 2;
const DRAFT_VALUE_PRIMARY = 0;
const DRAFT_VALUE_SECONDARY = 1;
const DRAFT_VALUE_PRICE = 2;
const DRAFT_VALUE_SCREEN_X = 3;
const DRAFT_VALUE_SCREEN_Y = 4;
const DRAFT_VALUE_FIELD_COUNT = 5;

interface DraftSampleChunk {
  length: number;
  kinds: Uint8Array;
  screenPresent: Uint8Array;
  values: Float64Array;
}

interface DraftSampleStorage {
  chunks: DraftSampleChunk[];
  length: number;
}

interface DraftState {
  sourceProjection: string;
  sourceProjectionConfig: string;
  captureIdentity: unknown;
  spans: SourceLineageSpan[];
  spanIndexes: Map<string, number>;
  samples: DraftSampleStorage;
  saturated: boolean;
  cancelled: boolean;
}

export interface FreehandStrokeDraftStorageInspection {
  chunkCapacity: number;
  chunkCount: number;
  sampleCount: number;
  allocatedSlots: number;
  chunkLengths: number[];
  typedArrayBacked: boolean;
}

const draftStates = new WeakMap<FreehandStrokeDraft, DraftState>();

function safeTime(value: unknown): number | null {
  const time = finiteNumber(value);
  return time !== null
    && time >= Number.MIN_SAFE_INTEGER
    && time <= Number.MAX_SAFE_INTEGER
    ? time
    : null;
}

function safeProjectionId(value: unknown): string | null {
  const projection = safeSourceProjection(value);
  return projection && projection.length <= MAX_PROJECTION_ID_LENGTH ? projection : null;
}

function safeFreehandProjectionConfig(value: unknown): string | null {
  const config = safeProjectionConfig(value);
  return config && config.length <= MAX_PROJECTION_CONFIG_LENGTH ? config : null;
}

function normalizeLegacyFreehandPoint(value: unknown): DrawingDataPoint | null {
  if (!isRecord(value)) return null;

  const price = finiteNumber(value.price);
  const time = finiteNumber(value.time);
  const logical = finiteNumber(value.logical);
  if (price === null || (time === null && logical === null)) return null;

  if (time !== null) {
    const sourceOrdinal = safeSourceOrdinal(value.sourceOrdinal);
    const sourceProjection = safeProjectionId(value.sourceProjection);
    const sourceProjectionConfig = safeFreehandProjectionConfig(value.sourceProjectionConfig);
    if (sourceOrdinal !== null
      || sourceProjection !== null
      || sourceProjectionConfig !== null) {
      return {
        time,
        ...(sourceOrdinal === null ? {} : { sourceOrdinal }),
        ...(sourceProjection === null ? {} : { sourceProjection }),
        ...(sourceProjectionConfig === null ? {} : { sourceProjectionConfig }),
        price,
      };
    }
    if (logical !== null) return { time, logical, price };
    return { time, price };
  }
  return logical === null ? null : { logical, price };
}

/**
 * Validate and clone the legacy freehand/highlighter point array without
 * changing its v1 representation. Projection-local `order` is discarded, but
 * the historical time-axis `logical` fallback remains supported.
 */
export function normalizeLegacyFreehandDataPoints(value: unknown): DrawingDataPoint[] | null {
  if (!Array.isArray(value)
    || value.length < 2
    || value.length > MAX_LEGACY_FREEHAND_POINTS) {
    return null;
  }

  const points: DrawingDataPoint[] = [];
  for (const candidate of value) {
    const point = normalizeLegacyFreehandPoint(candidate);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

/**
 * Use own-property presence as the only v1/stroke discriminator. An item with a
 * `stroke` field is never allowed to fall back to legacy `dataPoints`.
 */
export function normalizeSavedFreehandPayload(item: unknown): SavedFreehandPayload | null {
  if (!isRecord(item)) return null;
  const hasStroke = hasOwn(item, "stroke");
  if (!hasStroke) {
    const dataPoints = normalizeLegacyFreehandDataPoints(item.dataPoints);
    return dataPoints ? { dataPoints } : null;
  }
  if (hasOwn(item, "dataPoints")) return null;
  const stroke = normalizeFreehandStroke(item.stroke);
  return stroke ? { stroke } : null;
}

function normalizeExactAnchor(value: unknown): ExactOrdinalAnchor | null {
  if (!isRecord(value)) return null;
  const time = finiteNumber(value.time);
  const sourceOrdinal = safeSourceOrdinal(value.sourceOrdinal);
  return time === null || sourceOrdinal === null
    ? null
    : { time, sourceOrdinal };
}

function compareExactAnchors(left: ExactOrdinalAnchor, right: ExactOrdinalAnchor): number {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.sourceOrdinal === right.sourceOrdinal) return 0;
  return left.sourceOrdinal < right.sourceOrdinal ? -1 : 1;
}

function normalizeSpan(value: unknown): SourceLineageSpan | null {
  if (!isRecord(value) || !isRecord(value.exact) || !isRecord(value.fallback)) return null;
  const left = normalizeExactAnchor(value.exact.left);
  const right = normalizeExactAnchor(value.exact.right);
  const fromTime = finiteNumber(value.fallback.fromTime);
  const toTime = finiteNumber(value.fallback.toTime);
  const leftRatio = finiteNumber(value.fallback.leftRatio);
  const rightRatio = finiteNumber(value.fallback.rightRatio);

  if (!left
    || !right
    || compareExactAnchors(left, right) >= 0
    || fromTime === null
    || toTime === null
    || fromTime > toTime
    || left.time < fromTime
    || left.time > toTime
    || right.time < fromTime
    || right.time > toTime
    || leftRatio === null
    || rightRatio === null
    || leftRatio < 0
    || rightRatio > 1
    || leftRatio >= rightRatio) {
    return null;
  }

  return {
    exact: { left, right },
    fallback: {
      fromTime,
      toTime,
      leftRatio,
      rightRatio,
    },
  };
}

function normalizePoint(value: unknown, spanCount: number): FreehandSpanPoint | null {
  if (!isRecord(value)) return null;
  const span = value.span;
  const ratio = finiteNumber(value.ratio);
  const price = finiteNumber(value.price);
  if (typeof span !== "number"
    || !Number.isSafeInteger(span)
    || span < 0
    || span >= spanCount
    || ratio === null
    || ratio < 0
    || ratio > 1
    || price === null) {
    return null;
  }
  return { span, ratio, price };
}

function normalizeV3Span(value: unknown): SourceLineageSpan | null {
  const span = normalizeSpan(value);
  if (!span
    || safeTime(span.exact.left.time) === null
    || safeTime(span.exact.right.time) === null
    || safeTime(span.fallback.fromTime) === null
    || safeTime(span.fallback.toTime) === null) {
    return null;
  }
  return span;
}

function normalizeV3Point(value: unknown, spanCount: number): FreehandStrokeV3Point | null {
  if (!isRecord(value)) return null;

  const hasSpan = hasOwn(value, "span");
  const hasRatio = hasOwn(value, "ratio");
  const hasTime = hasOwn(value, "time");
  const hasAnchor = hasOwn(value, "anchor");
  const price = finiteNumber(value.price);
  const representationCount = Number(hasTime)
    + Number(hasAnchor)
    + Number(hasSpan || hasRatio);
  if (price === null || representationCount !== 1) return null;

  if (hasTime) {
    const time = safeTime(value.time);
    return time === null ? null : { time, price };
  }
  if (hasAnchor) {
    const anchor = normalizeExactAnchor(value.anchor);
    return !anchor || safeTime(anchor.time) === null ? null : { anchor, price };
  }
  if (!hasSpan || !hasRatio) return null;
  return normalizePoint(value, spanCount);
}

function freezeNormalizedStroke<TStroke extends FreehandStroke>(stroke: TStroke): TStroke {
  for (const span of stroke.spans) {
    Object.freeze(span.exact.left);
    Object.freeze(span.exact.right);
    Object.freeze(span.exact);
    Object.freeze(span.fallback);
    Object.freeze(span);
  }
  for (const point of stroke.points) {
    if ("anchor" in point) Object.freeze(point.anchor);
    Object.freeze(point);
  }
  Object.freeze(stroke.spans);
  Object.freeze(stroke.points);
  return Object.freeze(stroke);
}

/**
 * Validate and clone the persistence-safe freehand stroke v2 schema.
 *
 * Projection-local `order` and `logical` coordinates are intentionally not
 * represented. The exact layer retains 1:N source ordinals for an unchanged
 * projection, while the fallback envelope remains portable across projectors.
 */
export function normalizeFreehandStrokeV2(value: unknown): FreehandStrokeV2 | null {
  if (isRecord(value)) {
    const normalized = normalizedStrokes.get(value);
    if (normalized) return normalized.version === FREEHAND_STROKE_VERSION ? normalized : null;
  }
  if (!isRecord(value)
    || value.version !== FREEHAND_STROKE_VERSION
    || !Array.isArray(value.spans)
    || value.spans.length === 0
    || value.spans.length > MAX_FREEHAND_STROKE_SPANS
    || !Array.isArray(value.points)
    || value.points.length < 2
    || value.points.length > MAX_FREEHAND_STROKE_POINTS) {
    return null;
  }

  const sourceProjection = safeProjectionId(value.sourceProjection);
  const sourceProjectionConfig = safeFreehandProjectionConfig(value.sourceProjectionConfig);
  if (!sourceProjection || !sourceProjectionConfig) return null;

  const spans: SourceLineageSpan[] = [];
  for (const candidate of value.spans) {
    const span = normalizeSpan(candidate);
    if (!span) return null;
    spans.push(span);
  }
  const points: FreehandSpanPoint[] = [];
  for (const candidate of value.points) {
    const point = normalizePoint(candidate, spans.length);
    if (!point) return null;
    points.push(point);
  }

  const normalized = freezeNormalizedStroke({
    version: FREEHAND_STROKE_VERSION,
    sourceProjection,
    sourceProjectionConfig,
    spans,
    points,
  });
  normalizedStrokes.set(normalized, normalized);
  return normalized;
}

/**
 * Validate and clone the persistence-safe freehand stroke v3 schema. V3 keeps
 * the v2 span representation while permitting exact materialized anchors and
 * absolute source-time points. Each point is exactly one representation.
 */
export function normalizeFreehandStrokeV3(value: unknown): FreehandStrokeV3 | null {
  if (isRecord(value)) {
    const normalized = normalizedStrokes.get(value);
    if (normalized) return normalized.version === FREEHAND_STROKE_V3_VERSION ? normalized : null;
  }
  if (!isRecord(value)
    || value.version !== FREEHAND_STROKE_V3_VERSION
    || !Array.isArray(value.spans)
    || value.spans.length > MAX_FREEHAND_STROKE_SPANS
    || !Array.isArray(value.points)
    || value.points.length < 2
    || value.points.length > MAX_FREEHAND_STROKE_POINTS) {
    return null;
  }

  const sourceProjection = safeProjectionId(value.sourceProjection);
  const sourceProjectionConfig = safeFreehandProjectionConfig(value.sourceProjectionConfig);
  if (!sourceProjection || !sourceProjectionConfig) return null;

  const spans: SourceLineageSpan[] = [];
  for (const candidate of value.spans) {
    const span = normalizeV3Span(candidate);
    if (!span) return null;
    spans.push(span);
  }
  const points: FreehandStrokeV3Point[] = [];
  for (const candidate of value.points) {
    const point = normalizeV3Point(candidate, spans.length);
    if (!point) return null;
    points.push(point);
  }

  const normalized = freezeNormalizedStroke({
    version: FREEHAND_STROKE_V3_VERSION,
    sourceProjection,
    sourceProjectionConfig,
    spans,
    points,
  });
  normalizedStrokes.set(normalized, normalized);
  return normalized;
}

/** Dispatch only known persistent stroke versions. Unknown versions fail closed. */
export function normalizeFreehandStroke(value: unknown): FreehandStroke | null {
  if (!isRecord(value)) return null;
  if (value.version === FREEHAND_STROKE_VERSION) return normalizeFreehandStrokeV2(value);
  if (value.version === FREEHAND_STROKE_V3_VERSION) return normalizeFreehandStrokeV3(value);
  return null;
}

function spanKey(span: SourceLineageSpan): string {
  const { left, right } = span.exact;
  const fallback = span.fallback;
  return JSON.stringify([
    left.time,
    left.sourceOrdinal,
    right.time,
    right.sourceOrdinal,
    fallback.fromTime,
    fallback.toTime,
    fallback.leftRatio,
    fallback.rightRatio,
  ]);
}

function normalizeDraftCapture(value: unknown): DraftCapture | null {
  if (!isRecord(value)) return null;
  const price = finiteNumber(value.price);
  if (price === null) return null;

  let screen: ScreenPoint | null = null;
  if (value.screen !== null) {
    if (!isRecord(value.screen)) return null;
    const x = finiteNumber(value.screen.x);
    const y = finiteNumber(value.screen.y);
    if (x === null || y === null) return null;
    screen = { x, y };
  }

  const hasSpan = hasOwn(value, "span");
  const hasRatio = hasOwn(value, "ratio");
  const hasTime = hasOwn(value, "time");
  const hasAnchor = hasOwn(value, "anchor");
  const representationCount = Number(hasTime)
    + Number(hasAnchor)
    + Number(hasSpan || hasRatio);
  if (representationCount !== 1) return null;

  if (hasTime) {
    const time = safeTime(value.time);
    return time === null ? null : { time, price, screen };
  }
  if (hasAnchor) {
    const anchor = normalizeExactAnchor(value.anchor);
    return !anchor || safeTime(anchor.time) === null
      ? null
      : { anchor, price, screen };
  }

  if (!hasSpan || !hasRatio) return null;
  const span = normalizeSpan(value.span);
  const ratio = finiteNumber(value.ratio);
  if (!span || ratio === null || ratio < 0 || ratio > 1) return null;
  return { span, ratio, price, screen };
}

function createDraftSampleStorage(): DraftSampleStorage {
  return { chunks: [], length: 0 };
}

function createDraftSampleChunk(): DraftSampleChunk {
  return {
    length: 0,
    kinds: new Uint8Array(FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY),
    screenPresent: new Uint8Array(FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY),
    values: new Float64Array(
      FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY * DRAFT_VALUE_FIELD_COUNT,
    ),
  };
}

function draftValueIndex(field: number, offset: number): number {
  return field * FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY + offset;
}

function draftChunkAt(samples: DraftSampleStorage, index: number): DraftSampleChunk | null {
  if (!Number.isSafeInteger(index) || index < 0 || index >= samples.length) return null;
  return samples.chunks[Math.floor(index / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY)] ?? null;
}

function draftValueAt(samples: DraftSampleStorage, index: number, field: number): number {
  const chunk = draftChunkAt(samples, index);
  if (!chunk) return 0;
  const offset = index % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
  return chunk.values[draftValueIndex(field, offset)] ?? 0;
}

function draftKindAt(samples: DraftSampleStorage, index: number): number {
  const chunk = draftChunkAt(samples, index);
  if (!chunk) return -1;
  return chunk.kinds[index % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY] ?? -1;
}

function draftHasScreenAt(samples: DraftSampleStorage, index: number): boolean {
  const chunk = draftChunkAt(samples, index);
  if (!chunk) return false;
  return (chunk.screenPresent[index % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY] ?? 0) === 1;
}

function appendDraftSample(
  samples: DraftSampleStorage,
  kind: number,
  primary: number,
  secondary: number,
  price: number,
  screen: ScreenPoint | null,
): boolean {
  if (samples.length >= MAX_FREEHAND_STROKE_POINTS) return false;
  const index = samples.length;
  const chunkIndex = Math.floor(index / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY);
  let chunk = samples.chunks[chunkIndex];
  if (!chunk) {
    chunk = createDraftSampleChunk();
    samples.chunks[chunkIndex] = chunk;
  }
  const offset = index % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
  chunk.kinds[offset] = kind;
  chunk.values[draftValueIndex(DRAFT_VALUE_PRIMARY, offset)] = primary;
  chunk.values[draftValueIndex(DRAFT_VALUE_SECONDARY, offset)] = secondary;
  chunk.values[draftValueIndex(DRAFT_VALUE_PRICE, offset)] = price;
  if (screen) {
    chunk.screenPresent[offset] = 1;
    chunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_X, offset)] = screen.x;
    chunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_Y, offset)] = screen.y;
  } else {
    chunk.screenPresent[offset] = 0;
  }
  chunk.length = offset + 1;
  samples.length = index + 1;
  return true;
}

function clearDraftSampleStorage(samples: DraftSampleStorage): void {
  samples.chunks.length = 0;
  samples.length = 0;
}

function squaredPerpendicularDistance(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const pointDx = pointX - startX;
    const pointDy = pointY - startY;
    return pointDx * pointDx + pointDy * pointDy;
  }
  const amount = Math.max(0, Math.min(1,
    ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared));
  const projectedDx = pointX - (startX + amount * dx);
  const projectedDy = pointY - (startY + amount * dy);
  return projectedDx * projectedDx + projectedDy * projectedDy;
}

interface RadialPathCandidates {
  indexes: Int32Array;
  length: number;
}

/**
 * Linear radial-distance pre-pass used only for long, fully resolved paths.
 * RDP still decides the final geometry, but no longer rescans thousands of
 * sub-pixel samples that cannot materially change a 1.5 CSS-pixel result.
 */
function radialPathCandidates(
  samples: DraftSampleStorage,
  start: number,
  end: number,
  epsilonSquared: number,
): RadialPathCandidates {
  const indexes = new Int32Array(end - start + 1);
  if (epsilonSquared <= 0 || end - start < FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY) {
    let length = 0;
    for (let index = start; index <= end; index += 1) {
      indexes[length] = index;
      length += 1;
    }
    return { indexes, length };
  }

  let length = 1;
  indexes[0] = start;
  const startChunk = samples.chunks[
    Math.floor(start / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY)
  ];
  const startOffset = start % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
  let previousX = startChunk?.values[
    draftValueIndex(DRAFT_VALUE_SCREEN_X, startOffset)
  ] ?? 0;
  let previousY = startChunk?.values[
    draftValueIndex(DRAFT_VALUE_SCREEN_Y, startOffset)
  ] ?? 0;

  let chunkIndex = Math.floor((start + 1) / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY);
  let chunk = samples.chunks[chunkIndex];
  let offset = (start + 1) % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
  for (let index = start + 1; index < end; index += 1) {
    if (offset === FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY) {
      chunkIndex += 1;
      chunk = samples.chunks[chunkIndex];
      offset = 0;
    }
    const x = chunk?.values[draftValueIndex(DRAFT_VALUE_SCREEN_X, offset)] ?? previousX;
    const y = chunk?.values[draftValueIndex(DRAFT_VALUE_SCREEN_Y, offset)] ?? previousY;
    const dx = x - previousX;
    const dy = y - previousY;
    if (dx * dx + dy * dy > epsilonSquared) {
      indexes[length] = index;
      length += 1;
      previousX = x;
      previousY = y;
    }
    offset += 1;
  }
  indexes[length] = end;
  return { indexes, length: length + 1 };
}

function retainPathIndexes(
  samples: DraftSampleStorage,
  start: number,
  end: number,
  epsilon: number,
  retained: Uint8Array,
): void {
  const epsilonSquared = epsilon * epsilon;
  const candidates = radialPathCandidates(samples, start, end, epsilonSquared);
  retainCandidatePathIndexes(samples, candidates, epsilonSquared, retained);
}

function retainCandidatePathIndexes(
  samples: DraftSampleStorage,
  candidates: RadialPathCandidates,
  epsilonSquared: number,
  retained: Uint8Array,
): void {
  const candidateEnd = candidates.length - 1;
  const first = candidates.indexes[0] ?? -1;
  const last = candidates.indexes[candidateEnd] ?? -1;
  if (first < 0 || last < 0) return;
  retained[first] = 1;
  retained[last] = 1;
  // One path can schedule at most one segment per retained point. A flat
  // bounded stack avoids thousands of short-lived tuple allocations on a
  // saturated 4096-sample mouseup.
  const stack = new Int32Array(Math.max(2, candidates.length * 2));
  let stackLength = 2;
  stack[0] = 0;
  stack[1] = candidateEnd;
  while (stackLength > 0) {
    const rightPosition = stack[stackLength - 1] ?? -1;
    const leftPosition = stack[stackLength - 2] ?? -1;
    stackLength -= 2;
    if (rightPosition - leftPosition <= 1) continue;
    const left = candidates.indexes[leftPosition] ?? -1;
    const right = candidates.indexes[rightPosition] ?? -1;
    let farthestIndex = -1;
    let farthestPosition = -1;
    let farthestDistanceSquared = 0;
    const leftChunk = samples.chunks[
      Math.floor(left / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY)
    ];
    const rightChunk = samples.chunks[
      Math.floor(right / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY)
    ];
    const leftOffset = left % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
    const rightOffset = right % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
    if (!leftChunk || !rightChunk
      || leftChunk.screenPresent[leftOffset] !== 1
      || rightChunk.screenPresent[rightOffset] !== 1) continue;
    const startX = leftChunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_X, leftOffset)] ?? 0;
    const startY = leftChunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_Y, leftOffset)] ?? 0;
    const endX = rightChunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_X, rightOffset)] ?? 0;
    const endY = rightChunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_Y, rightOffset)] ?? 0;
    for (let position = leftPosition + 1; position < rightPosition; position += 1) {
      const index = candidates.indexes[position] ?? -1;
      const chunk = samples.chunks[
        Math.floor(index / FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY)
      ];
      const offset = index % FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY;
      if (chunk && chunk.screenPresent[offset] === 1) {
        const distanceSquared = squaredPerpendicularDistance(
          chunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_X, offset)] ?? 0,
          chunk.values[draftValueIndex(DRAFT_VALUE_SCREEN_Y, offset)] ?? 0,
          startX,
          startY,
          endX,
          endY,
        );
        if (distanceSquared > farthestDistanceSquared) {
          farthestDistanceSquared = distanceSquared;
          farthestIndex = index;
          farthestPosition = position;
        }
      }
    }
    if (farthestIndex >= 0
      && farthestPosition >= 0
      && farthestDistanceSquared > epsilonSquared) {
      retained[farthestIndex] = 1;
      stack[stackLength] = leftPosition;
      stack[stackLength + 1] = farthestPosition;
      stack[stackLength + 2] = farthestPosition;
      stack[stackLength + 3] = rightPosition;
      stackLength += 4;
    }
  }
}

function retainedDraftIndexes(samples: DraftSampleStorage, epsilon: number): Uint8Array | null {
  const retained = new Uint8Array(samples.length);
  let pathStart = -1;
  let hasRenderablePath = false;
  for (let index = 0; index <= samples.length; index += 1) {
    const isPathPoint = index < samples.length && draftHasScreenAt(samples, index);
    if (isPathPoint && pathStart < 0) pathStart = index;
    if (isPathPoint) continue;

    if (pathStart >= 0) {
      const pathEnd = index - 1;
      if (pathEnd > pathStart) hasRenderablePath = true;
      const pathLength = pathEnd - pathStart + 1;
      if (pathLength <= FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY) {
        retainPathIndexes(samples, pathStart, pathEnd, epsilon, retained);
      } else {
        // First simplify overlapping fixed windows so terminal work is bounded
        // by the storage chunk size. A final RDP over those candidates removes
        // artificial window boundaries (for example, one long straight line).
        const windowRetained = new Uint8Array(samples.length);
        let windowStart = pathStart;
        while (windowStart < pathEnd) {
          const windowEnd = Math.min(
            pathEnd,
            windowStart + FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY - 1,
          );
          retainPathIndexes(samples, windowStart, windowEnd, epsilon, windowRetained);
          windowStart = windowEnd;
        }
        let candidateCount = 0;
        for (let candidate = pathStart; candidate <= pathEnd; candidate += 1) {
          if (windowRetained[candidate] === 1) candidateCount += 1;
        }
        const candidateIndexes = new Int32Array(candidateCount);
        let candidatePosition = 0;
        for (let candidate = pathStart; candidate <= pathEnd; candidate += 1) {
          if (windowRetained[candidate] !== 1) continue;
          candidateIndexes[candidatePosition] = candidate;
          candidatePosition += 1;
        }
        retainCandidatePathIndexes(
          samples,
          { indexes: candidateIndexes, length: candidateCount },
          epsilon * epsilon,
          retained,
        );
      }
      pathStart = -1;
    }
    // A valid capture whose screen coordinate could not be resolved is a path
    // separator and must survive decimation so later rendering cannot bridge it.
    if (index < samples.length) retained[index] = 1;
  }
  return hasRenderablePath ? retained : null;
}

/**
 * Create a helper-managed mutable v2/v3 draft. `captureIdentity` is deliberately
 * opaque and compared by reference; it is never copied into the saved stroke.
 */
export function createFreehandStrokeDraft({
  sourceProjection,
  sourceProjectionConfig,
  captureIdentity,
}: FreehandStrokeDraftOptions = {}): FreehandStrokeDraft | null {
  const projection = safeProjectionId(sourceProjection);
  const config = safeFreehandProjectionConfig(sourceProjectionConfig);
  if (!projection || !config || captureIdentity === null || captureIdentity === undefined) {
    return null;
  }
  const draft: FreehandStrokeDraft = {};
  draftStates.set(draft, {
    sourceProjection: projection,
    sourceProjectionConfig: config,
    captureIdentity,
    spans: [],
    spanIndexes: new Map(),
    samples: createDraftSampleStorage(),
    saturated: false,
    cancelled: false,
  });
  return draft;
}

function appendNormalizedDraftCapture(state: DraftState, normalized: DraftCapture): boolean {
  if (state.samples.length >= MAX_FREEHAND_STROKE_POINTS) return false;
  if ("span" in normalized) {
    const key = spanKey(normalized.span);
    let span = state.spanIndexes.get(key);
    if (span === undefined) {
      if (state.spans.length >= MAX_FREEHAND_STROKE_SPANS) return false;
      span = state.spans.length;
      state.spanIndexes.set(key, span);
      state.spans.push(normalized.span);
    }
    if (!appendDraftSample(
      state.samples,
      DRAFT_KIND_SPAN,
      span,
      normalized.ratio,
      normalized.price,
      normalized.screen,
    )) return false;
  } else if ("time" in normalized) {
    if (!appendDraftSample(
      state.samples,
      DRAFT_KIND_TIME,
      normalized.time,
      0,
      normalized.price,
      normalized.screen,
    )) return false;
  } else {
    if (!appendDraftSample(
      state.samples,
      DRAFT_KIND_ANCHOR,
      normalized.anchor.time,
      normalized.anchor.sourceOrdinal,
      normalized.price,
      normalized.screen,
    )) return false;
  }
  if (state.samples.length >= MAX_FREEHAND_STROKE_POINTS) state.saturated = true;
  return true;
}

/** Append one capture. The draft is unchanged when validation fails. */
export function appendFreehandStrokeCapture(
  draft: FreehandStrokeDraft | null | undefined,
  capture: unknown,
  captureIdentity: unknown,
): boolean {
  if (!draft) return false;
  const state = draftStates.get(draft);
  const normalized = normalizeDraftCapture(capture);
  if (!state
    || state.cancelled
    || state.saturated
    || captureIdentity !== state.captureIdentity
    || !normalized
    || state.samples.length >= MAX_FREEHAND_STROKE_POINTS) {
    return false;
  }
  return appendNormalizedDraftCapture(state, normalized);
}

/** Append a capture batch atomically. */
export function appendFreehandStrokeCaptureBatch(
  draft: FreehandStrokeDraft | null | undefined,
  batch: FreehandCaptureBatch | null | undefined,
): boolean {
  if (!draft) return false;
  const state = draftStates.get(draft);
  if (!state
    || state.cancelled
    || state.saturated
    || batch?.captureIdentity !== state.captureIdentity
    || batch?.sourceProjection !== state.sourceProjection
    || batch?.sourceProjectionConfig !== state.sourceProjectionConfig
    || !Array.isArray(batch?.captures)
    || batch.captures.length === 0
    || state.samples.length + batch.captures.length > MAX_FREEHAND_STROKE_POINTS) {
    return false;
  }

  const normalizedCaptures = new Array<DraftCapture>(batch.captures.length);
  for (let index = 0; index < batch.captures.length; index += 1) {
    const capture = normalizeDraftCapture(batch.captures[index]);
    if (!capture) return false;
    normalizedCaptures[index] = capture;
  }
  const newKeys = new Set<string>();
  for (const capture of normalizedCaptures) {
    if (!("span" in capture)) continue;
    const key = spanKey(capture.span);
    if (!state.spanIndexes.has(key)) newKeys.add(key);
  }
  if (state.spans.length + newKeys.size > MAX_FREEHAND_STROKE_SPANS) return false;

  for (const capture of normalizedCaptures) {
    if (!appendNormalizedDraftCapture(state, capture)) return false;
  }
  return true;
}

function previewPointFromCapture(capture: DraftCapture): ScreenPoint | null {
  return capture.screen ? { ...capture.screen } : null;
}

/**
 * Append as much of one live pointer batch as the bounded draft can retain.
 * Invalid identity/data returns `null` without mutation. Capacity exhaustion is
 * a successful terminal state: callers keep the draft and commit it on mouseup.
 */
export function appendFreehandStrokeCaptureBatchIncremental(
  draft: FreehandStrokeDraft | null | undefined,
  batch: FreehandCaptureBatch | null | undefined,
): FreehandAppendResult | null {
  if (!draft) return null;
  const state = draftStates.get(draft);
  if (!state
    || state.cancelled
    || batch?.captureIdentity !== state.captureIdentity
    || batch?.sourceProjection !== state.sourceProjection
    || batch?.sourceProjectionConfig !== state.sourceProjectionConfig
    || !Array.isArray(batch?.captures)
    || batch.captures.length === 0) {
    return null;
  }
  if (state.saturated) {
    return { appendedCount: 0, previewPoints: [], saturated: true };
  }

  const normalizedCaptures = new Array<DraftCapture>(batch.captures.length);
  for (let index = 0; index < batch.captures.length; index += 1) {
    const capture = normalizeDraftCapture(batch.captures[index]);
    if (!capture) return null;
    normalizedCaptures[index] = capture;
  }

  const availablePoints = MAX_FREEHAND_STROKE_POINTS - state.samples.length;
  const availableSpans = MAX_FREEHAND_STROKE_SPANS - state.spans.length;
  const pendingSpanKeys = new Set<string>();
  let appendCount = 0;
  for (const capture of normalizedCaptures) {
    if (appendCount >= availablePoints) break;
    if ("span" in capture) {
      const key = spanKey(capture.span);
      if (!state.spanIndexes.has(key) && !pendingSpanKeys.has(key)) {
        if (pendingSpanKeys.size >= availableSpans) break;
        pendingSpanKeys.add(key);
      }
    }
    appendCount += 1;
  }

  const previewPoints = new Array<ScreenPoint | null>(appendCount);
  for (let index = 0; index < appendCount; index += 1) {
    const capture = normalizedCaptures[index];
    if (!capture) return null;
    if (!appendNormalizedDraftCapture(state, capture)) return null;
    previewPoints[index] = previewPointFromCapture(capture);
  }
  if (appendCount < normalizedCaptures.length) state.saturated = true;

  return {
    appendedCount: appendCount,
    previewPoints,
    saturated: state.saturated,
  };
}

export function isFreehandStrokeDraftSaturated(
  draft: FreehandStrokeDraft | null | undefined,
): boolean {
  if (!draft) return false;
  const state = draftStates.get(draft);
  return !!state && !state.cancelled && state.saturated;
}

export function getFreehandStrokeDraftRemainingCapacity(
  draft: FreehandStrokeDraft | null | undefined,
): number | null {
  if (!draft) return null;
  const state = draftStates.get(draft);
  return state && !state.cancelled
    ? Math.max(0, MAX_FREEHAND_STROKE_POINTS - state.samples.length)
    : null;
}

/** Return a defensive screen-space preview, preserving null path gaps. */
export function getFreehandStrokeDraftPreviewPoints(
  draft: FreehandStrokeDraft | null | undefined,
): Array<ScreenPoint | null> {
  if (!draft) return [];
  const state = draftStates.get(draft);
  if (!state || state.cancelled) return [];
  const preview = new Array<ScreenPoint | null>(state.samples.length);
  for (let index = 0; index < state.samples.length; index += 1) {
    preview[index] = draftHasScreenAt(state.samples, index)
      ? {
          x: draftValueAt(state.samples, index, DRAFT_VALUE_SCREEN_X),
          y: draftValueAt(state.samples, index, DRAFT_VALUE_SCREEN_Y),
        }
      : null;
  }
  return preview;
}

/** Return immutable storage metadata without exposing mutable draft buffers. */
export function inspectFreehandStrokeDraftStorage(
  draft: FreehandStrokeDraft | null | undefined,
): FreehandStrokeDraftStorageInspection | null {
  if (!draft) return null;
  const state = draftStates.get(draft);
  if (!state || state.cancelled) return null;
  const chunks = state.samples.chunks;
  return {
    chunkCapacity: FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY,
    chunkCount: chunks.length,
    sampleCount: state.samples.length,
    allocatedSlots: chunks.length * FREEHAND_STROKE_DRAFT_CHUNK_CAPACITY,
    chunkLengths: chunks.map((chunk) => chunk.length),
    typedArrayBacked: chunks.every((chunk) => (
      chunk.kinds instanceof Uint8Array
        && chunk.screenPresent instanceof Uint8Array
        && chunk.values instanceof Float64Array
    )),
  };
}

/** Cancel and empty a draft. It cannot subsequently be appended or finalized. */
export function cancelFreehandStrokeDraft(
  draft: FreehandStrokeDraft | null | undefined,
): boolean {
  if (!draft) return false;
  const state = draftStates.get(draft);
  if (!state || state.cancelled) return false;
  state.cancelled = true;
  state.spans.length = 0;
  clearDraftSampleStorage(state.samples);
  state.spanIndexes.clear();
  draftStates.delete(draft);
  return true;
}

/**
 * Finalize with iterative, path-local screen-space RDP. Kept sample indexes
 * select the persistent points, after which unused spans are removed/remapped.
 */
export function finalizeFreehandStrokeDraft(draft: FreehandStrokeDraft | null | undefined, {
  captureIdentity,
  epsilon = 1.5,
}: FreehandFinalizeOptions = {}): FreehandStroke | null {
  if (!draft) return null;
  const state = draftStates.get(draft);
  const tolerance = finiteNumber(epsilon);
  if (!state
    || state.cancelled
    || captureIdentity !== state.captureIdentity
    || tolerance === null
    || tolerance < 0
    || state.samples.length < 2) {
    return null;
  }
  const retained = retainedDraftIndexes(state.samples, tolerance);
  if (!retained) return null;
  let keptCount = 0;
  let usesV3Point = false;
  const usedSpans = new Set<number>();
  for (let index = 0; index < state.samples.length; index += 1) {
    if (retained[index] !== 1) continue;
    keptCount += 1;
    const kind = draftKindAt(state.samples, index);
    if (kind === DRAFT_KIND_SPAN) {
      usedSpans.add(draftValueAt(state.samples, index, DRAFT_VALUE_PRIMARY));
    } else if (kind === DRAFT_KIND_TIME || kind === DRAFT_KIND_ANCHOR) {
      usesV3Point = true;
    } else {
      return null;
    }
  }
  if (keptCount < 2) return null;

  const remap = new Map<number, number>();
  const spans: SourceLineageSpan[] = [];
  for (let index = 0; index < state.spans.length; index += 1) {
    if (!usedSpans.has(index)) continue;
    const span = state.spans[index];
    if (!span) continue;
    remap.set(index, spans.length);
    spans.push(span);
  }
  const points = new Array<FreehandStrokeV3Point>(keptCount);
  let pointIndex = 0;
  for (let index = 0; index < state.samples.length; index += 1) {
    if (retained[index] !== 1) continue;
    const kind = draftKindAt(state.samples, index);
    const primary = draftValueAt(state.samples, index, DRAFT_VALUE_PRIMARY);
    const secondary = draftValueAt(state.samples, index, DRAFT_VALUE_SECONDARY);
    const price = draftValueAt(state.samples, index, DRAFT_VALUE_PRICE);
    if (kind === DRAFT_KIND_TIME) {
      points[pointIndex] = { time: primary, price };
    } else if (kind === DRAFT_KIND_ANCHOR) {
      points[pointIndex] = {
        anchor: { time: primary, sourceOrdinal: secondary },
        price,
      };
    } else if (kind === DRAFT_KIND_SPAN) {
      points[pointIndex] = {
        span: remap.get(primary) ?? primary,
        ratio: secondary,
        price,
      };
    } else {
      return null;
    }
    pointIndex += 1;
  }
  // Every draft sample and span crossed the strict append boundary already.
  // Canonicalize this private representation in place so mouseup does not
  // validate and deep-clone the same bounded stroke a second time.
  const stroke = freezeNormalizedStroke({
    version: usesV3Point ? FREEHAND_STROKE_V3_VERSION : FREEHAND_STROKE_VERSION,
    sourceProjection: state.sourceProjection,
    sourceProjectionConfig: state.sourceProjectionConfig,
    spans,
    points,
  } as FreehandStroke);
  normalizedStrokes.set(stroke, stroke);
  return stroke;
}

function normalizeResolvedSpan(value: unknown): ResolvedFreehandSpan | null {
  if (!isRecord(value)) return null;
  const left = finiteNumber(value.left);
  const right = finiteNumber(value.right);
  return left !== null && right !== null && left < right
    ? { left, right }
    : null;
}

function resolveNormalizedFreehandStrokePoints(stroke: FreehandStroke, {
  resolveAnchor,
  resolveBatch,
  resolveSpan,
  resolveTime,
}: FreehandStrokeResolvers): Array<ResolvedFreehandPoint | null> {
  const batchRequests: FreehandBatchResolveRequest[] = [];
  const batchRequestIndexes = new Map<number, number>();
  if (stroke.version === FREEHAND_STROKE_V3_VERSION && typeof resolveBatch === "function") {
    for (let pointIndex = 0; pointIndex < stroke.points.length; pointIndex += 1) {
      const point = stroke.points[pointIndex];
      if (!point || "span" in point) continue;
      batchRequestIndexes.set(pointIndex, batchRequests.length);
      batchRequests.push("time" in point
        ? { kind: "time", time: point.time, pointIndex, point }
        : { kind: "anchor", anchor: point.anchor, pointIndex, point });
    }
  }

  let batchCoordinates: Array<number | null> | null = null;
  if (batchRequests.length > 0 && typeof resolveBatch === "function") {
    try {
      const candidate = resolveBatch(batchRequests, stroke as FreehandStrokeV3);
      if (Array.isArray(candidate)
        && candidate.length === batchRequests.length
        && candidate.every((value) => value === null || finiteNumber(value) !== null)) {
        batchCoordinates = candidate.map((value) => (
          value === null ? null : finiteNumber(value)
        ));
      }
    } catch {
      batchCoordinates = null;
    }
  }

  const resolvedSpans = new Map<number, ResolvedFreehandSpan | null>();
  return stroke.points.map((point, pointIndex) => {
    if ("time" in point) {
      const batchIndex = batchRequestIndexes.get(pointIndex);
      if (batchIndex !== undefined) {
        const x = batchCoordinates?.[batchIndex] ?? null;
        return x === null ? null : { x, price: point.price };
      }
      if (stroke.version !== FREEHAND_STROKE_V3_VERSION || typeof resolveTime !== "function") {
        return null;
      }
      let x: number | null = null;
      try {
        x = finiteNumber(resolveTime(point.time, pointIndex, point, stroke));
      } catch {
        x = null;
      }
      return x === null ? null : { x, price: point.price };
    }
    if ("anchor" in point) {
      const batchIndex = batchRequestIndexes.get(pointIndex);
      if (batchIndex !== undefined) {
        const x = batchCoordinates?.[batchIndex] ?? null;
        return x === null ? null : { x, price: point.price };
      }
      if (stroke.version !== FREEHAND_STROKE_V3_VERSION || typeof resolveAnchor !== "function") {
        return null;
      }
      let x: number | null = null;
      try {
        x = finiteNumber(resolveAnchor(point.anchor, pointIndex, point, stroke));
      } catch {
        x = null;
      }
      return x === null ? null : { x, price: point.price };
    }

    if (!resolvedSpans.has(point.span)) {
      let resolved: ResolvedFreehandSpan | null = null;
      const sourceSpan = stroke.spans[point.span];
      if (sourceSpan && typeof resolveSpan === "function") {
        try {
          resolved = normalizeResolvedSpan(resolveSpan(
            sourceSpan,
            point.span,
            stroke,
          ));
        } catch {
          resolved = null;
        }
      }
      resolvedSpans.set(point.span, resolved);
    }

    const span = resolvedSpans.get(point.span);
    if (!span) return null;
    return {
      x: span.left + (span.right - span.left) * point.ratio,
      price: point.price,
    };
  });
}

/**
 * Resolve a v2 stroke with at most one bridge call per referenced span.
 * Unresolved spans become `null` path gaps; callers must not reconnect across
 * those markers.
 */
export function resolveFreehandStrokeV2Points(
  value: unknown,
  resolveSpan: FreehandSpanResolver | null | undefined,
): Array<ResolvedFreehandPoint | null> {
  const stroke = normalizeFreehandStrokeV2(value);
  return stroke && typeof resolveSpan === "function"
    ? resolveNormalizedFreehandStrokePoints(stroke, {
        resolveAnchor: null,
        resolveBatch: null,
        resolveSpan,
        resolveTime: null,
      })
    : [];
}

/** Resolve a strict v3 stroke through lineage-span and absolute-time bridges. */
export function resolveFreehandStrokeV3Points(value: unknown, {
  resolveAnchor = null,
  resolveBatch = null,
  resolveSpan = null,
  resolveTime = null,
}: FreehandStrokeResolvers = {}): Array<ResolvedFreehandPoint | null> {
  const stroke = normalizeFreehandStrokeV3(value);
  return stroke
    ? resolveNormalizedFreehandStrokePoints(stroke, {
        resolveAnchor,
        resolveBatch,
        resolveSpan,
        resolveTime,
      })
    : [];
}

/** Resolve any known persistent stroke version; unknown versions fail closed. */
export function resolveFreehandStrokePoints(value: unknown, {
  resolveAnchor = null,
  resolveBatch = null,
  resolveSpan = null,
  resolveTime = null,
}: FreehandStrokeResolvers = {}): Array<ResolvedFreehandPoint | null> {
  if (!isRecord(value)) return [];
  if (value.version === FREEHAND_STROKE_VERSION) {
    return resolveFreehandStrokeV2Points(value, resolveSpan);
  }
  if (value.version === FREEHAND_STROKE_V3_VERSION) {
    return resolveFreehandStrokeV3Points(value, {
      resolveAnchor,
      resolveBatch,
      resolveSpan,
      resolveTime,
    });
  }
  return [];
}
