import type { DrawingRenderRevisionStamp } from "../engine/drawingRenderScheduler.js";
import type { DrawingKind } from "../drawingTypes.js";

export const DRAWING_WORKER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_DRAWING_WORKER_MAX_RESULT_BYTES = 32 * 1024 * 1024;
export const HARD_DRAWING_WORKER_MAX_RESULT_BYTES = 64 * 1024 * 1024;

/**
 * Transparent pixels in a cropped atlas tile must be a no-op on the target.
 * Pen/highlighter use these two operations. Modes such as `copy` or
 * `source-in` can modify the whole transparent tile rectangle and therefore
 * stay on the exact main-thread path.
 */
export function isDrawingWorkerRasterCompositeOperation(
  value: unknown,
): value is GlobalCompositeOperation {
  return value === "source-over" || value === "multiply";
}

export interface DrawingWorkerJobHeader {
  readonly schemaVersion: typeof DRAWING_WORKER_SCHEMA_VERSION;
  readonly jobId: number;
  /** Monotonic client generation used for cooperative cancellation. */
  readonly generation: number;
  /** Complete render invalidation boundary; partial viewport stamps are forbidden. */
  readonly stamp: DrawingRenderRevisionStamp;
}

export interface DrawingWorkerEntityUpsertPatch {
  readonly op: "upsert";
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly entityId: string;
  readonly kind: DrawingKind;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  /** Immutable canonical x/y pairs. NaN pairs represent retained gaps. */
  readonly canonicalPoints: Float64Array;
  /** Canonical point indexes where a new continuous path starts. */
  readonly pathBreaks: Uint32Array;
}

export interface DrawingWorkerEntityDeletePatch {
  readonly op: "delete";
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly entityId: string;
}

export type DrawingWorkerEntityPatch =
  | DrawingWorkerEntityUpsertPatch
  | DrawingWorkerEntityDeletePatch;

/**
 * Serializable paint state for one freehand/highlighter display-list entity.
 * `entityIndex` is the canonical z-order index in the viewport arrays.
 */
export interface DrawingWorkerFreehandPaintSpec {
  readonly entityIndex: number;
  readonly strokeColor: string;
  readonly selectionHighlightColor: string;
  readonly lineWidthCssPx: number;
  readonly opacity: number;
  readonly compositeOperation: GlobalCompositeOperation;
  readonly brushShape: "round" | "square";
  readonly pathInterpolation: "linear" | "quadratic";
  readonly selected: boolean;
}

/**
 * Final public-LWC-projected screen geometry. The worker may validate, batch,
 * or paint this bounded payload, but it must never redo chart projection.
 */
export interface DrawingWorkerViewportPayload {
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly dpr: number;
  readonly entityIds: readonly string[];
  readonly kindCodes: Uint8Array;
  readonly pointOffsets: Uint32Array;
  readonly pointCounts: Uint32Array;
  readonly points: Float64Array;
  readonly bboxes: Float64Array;
  readonly pathBreakOffsets: Uint32Array;
  readonly pathBreakCounts: Uint32Array;
  readonly pathBreaks: Uint32Array;
  /** Freehand/highlighter-only paint state; entries need not cover other kinds. */
  readonly paintSpecs: readonly DrawingWorkerFreehandPaintSpec[];
}

export interface DrawingWorkerRenderRequest {
  readonly type: "drawing-worker/render";
  readonly header: DrawingWorkerJobHeader;
  /** Incremental canonical mirror mutations; unchanged entities are omitted. */
  readonly patches: readonly DrawingWorkerEntityPatch[];
  readonly viewport: DrawingWorkerViewportPayload;
  readonly maxResultBytes: number;
}

export interface DrawingWorkerCancelRequest {
  readonly type: "drawing-worker/cancel";
  readonly schemaVersion: typeof DRAWING_WORKER_SCHEMA_VERSION;
  /** Cancel every active job at or below this generation. */
  readonly throughGeneration: number;
}

export type DrawingWorkerRequest = DrawingWorkerRenderRequest | DrawingWorkerCancelRequest;

export interface DrawingWorkerTypedDrawResult extends DrawingWorkerViewportPayload {
  readonly kind: "typed-draw-result";
  readonly byteLength: number;
  readonly rawPointCount: number;
  readonly renderedPointCount: number;
  readonly canonicalEntityCount: number;
}

/**
 * One independently composited entity tile inside the transferred bitmap
 * atlas. The main-thread renderer inserts it at `entityIndex` in canonical
 * scene z-order and owns opacity/compositing at the final target.
 */
export interface DrawingWorkerBitmapLayer {
  readonly entityIndex: number;
  /** Inclusive canonical z-order end for a safely flattened source-over run. */
  readonly lastEntityIndex: number;
  readonly sourceXPhysicalPx: number;
  readonly sourceYPhysicalPx: number;
  readonly sourceWidthPhysicalPx: number;
  readonly sourceHeightPhysicalPx: number;
  readonly destinationXCssPx: number;
  readonly destinationYCssPx: number;
  readonly destinationWidthCssPx: number;
  readonly destinationHeightCssPx: number;
  readonly opacity: number;
  readonly compositeOperation: GlobalCompositeOperation;
}

export interface DrawingWorkerBitmapDrawResult {
  readonly kind: "bitmap-draw-result";
  readonly bitmap: ImageBitmap;
  /** Plot-frame CSS dimensions represented by the projected payload. */
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly dpr: number;
  readonly atlasWidthPhysicalPx: number;
  readonly atlasHeightPhysicalPx: number;
  /** RGBA atlas backing-store bytes used for budget enforcement. */
  readonly byteLength: number;
  readonly layers: readonly DrawingWorkerBitmapLayer[];
  readonly rawPointCount: number;
  readonly renderedPointCount: number;
  readonly canonicalEntityCount: number;
}

export type DrawingWorkerDrawResult =
  | DrawingWorkerTypedDrawResult
  | DrawingWorkerBitmapDrawResult;

export interface DrawingWorkerRenderResponse {
  readonly type: "drawing-worker/result";
  readonly header: DrawingWorkerJobHeader;
  readonly result: DrawingWorkerDrawResult;
}

export interface DrawingWorkerCancelledResponse {
  readonly type: "drawing-worker/cancelled";
  readonly header: DrawingWorkerJobHeader;
}

export interface DrawingWorkerErrorResponse {
  readonly type: "drawing-worker/error";
  readonly header: DrawingWorkerJobHeader;
  readonly code: "invalid-request" | "processing-failed" | "result-too-large";
  readonly message: string;
}

export type DrawingWorkerResponse =
  | DrawingWorkerRenderResponse
  | DrawingWorkerCancelledResponse
  | DrawingWorkerErrorResponse;

export function createDrawingWorkerJobHeader(
  jobId: number,
  generation: number,
  stamp: DrawingRenderRevisionStamp,
): DrawingWorkerJobHeader {
  if (!validSequence(jobId) || !validSequence(generation) || !isDrawingRenderStamp(stamp)) {
    throw new TypeError("drawing worker job header is invalid");
  }
  return Object.freeze({
    schemaVersion: DRAWING_WORKER_SCHEMA_VERSION,
    jobId,
    generation,
    stamp: Object.freeze({ ...stamp }),
  });
}

export function sameDrawingWorkerStamp(
  left: DrawingRenderRevisionStamp,
  right: DrawingRenderRevisionStamp,
): boolean {
  return left.scopeKey === right.scopeKey
    && left.documentRevision === right.documentRevision
    && left.surfaceGeneration === right.surfaceGeneration
    && left.dataRevision === right.dataRevision
    && left.projectionRevision === right.projectionRevision
    && left.lineageIndexRevision === right.lineageIndexRevision
    && left.viewportRevision === right.viewportRevision
    && left.themeRevision === right.themeRevision
    && left.widthCssPx === right.widthCssPx
    && left.heightCssPx === right.heightCssPx
    && left.dpr === right.dpr;
}

export function sameDrawingWorkerJob(
  left: DrawingWorkerJobHeader,
  right: DrawingWorkerJobHeader,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.jobId === right.jobId
    && left.generation === right.generation
    && sameDrawingWorkerStamp(left.stamp, right.stamp);
}

export function drawingWorkerViewportByteLength(payload: DrawingWorkerViewportPayload): number {
  return payload.kindCodes.byteLength
    + payload.pointOffsets.byteLength
    + payload.pointCounts.byteLength
    + payload.points.byteLength
    + payload.bboxes.byteLength
    + payload.pathBreakOffsets.byteLength
    + payload.pathBreakCounts.byteLength
    + payload.pathBreaks.byteLength;
}

export function drawingWorkerBitmapByteLength(
  payload: Pick<DrawingWorkerViewportPayload, "widthCssPx" | "heightCssPx" | "dpr">,
): number {
  const width = Math.ceil(payload.widthCssPx * payload.dpr);
  const height = Math.ceil(payload.heightCssPx * payload.dpr);
  const byteLength = width * height * 4;
  return Number.isSafeInteger(byteLength) ? byteLength : Number.POSITIVE_INFINITY;
}

export function isDrawingWorkerRequest(value: unknown): value is DrawingWorkerRequest {
  if (!isRecord(value) || value.schemaVersion !== undefined) {
    return isDrawingWorkerCancelRequest(value);
  }
  const header = value.header;
  if (value.type !== "drawing-worker/render"
    || !isDrawingWorkerJobHeader(header)
    || !Array.isArray(value.patches)
    || !value.patches.every((patch) => isDrawingWorkerEntityPatch(
      patch,
      header.stamp.scopeKey,
      header.stamp.documentRevision,
    ))
    || !isDrawingWorkerViewportPayload(value.viewport)
    || value.viewport.widthCssPx !== header.stamp.widthCssPx
    || value.viewport.heightCssPx !== header.stamp.heightCssPx
    || value.viewport.dpr !== header.stamp.dpr
    || !validByteLimit(value.maxResultBytes)) return false;
  return drawingWorkerViewportByteLength(value.viewport) <= value.maxResultBytes;
}

export function isDrawingWorkerResponse(value: unknown): value is DrawingWorkerResponse {
  if (!isRecord(value) || !isDrawingWorkerJobHeader(value.header)) return false;
  if (value.type === "drawing-worker/cancelled") return true;
  if (value.type === "drawing-worker/error") {
    return (value.code === "invalid-request"
        || value.code === "processing-failed"
        || value.code === "result-too-large")
      && typeof value.message === "string";
  }
  return value.type === "drawing-worker/result" && isDrawingWorkerDrawResult(value.result);
}

export function drawingWorkerRequestTransferables(
  request: DrawingWorkerRenderRequest,
): Transferable[] {
  const transferables: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const patch of request.patches) {
    if (patch.op !== "upsert") continue;
    pushArrayBuffer(transferables, seen, patch.canonicalPoints);
    pushArrayBuffer(transferables, seen, patch.pathBreaks);
  }
  pushViewportTransferables(transferables, seen, request.viewport);
  return transferables;
}

export function drawingWorkerResponseTransferables(
  response: DrawingWorkerResponse,
): Transferable[] {
  if (response.type !== "drawing-worker/result") return [];
  if (response.result.kind === "bitmap-draw-result") return [response.result.bitmap];
  const transferables: Transferable[] = [];
  pushViewportTransferables(transferables, new Set<ArrayBuffer>(), response.result);
  return transferables;
}

/**
 * Explicitly releases stale/overwritten transferable ownership. Array buffers
 * are detached when structuredClone transfer is available; bitmaps are closed.
 */
export function releaseDrawingWorkerDrawResult(result: DrawingWorkerDrawResult): void {
  if (result.kind === "bitmap-draw-result") {
    try { result.bitmap.close(); } catch { /* resource is already unusable */ }
    return;
  }
  releaseViewportTransferables(result);
}

export function releaseDrawingWorkerViewportPayload(payload: DrawingWorkerViewportPayload): void {
  releaseViewportTransferables(payload);
}

export function releaseDrawingWorkerEntityPatches(
  patches: readonly DrawingWorkerEntityPatch[],
): void {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const patch of patches) {
    if (patch.op !== "upsert") continue;
    collectArrayBuffer(buffers, seen, patch.canonicalPoints);
    collectArrayBuffer(buffers, seen, patch.pathBreaks);
  }
  detachArrayBuffers(buffers);
}

function isDrawingWorkerCancelRequest(value: unknown): value is DrawingWorkerCancelRequest {
  return isRecord(value)
    && value.type === "drawing-worker/cancel"
    && value.schemaVersion === DRAWING_WORKER_SCHEMA_VERSION
    && validSequence(value.throughGeneration);
}

export function isDrawingWorkerJobHeader(value: unknown): value is DrawingWorkerJobHeader {
  return isRecord(value)
    && value.schemaVersion === DRAWING_WORKER_SCHEMA_VERSION
    && validSequence(value.jobId)
    && validSequence(value.generation)
    && isDrawingRenderStamp(value.stamp);
}

function isDrawingRenderStamp(value: unknown): value is DrawingRenderRevisionStamp {
  if (!isRecord(value) || typeof value.scopeKey !== "string" || value.scopeKey.length === 0) {
    return false;
  }
  return validRevision(value.documentRevision)
    && validRevision(value.surfaceGeneration)
    && validRevision(value.dataRevision)
    && validRevision(value.projectionRevision)
    && validRevision(value.lineageIndexRevision)
    && validRevision(value.viewportRevision)
    && validRevision(value.themeRevision)
    && validPositiveNumber(value.widthCssPx)
    && validPositiveNumber(value.heightCssPx)
    && validPositiveNumber(value.dpr);
}

function isDrawingWorkerEntityPatch(
  value: unknown,
  scopeKey: string,
  documentRevision: number,
): value is DrawingWorkerEntityPatch {
  if (!isRecord(value)
    || value.scopeKey !== scopeKey
    || typeof value.entityId !== "string"
    || value.entityId.length === 0
    || !validRevision(value.documentRevision)
    || value.documentRevision > documentRevision) return false;
  if (value.op === "delete") return true;
  return value.op === "upsert"
    && isDrawingKind(value.kind)
    && validRevision(value.geometryRevision)
    && validRevision(value.styleRevision)
    && value.canonicalPoints instanceof Float64Array
    && value.canonicalPoints.buffer instanceof ArrayBuffer
    && validPairBuffer(value.canonicalPoints)
    && value.pathBreaks instanceof Uint32Array
    && value.pathBreaks.buffer instanceof ArrayBuffer
    && validPathBreaks(value.pathBreaks, value.canonicalPoints.length / 2);
}

function isDrawingWorkerViewportPayload(value: unknown): value is DrawingWorkerViewportPayload {
  if (!isRecord(value)
    || !validPositiveNumber(value.widthCssPx)
    || !validPositiveNumber(value.heightCssPx)
    || !validPositiveNumber(value.dpr)
    || !Array.isArray(value.entityIds)
    || !value.entityIds.every((id) => typeof id === "string" && id.length > 0)
    || !(value.kindCodes instanceof Uint8Array)
    || !(value.pointOffsets instanceof Uint32Array)
    || !(value.pointCounts instanceof Uint32Array)
    || !(value.points instanceof Float64Array)
    || !(value.bboxes instanceof Float64Array)
    || !(value.pathBreakOffsets instanceof Uint32Array)
    || !(value.pathBreakCounts instanceof Uint32Array)
    || !(value.pathBreaks instanceof Uint32Array)
    || !Array.isArray(value.paintSpecs)
    || !value.kindCodes.buffer || !(value.kindCodes.buffer instanceof ArrayBuffer)
    || !(value.pointOffsets.buffer instanceof ArrayBuffer)
    || !(value.pointCounts.buffer instanceof ArrayBuffer)
    || !(value.points.buffer instanceof ArrayBuffer)
    || !(value.bboxes.buffer instanceof ArrayBuffer)
    || !(value.pathBreakOffsets.buffer instanceof ArrayBuffer)
    || !(value.pathBreakCounts.buffer instanceof ArrayBuffer)
    || !(value.pathBreaks.buffer instanceof ArrayBuffer)
    || !validPairBuffer(value.points)) return false;
  const count = value.entityIds.length;
  if (value.kindCodes.length !== count
    || value.pointOffsets.length !== count
    || value.pointCounts.length !== count
    || value.bboxes.length !== count * 4
    || value.pathBreakOffsets.length !== count
    || value.pathBreakCounts.length !== count) return false;
  const paintedEntityIndexes = new Set<number>();
  for (const paintSpec of value.paintSpecs) {
    if (!isDrawingWorkerFreehandPaintSpec(paintSpec, count)
      || paintedEntityIndexes.has(paintSpec.entityIndex)) return false;
    const kindCode = value.kindCodes[paintSpec.entityIndex];
    if (kindCode !== 8 && kindCode !== 9) return false;
    paintedEntityIndexes.add(paintSpec.entityIndex);
  }
  const pointCount = value.points.length / 2;
  for (let index = 0; index < count; index += 1) {
    const pointOffset = Number(value.pointOffsets[index]);
    const entityPointCount = Number(value.pointCounts[index]);
    const breakOffset = Number(value.pathBreakOffsets[index]);
    const breakCount = Number(value.pathBreakCounts[index]);
    if (pointOffset + entityPointCount > pointCount
      || breakOffset + breakCount > value.pathBreaks.length) return false;
    let previousBreak = pointOffset - 1;
    for (let pathIndex = 0; pathIndex < breakCount; pathIndex += 1) {
      const pathBreak = Number(value.pathBreaks[breakOffset + pathIndex]);
      if (pathBreak < pointOffset
        || pathBreak >= pointOffset + entityPointCount
        || pathBreak <= previousBreak) return false;
      previousBreak = pathBreak;
    }
  }
  return true;
}

function isDrawingWorkerDrawResult(value: unknown): value is DrawingWorkerDrawResult {
  if (!isRecord(value)
    || !validRevision(value.rawPointCount)
    || !validRevision(value.renderedPointCount)
    || !validRevision(value.canonicalEntityCount)) return false;
  if (value.kind === "bitmap-draw-result") {
    return isImageBitmap(value.bitmap)
      && validPositiveNumber(value.widthCssPx)
      && validPositiveNumber(value.heightCssPx)
      && validPositiveNumber(value.dpr)
      && validPositiveInteger(value.atlasWidthPhysicalPx)
      && validPositiveInteger(value.atlasHeightPhysicalPx)
      && validRevision(value.byteLength)
      && value.byteLength === rgbaByteLength(
        Number(value.atlasWidthPhysicalPx),
        Number(value.atlasHeightPhysicalPx),
      )
      && Array.isArray(value.layers)
      && validBitmapLayers(
        value.layers,
        Number(value.atlasWidthPhysicalPx),
        Number(value.atlasHeightPhysicalPx),
      )
      && validImageBitmapDimensions(
        value.bitmap,
        Number(value.atlasWidthPhysicalPx),
        Number(value.atlasHeightPhysicalPx),
      );
  }
  return value.kind === "typed-draw-result"
    && isDrawingWorkerViewportPayload(value)
    && validRevision(value.byteLength)
    && value.byteLength === drawingWorkerViewportByteLength(value)
    && value.renderedPointCount === value.points.length / 2;
}

function isDrawingWorkerFreehandPaintSpec(
  value: unknown,
  entityCount: number,
): value is DrawingWorkerFreehandPaintSpec {
  return isRecord(value)
    && Number.isSafeInteger(value.entityIndex)
    && Number(value.entityIndex) >= 0
    && Number(value.entityIndex) < entityCount
    && validBoundedString(value.strokeColor, 256)
    && validBoundedString(value.selectionHighlightColor, 256)
    && validPositiveNumber(value.lineWidthCssPx)
    && typeof value.opacity === "number"
    && Number.isFinite(value.opacity)
    && value.opacity >= 0
    && value.opacity <= 1
    && isDrawingWorkerRasterCompositeOperation(value.compositeOperation)
    && (value.brushShape === "round" || value.brushShape === "square")
    && (value.pathInterpolation === "linear" || value.pathInterpolation === "quadratic")
    && typeof value.selected === "boolean";
}

function isImageBitmap(value: unknown): value is ImageBitmap {
  if (!isRecord(value) || typeof value.close !== "function") return false;
  return typeof ImageBitmap === "undefined" || value instanceof ImageBitmap;
}

function validImageBitmapDimensions(
  value: ImageBitmap,
  width: number,
  height: number,
): boolean {
  const candidate = value as ImageBitmap & { readonly width?: unknown; readonly height?: unknown };
  return (candidate.width === undefined || candidate.width === width)
    && (candidate.height === undefined || candidate.height === height);
}

function validBitmapLayers(
  value: readonly unknown[],
  atlasWidth: number,
  atlasHeight: number,
): value is readonly DrawingWorkerBitmapLayer[] {
  let previousLastEntityIndex = -1;
  for (const layer of value) {
    if (!isRecord(layer)
      || !validRevision(layer.entityIndex)
      || !validRevision(layer.lastEntityIndex)
      || Number(layer.entityIndex) <= previousLastEntityIndex
      || Number(layer.lastEntityIndex) < Number(layer.entityIndex)
      || !validNonNegativeInteger(layer.sourceXPhysicalPx)
      || !validNonNegativeInteger(layer.sourceYPhysicalPx)
      || !validPositiveInteger(layer.sourceWidthPhysicalPx)
      || !validPositiveInteger(layer.sourceHeightPhysicalPx)
      || Number(layer.sourceXPhysicalPx) + Number(layer.sourceWidthPhysicalPx) > atlasWidth
      || Number(layer.sourceYPhysicalPx) + Number(layer.sourceHeightPhysicalPx) > atlasHeight
      || !validNonNegativeNumber(layer.destinationXCssPx)
      || !validNonNegativeNumber(layer.destinationYCssPx)
      || !validPositiveNumber(layer.destinationWidthCssPx)
      || !validPositiveNumber(layer.destinationHeightCssPx)
      || typeof layer.opacity !== "number"
      || !Number.isFinite(layer.opacity)
      || layer.opacity < 0
      || layer.opacity > 1
      || !isDrawingWorkerRasterCompositeOperation(layer.compositeOperation)) return false;
    previousLastEntityIndex = Number(layer.lastEntityIndex);
  }
  return value.length > 0;
}

function validBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isDrawingKind(value: unknown): value is DrawingKind {
  return value === "line"
    || value === "axis-line"
    || value === "angle-measure"
    || value === "text"
    || value === "fibonacci"
    || value === "position"
    || value === "shape"
    || value === "freehand"
    || value === "highlighter";
}

function validPairBuffer(buffer: Float64Array): boolean {
  if (buffer.length % 2 !== 0) return false;
  for (let index = 0; index < buffer.length; index += 2) {
    const x = buffer[index];
    const y = buffer[index + 1];
    if ((Number.isFinite(x) && Number.isFinite(y))
      || (Number.isNaN(x) && Number.isNaN(y))) continue;
    return false;
  }
  return true;
}

function validPathBreaks(breaks: Uint32Array, pointCount: number): boolean {
  let previous = -1;
  for (const pathBreak of breaks) {
    if (pathBreak >= pointCount || pathBreak <= previous) return false;
    previous = pathBreak;
  }
  return true;
}

function validByteLimit(value: unknown): value is number {
  return validSequence(value) && value <= HARD_DRAWING_WORKER_MAX_RESULT_BYTES;
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function rgbaByteLength(widthPhysicalPx: number, heightPhysicalPx: number): number {
  const byteLength = widthPhysicalPx * heightPhysicalPx * 4;
  return Number.isSafeInteger(byteLength) ? byteLength : Number.POSITIVE_INFINITY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pushViewportTransferables(
  target: Transferable[],
  seen: Set<ArrayBuffer>,
  payload: DrawingWorkerViewportPayload,
): void {
  pushArrayBuffer(target, seen, payload.kindCodes);
  pushArrayBuffer(target, seen, payload.pointOffsets);
  pushArrayBuffer(target, seen, payload.pointCounts);
  pushArrayBuffer(target, seen, payload.points);
  pushArrayBuffer(target, seen, payload.bboxes);
  pushArrayBuffer(target, seen, payload.pathBreakOffsets);
  pushArrayBuffer(target, seen, payload.pathBreakCounts);
  pushArrayBuffer(target, seen, payload.pathBreaks);
}

function pushArrayBuffer(
  target: Transferable[],
  seen: Set<ArrayBuffer>,
  view: ArrayBufferView<ArrayBufferLike>,
): void {
  const buffer = view.buffer;
  if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) return;
  seen.add(buffer);
  target.push(buffer);
}

function collectArrayBuffer(
  target: ArrayBuffer[],
  seen: Set<ArrayBuffer>,
  view: ArrayBufferView<ArrayBufferLike>,
): void {
  const buffer = view.buffer;
  if (!(buffer instanceof ArrayBuffer) || seen.has(buffer) || buffer.byteLength === 0) return;
  seen.add(buffer);
  target.push(buffer);
}

function releaseViewportTransferables(payload: DrawingWorkerViewportPayload): void {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  collectArrayBuffer(buffers, seen, payload.kindCodes);
  collectArrayBuffer(buffers, seen, payload.pointOffsets);
  collectArrayBuffer(buffers, seen, payload.pointCounts);
  collectArrayBuffer(buffers, seen, payload.points);
  collectArrayBuffer(buffers, seen, payload.bboxes);
  collectArrayBuffer(buffers, seen, payload.pathBreakOffsets);
  collectArrayBuffer(buffers, seen, payload.pathBreakCounts);
  collectArrayBuffer(buffers, seen, payload.pathBreaks);
  detachArrayBuffers(buffers);
}

function detachArrayBuffers(buffers: readonly ArrayBuffer[]): void {
  if (buffers.length === 0 || typeof structuredClone !== "function") return;
  try {
    structuredClone(null, { transfer: [...buffers] });
  } catch {
    // Detachment is a best-effort resource release; ownership still drops here.
  }
}
