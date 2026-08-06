import type { DrawingFrameSnapshot } from "../../../chart-adapter/drawingFrameSnapshot.js";
import drawingPerformanceContract from "../../../../contracts/drawing-performance.json";
import type {
  CoordinateDataPoint,
  DrawingCoordinateResolution,
  SourceLineageSpanInput,
} from "../../../chart-adapter/coordinateBridge.js";
import type { DrawingDocument } from "../core/drawingDocument.js";
import type { DrawingDocumentStore } from "../core/drawingDocumentStore.js";
import { createDrawingHitIndex } from "../geometry/drawingHitIndex.js";
import type { DrawingHitIndex } from "../geometry/drawingHitIndex.js";
import type { LegacyPrimitiveRenderer } from "../legacy/legacyPrimitiveRenderer.js";
import {
  withDrawingFreehandRaster,
} from "../rendering/drawingDisplayList.js";
import type { DrawingScreenDisplayList } from "../rendering/drawingDisplayList.js";
import type { DrawingScenePaintAck } from "../rendering/DrawingScenePrimitive.js";
import {
  createDrawingRenderScheduler,
  drawingRenderRevisionKey,
} from "./drawingRenderScheduler.js";
import type {
  DrawingPreparedRenderPlan,
  DrawingRenderInput,
  DrawingRenderRevisionStamp,
  DrawingRenderScheduler,
} from "./drawingRenderScheduler.js";
import { createDrawingSceneRegistry } from "./drawingSceneRegistry.js";
import type {
  DrawingSceneNode,
  DrawingSceneRegistry,
} from "./drawingSceneRegistry.js";
import type { DrawingShadowParityResult } from "./drawingShadowParity.js";
import type { DrawingLodToleranceClass } from "../geometry/drawingLod.js";
import type { DrawingRasterBackend } from "../drawingRasterBackend.js";
import {
  accumulateDrawingPerfFrameWork,
  drawingPerfCounters,
} from "../performance/drawingPerfCounters.js";
import {
  createDrawingWorkerClient,
} from "../worker/drawingWorkerClient.js";
import type {
  DrawingWorkerClient,
  DrawingWorkerClientSnapshot,
  DrawingWorkerTransport,
} from "../worker/drawingWorkerClient.js";
import {
  releaseDrawingWorkerEntityPatches,
  releaseDrawingWorkerDrawResult,
  releaseDrawingWorkerViewportPayload,
  isDrawingWorkerRasterCompositeOperation,
  sameDrawingWorkerStamp,
} from "../worker/drawingWorkerProtocol.js";
import type {
  DrawingWorkerEntityPatch,
  DrawingWorkerJobHeader,
  DrawingWorkerTypedDrawResult,
  DrawingWorkerViewportPayload,
} from "../worker/drawingWorkerProtocol.js";
import type {
  DrawingSceneTextMeasurement,
  DrawingSceneTextMeasureRequest,
} from "./drawingSceneProjector.js";
import {
  clearDrawingSceneProjectorCaches,
  warmDrawingSceneWorldResolutions,
} from "./drawingSceneProjector.js";

export interface DrawingSceneFrameAdapter {
  captureDrawingFrame(): DrawingFrameSnapshot | null;
  isDrawingFrameCurrent(frame: DrawingFrameSnapshot): boolean;
  /**
   * Run one synchronous scene build against a task-scoped atomic projection
   * context. Implementations must fresh-check the frame before and after
   * `work`; public projection calls outside this scope retain their own
   * fail-closed checks.
   */
  runDrawingFrameProjectionSession?<T>(
    frame: DrawingFrameSnapshot,
    work: () => T | null,
  ): T | null;
  projectDrawingFrameDataPoints(
    frame: DrawingFrameSnapshot,
    dataPoints: readonly CoordinateDataPoint[],
  ): Float64Array | null;
  resolveDrawingFrameDataPoints?(
    frame: DrawingFrameSnapshot,
    dataPoints: readonly CoordinateDataPoint[],
  ): readonly (DrawingCoordinateResolution | null)[] | null;
  projectDrawingFrameResolvedDataPoints?(
    frame: DrawingFrameSnapshot,
    resolutions: readonly (DrawingCoordinateResolution | null)[],
    dataPoints: readonly CoordinateDataPoint[],
  ): Float64Array | null;
  projectDrawingFrameSourceLineageSpan(
    frame: DrawingFrameSnapshot,
    span: SourceLineageSpanInput,
  ): Readonly<{ left: number; right: number }> | null;
  readDrawingFrameSourceLineageStats?(): Readonly<{
    exactProjectionCount: number;
    fallbackProjectionCount: number;
    unresolvedProjectionCount: number;
  }>;
  measureText?(
    request: DrawingSceneTextMeasureRequest,
  ): DrawingSceneTextMeasurement | null;
  subscribeDrawingFrameInvalidation(
    listener: (reason?: "manual" | "viewport") => void,
  ): () => void;
}

export interface DrawingSceneProjectionRequest {
  readonly adapter: DrawingSceneFrameAdapter;
  readonly document: DrawingDocument;
  readonly frame: DrawingFrameSnapshot;
  readonly nodes: readonly DrawingSceneNode[];
  readonly selectedId: string | null;
  readonly stamp: DrawingRenderRevisionStamp;
  readonly lodToleranceClass: DrawingLodToleranceClass;
}

export type DrawingSceneProjector = (
  request: DrawingSceneProjectionRequest,
) => DrawingScreenDisplayList | null;

export interface DrawingSceneRuntimeBinding {
  readonly adapter: DrawingSceneFrameAdapter;
  readonly renderer: LegacyPrimitiveRenderer;
  readonly store: DrawingDocumentStore;
  /**
   * Document-only scene registries have no controller-owned primitive adoption
   * step on another linked chart. Let those surfaces synchronously accept an
   * externally published canonical document before the scene rebuild runs.
   * Legacy/shadow bindings omit this callback and retain their existing
   * store-publication-before-adoption guard.
   */
  readonly synchronizePublishedDocument?: (document: DrawingDocument) => boolean;
  readonly projectScene: DrawingSceneProjector;
  readonly isVisible?: () => boolean;
  readonly selectedId?: () => string | null;
  /** Visible canary filter. Shadow mode omits it and projects the full document. */
  readonly shouldProjectNode?: (node: DrawingSceneNode) => boolean;
  /** Visible scene publication is accepted only by the current surface generation. */
  readonly publishScene?: (plan: DrawingScreenDisplayList) => boolean;
  /** Paint acknowledgement from the generation-safe composite primitive bridge. */
  readonly subscribeScenePainted?: (
    listener: (stamp: DrawingRenderRevisionStamp) => void,
  ) => () => void;
  /**
   * Full paint evidence for exact barriers. A stamp-only acknowledgement is
   * intentionally insufficient because it cannot prove plan identity or a
   * paint newer than the request.
   */
  readonly subscribeSceneExactPainted?: (
    listener: (ack: DrawingScenePaintAck) => void,
  ) => () => void;
  readonly clearScene?: () => void;
  readonly compareParity?: (
    plan: DrawingScreenDisplayList,
    document: DrawingDocument,
    sceneCanonicalIds: readonly string[],
    frame: DrawingFrameSnapshot,
  ) => DrawingShadowParityResult | null;
}

export interface DrawingSceneRuntimeMetrics {
  readonly buildDurationMs: number;
  readonly culledEntityCount: number;
  readonly totalEntityCount: number;
  readonly visibleEntityCount: number;
}

export interface DrawingSceneRuntimeOptions {
  readonly mode: "legacy" | "shadow" | "scene-canary";
  readonly compareIntervalMs?: number;
  /** Retry unavailable legacy layout samples without opening a full parity blind window. */
  readonly compareRetryIntervalMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly onMetrics?: (metrics: DrawingSceneRuntimeMetrics) => void;
  readonly onParity?: (result: DrawingShadowParityResult) => void;
  readonly onParityDuration?: (durationMs: number) => void;
  readonly onSkipped?: (reason: string) => void;
  readonly requestFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly requestParityWork?: (callback: () => void) => unknown;
  readonly cancelParityWork?: (handle: unknown) => void;
  readonly scheduleDelay?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelDelay?: (handle: unknown) => void;
  /** Mount-locked Phase 6 rollback switch; it never changes scene ownership. */
  readonly rasterBackend?: DrawingRasterBackend;
  /** Test/host transport seam; production omits it and uses the module worker. */
  readonly workerTransportFactory?: () => DrawingWorkerTransport;
  /** Mount-locked benchmark seam; keeps a worker result in flight before delivery. */
  readonly workerResultDeliveryDelayMs?: number;
}

export interface DrawingSceneRuntimeSnapshot {
  readonly active: boolean;
  readonly disposed: boolean;
  readonly mode: "legacy" | "shadow" | "scene-canary";
  readonly plan: DrawingScreenDisplayList | null;
  /** Spatial index built transactionally from the exact published plan. */
  readonly hitIndex: DrawingHitIndex | null;
  /** True only after the current activation/recovery accepted a publication. */
  readonly publicationReady: boolean;
  readonly scopeKey: string | null;
  readonly lodToleranceClass: DrawingLodToleranceClass;
  readonly lastExactSettleMs: number | null;
  readonly rasterBackend: DrawingRasterBackend;
  readonly offscreenSupported: boolean;
  readonly worker: DrawingWorkerClientSnapshot | null;
  readonly lastWorkerRequestedStamp: DrawingRenderRevisionStamp | null;
  readonly lastWorkerPublishedStamp: DrawingRenderRevisionStamp | null;
  /** Bounded, ordered identities returned by successful worker submissions. */
  readonly submittedWorkerHeaders: readonly DrawingWorkerJobHeader[];
  /** Most recent worker result rejected as stale before runtime acceptance. */
  readonly returnedWorkerIdentity: DrawingWorkerJobHeader | null;
  /** Most recent worker result that passed the runtime freshness boundary. */
  readonly acceptedWorkerIdentity: DrawingWorkerJobHeader | null;
  /** Most recent accepted worker result whose scene publication succeeded. */
  readonly publishedWorkerIdentity: DrawingWorkerJobHeader | null;
  /** Worker publication identity acknowledged by the exact visible paint callback. */
  readonly paintedWorkerIdentity: DrawingWorkerJobHeader | null;
  /** Exact identity returned by the most recent successful worker submission. */
  readonly latestSubmittedWorkerIdentity: DrawingWorkerJobHeader | null;
  /** Exact stamp acknowledged by the generation-safe visible paint callback. */
  readonly lastPaintedStamp: DrawingRenderRevisionStamp | null;
  readonly paintReceipt: DrawingSceneRuntimePaintReceipt | null;
  readonly staleWorkerPublishCount: number;
  readonly workerResultDeliveryDelayMs: number;
  readonly rawPointCount: number;
  readonly renderedPointCount: number;
}

export interface DrawingSceneRuntimePaintReceipt {
  readonly kind: "drawing-scene-bridge-paint-ack";
  readonly observedAt: string;
  readonly stamp: DrawingRenderRevisionStamp;
  readonly attachmentRevision: number;
  readonly paintSequence: number;
}

export type DrawingSceneExactPaintErrorCode =
  | "aborted"
  | "document-invalidated"
  | "runtime-unavailable"
  | "scope-invalidated"
  | "timeout";

export class DrawingSceneExactPaintError extends Error {
  readonly code: DrawingSceneExactPaintErrorCode;

  constructor(code: DrawingSceneExactPaintErrorCode, message: string) {
    super(message);
    this.name = "DrawingSceneExactPaintError";
    this.code = code;
  }
}

export interface DrawingSceneExactPaintRequest {
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DrawingSceneExactPaintReceipt {
  readonly plan: DrawingScreenDisplayList;
  readonly stamp: DrawingRenderRevisionStamp;
  readonly sceneEpoch: number;
  readonly lodToleranceClass: "settledExact";
  readonly attachmentRevision: number;
  readonly paintSequence: number;
}

export interface DrawingSceneRuntime {
  activate(binding: DrawingSceneRuntimeBinding): boolean;
  invalidate(reason?: string): boolean;
  /** Replace a stale scene plan inside the chart's current pre-paint phase. */
  synchronizeChartFrame(): boolean;
  /**
   * Publish the current, fully validated surface synchronously when a user
   * gesture is waiting on scene admission. Unlike a normal first publication,
   * this may use the main-thread display list before the worker enhancement.
   */
  flushMutationAdmission?(): boolean;
  requestParity(): boolean;
  waitForExactPaint(
    request: DrawingSceneExactPaintRequest,
  ): Promise<DrawingSceneExactPaintReceipt>;
  flushNow(): boolean;
  suspend(): void;
  snapshot(): DrawingSceneRuntimeSnapshot;
  dispose(): void;
}

interface SceneRenderInput extends DrawingRenderInput {
  readonly adapter: DrawingSceneFrameAdapter;
  readonly binding: DrawingSceneRuntimeBinding;
  readonly document: DrawingDocument;
  readonly frame: DrawingFrameSnapshot;
  readonly lodToleranceClass: DrawingLodToleranceClass;
  /** Covers non-stamp inputs such as selection and dynamic-overlay ownership. */
  readonly sceneEpoch: number;
}

interface SceneRenderPlan extends DrawingPreparedRenderPlan {
  readonly binding: DrawingSceneRuntimeBinding;
  readonly buildDurationMs: number;
  readonly document: DrawingDocument;
  readonly frame: DrawingFrameSnapshot;
  readonly list: DrawingScreenDisplayList;
  readonly hitIndex: DrawingHitIndex;
  readonly lodToleranceClass: DrawingLodToleranceClass;
  readonly sceneCanonicalIds: readonly string[];
  readonly sceneNodes: readonly DrawingSceneNode[];
  readonly sceneEpoch: number;
  readonly totalEntityCount: number;
  readonly visibleEntityCount: number;
}

interface ExactPaintEvidence {
  readonly attachmentRevision: number;
  readonly paintSequence: number;
  readonly observedAt: string;
  readonly stamp: DrawingRenderRevisionStamp;
  readonly workerIdentity: DrawingWorkerJobHeader | null;
}

interface ScenePublicationWorkerBinding {
  readonly workerIdentity: DrawingWorkerJobHeader | null;
}

interface ExactPaintWaiter {
  readonly binding: DrawingSceneRuntimeBinding;
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly minimumSceneEpoch: number;
  readonly previousPlan: DrawingScreenDisplayList | null;
  readonly baseline: ExactPaintEvidence | null;
  readonly signal: AbortSignal | null;
  readonly abortListener: (() => void) | null;
  readonly resolve: (receipt: DrawingSceneExactPaintReceipt) => void;
  readonly reject: (error: DrawingSceneExactPaintError) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

function frameStamp(
  document: DrawingDocument,
  frame: DrawingFrameSnapshot,
): DrawingRenderRevisionStamp {
  return Object.freeze({
    scopeKey: document.scopeKey,
    documentRevision: document.documentRevision,
    surfaceGeneration: frame.surfaceGeneration,
    dataRevision: frame.dataRevision,
    projectionRevision: frame.projectionRevision,
    lineageIndexRevision: frame.lineageIndexRevision,
    viewportRevision: frame.viewportRevision,
    themeRevision: frame.themeRevision,
    widthCssPx: frame.widthCssPx,
    heightCssPx: frame.heightCssPx,
    dpr: frame.dpr,
  });
}

function finiteInterval(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 5_000;
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

const MAX_PHASE6_WORKER_IDENTITY_HISTORY = 32;

// Every viewport invalidation restarts this timer, so continuous wheel/pan
// input stays on the same-frame main-thread LOD path. Roughly two to three
// 60 Hz frames of quiet time reserve 80 ms of the 120 ms exact-paint budget for
// projection, the worker round-trip, scheduler jitter, and the next paint.
const EXACT_VIEWPORT_SETTLE_DELAY_MS = drawingPerformanceContract.exactViewportSettleDelayMs;

function snapshotWorkerIdentity(header: DrawingWorkerJobHeader): DrawingWorkerJobHeader {
  return Object.freeze({
    schemaVersion: header.schemaVersion,
    jobId: header.jobId,
    generation: header.generation,
    stamp: Object.freeze({ ...header.stamp }),
  });
}

function defaultScheduleDelay(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultCancelDelay(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

interface DefaultPostPaintTaskHandle {
  cancelled: boolean;
  frameHandle: number | null;
  taskHandle: ReturnType<typeof setTimeout> | null;
}

/**
 * Coalesce invisible work at the next browser paint boundary, then execute it
 * in its own macrotask. The legacy renderer can publish a coherent painted
 * snapshot while scene/parity CPU stays out of that visible rAF Long Task.
 */
function requestPostPaintTask(
  callback: () => void,
  delayMs: number,
): DefaultPostPaintTaskHandle {
  const handle: DefaultPostPaintTaskHandle = {
    cancelled: false,
    frameHandle: null,
    taskHandle: null,
  };
  const requestTask = (): void => {
    handle.frameHandle = null;
    if (handle.cancelled) return;
    handle.taskHandle = setTimeout(() => {
      handle.taskHandle = null;
      if (!handle.cancelled) callback();
    }, delayMs);
  };
  if (typeof requestAnimationFrame === "function") {
    handle.frameHandle = requestAnimationFrame(requestTask);
  } else {
    requestTask();
  }
  return handle;
}

/** Phase 3 is invisible; a 2 Hz debounce lets visible legacy paint settle first. */
function defaultRequestShadowSceneTask(callback: () => void): DefaultPostPaintTaskHandle {
  return requestPostPaintTask(callback, 500);
}

function defaultRequestParityTask(callback: () => void): DefaultPostPaintTaskHandle {
  return requestPostPaintTask(callback, 0);
}

function defaultCancelPostPaintTask(value: unknown): void {
  const handle = value as DefaultPostPaintTaskHandle;
  handle.cancelled = true;
  if (handle.frameHandle !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle.frameHandle);
  }
  if (handle.taskHandle !== null) clearTimeout(handle.taskHandle);
  handle.frameHandle = null;
  handle.taskHandle = null;
}

function defaultRequestVisibleSceneFrame(callback: () => void): unknown {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function defaultCancelVisibleSceneFrame(handle: unknown): void {
  if (typeof cancelAnimationFrame === "function" && typeof handle === "number") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function queryCandidates(
  registry: DrawingSceneRegistry,
  nodes: readonly DrawingSceneNode[],
  frame: DrawingFrameSnapshot,
): readonly DrawingSceneNode[] {
  const viewport = frame.drawingViewport;
  if (!viewport) return nodes;
  let edgePaddingPx = 64;
  for (const node of nodes) {
    const style = node.entity.style;
    if ("lineWidth" in style && typeof style.lineWidth === "number"
      && Number.isFinite(style.lineWidth)) {
      edgePaddingPx = Math.max(edgePaddingPx, style.lineWidth + 16);
    }
  }
  const horizontalSpan = viewport.maxHorizontal - viewport.minHorizontal;
  const priceSpan = viewport.maxPrice - viewport.minPrice;
  const priceSamples = viewport.priceProjectionSamples;
  let reliableAffinePrice = false;
  if (priceSamples && priceSamples.length >= 3) {
    const first = priceSamples[0];
    const last = priceSamples.at(-1);
    if (first && last && first.price !== last.price) {
      const slope = (last.coordinateCssPx - first.coordinateCssPx) / (last.price - first.price);
      reliableAffinePrice = Number.isFinite(slope) && priceSamples.every((sample) => (
        Math.abs(
          first.coordinateCssPx + (sample.price - first.price) * slope
            - sample.coordinateCssPx,
        ) <= 0.25
      ));
    }
  }
  // Every current drawing kind emits CSS-pixel paint beyond its canonical
  // data bounds (stroke width, caps/handles, text, or a position panel). When
  // price-to-screen is not certified affine, a fixed data-space padding can
  // exclude paint that still reaches the pane. Fail open here and let the
  // projector's exact screen-space bbox clip own visibility.
  if (!reliableAffinePrice) return nodes;
  const horizontalPadding = frame.widthCssPx > 0
    ? horizontalSpan * edgePaddingPx / frame.widthCssPx
    : 0;
  const pricePadding = frame.heightCssPx > 0
    ? priceSpan * edgePaddingPx / frame.heightCssPx
    : 0;
  const queried = registry.query({
    horizontalDomain: viewport.horizontalDomain,
    minHorizontal: viewport.minHorizontal - horizontalPadding,
    maxHorizontal: viewport.maxHorizontal + horizontalPadding,
    minPrice: viewport.minPrice - pricePadding,
    maxPrice: viewport.maxPrice + pricePadding,
  });
  const candidateIds = new Set(queried.map((node) => node.id));
  // Pixel-sized text and the offset position panel cannot be represented by
  // pure data-space bounds. Keep them as candidates, then let the projector's
  // exact screen bbox intersection decide visibility.
  const freehandDataCullUnsafe = viewport.horizontalDomain === "time";
  return Object.freeze(nodes.filter((node) => candidateIds.has(node.id)
    || (freehandDataCullUnsafe
      && (node.entity.kind === "freehand" || node.entity.kind === "highlighter"))
    || node.entity.kind === "angle-measure"
    || node.entity.kind === "fibonacci"
    || node.entity.kind === "text"
    || node.entity.kind === "position"));
}

function workerViewportPayload(list: DrawingScreenDisplayList): DrawingWorkerViewportPayload {
  return Object.freeze({
    widthCssPx: list.stamp.widthCssPx,
    heightCssPx: list.stamp.heightCssPx,
    dpr: list.stamp.dpr,
    entityIds: Object.freeze(list.entities.map((entity) => entity.id)),
    kindCodes: new Uint8Array(list.entityKindCodes),
    pointOffsets: new Uint32Array(list.pointOffsets),
    pointCounts: new Uint32Array(list.pointCounts),
    points: new Float64Array(list.points),
    bboxes: new Float64Array(list.bboxes),
    pathBreakOffsets: new Uint32Array(list.pathBreakOffsets),
    pathBreakCounts: new Uint32Array(list.pathBreakCounts),
    pathBreaks: new Uint32Array(list.pathBreaks),
    paintSpecs: Object.freeze(list.entities.flatMap((entity, entityIndex) => {
      const spec = entity.renderSpec;
      return spec?.op === "freehand"
        && isDrawingWorkerRasterCompositeOperation(spec.compositeOperation)
        ? [Object.freeze({
        entityIndex,
        strokeColor: spec.strokeColor,
        selectionHighlightColor: spec.selectionHighlightColor,
        lineWidthCssPx: spec.lineWidthCssPx,
        opacity: spec.opacity,
        compositeOperation: spec.compositeOperation,
        brushShape: spec.brushShape,
        pathInterpolation: spec.pathInterpolation ?? "quadratic",
        selected: spec.selected,
        })] : [];
    })),
  });
}

function workerPreparedDisplayList(
  list: DrawingScreenDisplayList,
  result: DrawingWorkerTypedDrawResult,
): DrawingScreenDisplayList | null {
  if (result.widthCssPx !== list.stamp.widthCssPx
    || result.heightCssPx !== list.stamp.heightCssPx
    || result.dpr !== list.stamp.dpr
    || result.entityIds.length !== list.entities.length
    || result.entityIds.some((id, index) => id !== list.entities[index]?.id)
    || result.kindCodes.length !== list.entityKindCodes.length
    || result.pointOffsets.length !== list.pointOffsets.length
    || result.pointCounts.length !== list.pointCounts.length
    || result.points.length !== list.points.length
    || result.bboxes.length !== list.bboxes.length
    || result.pathBreakOffsets.length !== list.pathBreakOffsets.length
    || result.pathBreakCounts.length !== list.pathBreakCounts.length
    || result.pathBreaks.length !== list.pathBreaks.length) return null;
  return Object.freeze({
    ...list,
    entityKindCodes: result.kindCodes,
    pointOffsets: result.pointOffsets,
    pointCounts: result.pointCounts,
    points: result.points,
    bboxes: result.bboxes,
    pathBreakOffsets: result.pathBreakOffsets,
    pathBreakCounts: result.pathBreakCounts,
    pathBreaks: result.pathBreaks,
  });
}

function freehandCanonicalPoints(node: DrawingSceneNode): Float64Array | null {
  const geometry = node.entity.geometry;
  if (geometry.kind !== "freehand" && geometry.kind !== "highlighter") return null;
  const stroke = geometry.stroke;
  if (stroke) {
    const coordinates = new Float64Array(stroke.points.length * 2);
    for (let index = 0; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      let horizontal = Number.NaN;
      const price = point?.price ?? Number.NaN;
      if (point && "time" in point) horizontal = point.time;
      else if (point && "anchor" in point) horizontal = point.anchor.time;
      else if (point && "span" in point) {
        const span = stroke.spans[point.span];
        if (span) {
          horizontal = span.exact.left.time
            + (span.exact.right.time - span.exact.left.time) * point.ratio;
        }
      }
      coordinates[index * 2] = Number.isFinite(horizontal) ? horizontal : Number.NaN;
      coordinates[index * 2 + 1] = Number.isFinite(price) ? price : Number.NaN;
      if (!Number.isFinite(coordinates[index * 2])
        || !Number.isFinite(coordinates[index * 2 + 1])) {
        coordinates[index * 2] = Number.NaN;
        coordinates[index * 2 + 1] = Number.NaN;
      }
    }
    return coordinates;
  }
  const rawPoints = geometry.dataPoints ?? [];
  const coordinates = new Float64Array(rawPoints.length * 2);
  for (let index = 0; index < rawPoints.length; index += 1) {
    const point = rawPoints[index];
    let horizontal = Number.NaN;
    const price = point?.price ?? Number.NaN;
    if (point) horizontal = typeof point.time === "number"
      ? point.time
      : typeof point.logical === "number" ? point.logical : Number.NaN;
    coordinates[index * 2] = Number.isFinite(horizontal) ? horizontal : Number.NaN;
    coordinates[index * 2 + 1] = Number.isFinite(price) ? price : Number.NaN;
    if (!Number.isFinite(coordinates[index * 2]) || !Number.isFinite(coordinates[index * 2 + 1])) {
      coordinates[index * 2] = Number.NaN;
      coordinates[index * 2 + 1] = Number.NaN;
    }
  }
  return coordinates;
}

interface WorkerPatchBatch {
  readonly patches: readonly DrawingWorkerEntityPatch[];
  readonly entities: ReadonlyMap<string, DrawingSceneNode["entity"]>;
}

function workerEntityPatches(
  document: DrawingDocument,
  nodes: readonly DrawingSceneNode[],
  previous: ReadonlyMap<string, DrawingSceneNode["entity"]>,
): WorkerPatchBatch {
  const next = new Map<string, DrawingSceneNode["entity"]>();
  const patches: DrawingWorkerEntityPatch[] = [];
  for (const node of nodes) {
    const geometry = node.entity.geometry;
    if (geometry.kind !== "freehand" && geometry.kind !== "highlighter") continue;
    // Canonical entity objects are immutable. Object identity detects
    // delete+recreate/restore even when local geometry/style revisions happen
    // to collide. Check it before materializing the canonical typed buffer:
    // viewport-only worker jobs must not rebuild and discard the entire raw
    // freehand scene on every frame.
    next.set(node.id, node.entity);
    if (previous.get(node.id) === node.entity) continue;
    const canonicalPoints = freehandCanonicalPoints(node);
    if (!canonicalPoints) {
      next.delete(node.id);
      continue;
    }
    patches.push(Object.freeze({
      op: "upsert" as const,
      scopeKey: document.scopeKey,
      documentRevision: document.documentRevision,
      entityId: node.id,
      kind: node.entity.kind,
      geometryRevision: node.geometryRevision,
      styleRevision: node.styleRevision,
      canonicalPoints,
      pathBreaks: new Uint32Array(),
    }));
  }
  for (const entityId of previous.keys()) {
    if (next.has(entityId)) continue;
    patches.push(Object.freeze({
      op: "delete" as const,
      scopeKey: document.scopeKey,
      documentRevision: document.documentRevision,
      entityId,
    }));
  }
  return Object.freeze({ patches: Object.freeze(patches), entities: next });
}

function freehandRawPointCount(nodes: readonly DrawingSceneNode[]): number {
  let count = 0;
  for (const node of nodes) {
    const geometry = node.entity.geometry;
    if (geometry.kind !== "freehand" && geometry.kind !== "highlighter") continue;
    count += geometry.stroke?.points.length ?? geometry.dataPoints?.length ?? 0;
  }
  return count;
}

function hasSourceLineageFreehand(nodes: readonly DrawingSceneNode[]): boolean {
  return nodes.some((node) => {
    const geometry = node.entity.geometry;
    return (geometry.kind === "freehand" || geometry.kind === "highlighter")
      && (geometry.stroke?.spans.length ?? 0) > 0;
  });
}

/**
 * Invisible Phase 3 scene owner. It observes the authoritative document and
 * adapter frame, but it never creates a canvas, attaches a chart primitive,
 * installs pointer listeners, or writes persistence.
 */
export function createDrawingSceneRuntime({
  mode,
  compareIntervalMs = 5_000,
  compareRetryIntervalMs = 250,
  now = defaultNow,
  onError,
  onMetrics,
  onParity,
  onParityDuration,
  onSkipped,
  requestFrame,
  cancelFrame,
  requestParityWork = defaultRequestParityTask,
  cancelParityWork = defaultCancelPostPaintTask,
  scheduleDelay = defaultScheduleDelay,
  cancelDelay = defaultCancelDelay,
  rasterBackend = "main-thread",
  workerTransportFactory,
  workerResultDeliveryDelayMs = 0,
}: DrawingSceneRuntimeOptions): DrawingSceneRuntime {
  const parityInterval = finiteInterval(compareIntervalMs);
  const parityRetryInterval = finiteInterval(compareRetryIntervalMs);
  const scheduleSceneFrame = requestFrame ?? (mode === "shadow"
    ? defaultRequestShadowSceneTask
    : defaultRequestVisibleSceneFrame);
  const cancelSceneFrame = cancelFrame ?? (mode === "shadow"
    ? defaultCancelPostPaintTask
    : defaultCancelVisibleSceneFrame);
  let binding: DrawingSceneRuntimeBinding | null = null;
  let registry: DrawingSceneRegistry | null = null;
  let unsubscribeDocument: (() => void) | null = null;
  let unsubscribeFrame: (() => void) | null = null;
  let unsubscribeScenePainted: (() => void) | null = null;
  let unsubscribeSceneExactPainted: (() => void) | null = null;
  let latestPlan: DrawingScreenDisplayList | null = null;
  let latestHitIndex: DrawingHitIndex | null = null;
  let latestPublishedPlan: SceneRenderPlan | null = null;
  let latestOwnedEntityCount: number | null = null;
  let lodToleranceClass: DrawingLodToleranceClass = "normalStatic";
  let exactDelayHandle: unknown = null;
  let exactRequestedAt: number | null = null;
  let pendingExactPaintStamp: DrawingRenderRevisionStamp | null = null;
  let lastExactSettleMs: number | null = null;
  let lastExactPaintEvidence: ExactPaintEvidence | null = null;
  const exactPaintWaiters = new Set<ExactPaintWaiter>();
  let effectiveRasterBackend: DrawingRasterBackend = rasterBackend;
  let workerClient: DrawingWorkerClient | null = null;
  /** Sticky for this runtime mount after capability/protocol/raster failure. */
  let workerRasterDisabled = false;
  let workerSnapshot: DrawingWorkerClientSnapshot | null = null;
  let workerScopeKey: string | null = null;
  let workerMirroredEntities: ReadonlyMap<string, DrawingSceneNode["entity"]> = new Map();
  const workerRequestedAt = new Map<number, number>();
  const workerPlans = new Map<number, SceneRenderPlan>();
  let lastWorkerRequestedStamp: DrawingRenderRevisionStamp | null = null;
  let lastWorkerPublishedStamp: DrawingRenderRevisionStamp | null = null;
  const submittedWorkerHeaders: DrawingWorkerJobHeader[] = [];
  let returnedWorkerIdentity: DrawingWorkerJobHeader | null = null;
  let acceptedWorkerIdentity: DrawingWorkerJobHeader | null = null;
  let publishedWorkerIdentity: DrawingWorkerJobHeader | null = null;
  let latestSubmittedWorkerIdentity: DrawingWorkerJobHeader | null = null;
  // A render stamp identifies chart state, not the producer of one concrete
  // visible publication. The same stamp can be published first by a worker
  // and then by the main-thread exact/continuous path (or vice versa). Bind
  // provenance to the actual immutable display-list object acknowledged by
  // the primitive so a later same-stamp paint can never inherit it globally.
  let workerBindingByPublishedPlan = new WeakMap<
    DrawingScreenDisplayList,
    ScenePublicationWorkerBinding
  >();
  let staleWorkerPublishCount = 0;
  let rawPointCount = 0;
  let renderedPointCount = 0;
  let sceneEpoch = 0;
  let observedCoordinateKey: string | null = null;
  let disposed = false;
  let faulted = false;
  let recoveryPublicationPending = false;
  let publishingFromChartUpdate = false;
  let lastParityAttemptAt = Number.NEGATIVE_INFINITY;
  let lastParitySuccessAt = Number.NEGATIVE_INFINITY;
  let parityDelayHandle: unknown = null;
  let parityWorkHandle: unknown = null;
  let pendingParityPlan: SceneRenderPlan | null = null;

  const sameWorkerIdentityKey = (
    left: DrawingWorkerJobHeader | null,
    right: DrawingWorkerJobHeader | null,
  ): boolean => !!left
    && !!right
    && left.schemaVersion === right.schemaVersion
    && left.jobId === right.jobId
    && left.generation === right.generation;

  const trimSubmittedWorkerIdentityHistory = (): void => {
    while (submittedWorkerHeaders.length > MAX_PHASE6_WORKER_IDENTITY_HISTORY) {
      const removableIndex = submittedWorkerHeaders.findIndex((identity, index) => (
        index < submittedWorkerHeaders.length - 1
          && !sameWorkerIdentityKey(identity, returnedWorkerIdentity)
      ));
      if (removableIndex < 0) break;
      submittedWorkerHeaders.splice(removableIndex, 1);
    }
  };

  const recordSubmittedWorkerIdentity = (header: DrawingWorkerJobHeader): void => {
    const identity = snapshotWorkerIdentity(header);
    submittedWorkerHeaders.push(identity);
    latestSubmittedWorkerIdentity = identity;
    trimSubmittedWorkerIdentityHistory();
  };

  const recordReturnedWorkerIdentity = (header: DrawingWorkerJobHeader): void => {
    const identity = snapshotWorkerIdentity(header);
    returnedWorkerIdentity = identity;
    if (!submittedWorkerHeaders.some((candidate) => (
      sameWorkerIdentityKey(candidate, identity)
    ))) {
      const insertionIndex = submittedWorkerHeaders.findIndex((candidate) => (
        candidate.jobId > identity.jobId
          || candidate.generation > identity.generation
      ));
      submittedWorkerHeaders.splice(
        insertionIndex < 0 ? submittedWorkerHeaders.length : insertionIndex,
        0,
        identity,
      );
    }
    trimSubmittedWorkerIdentityHistory();
  };

  const resetWorkerIdentityEvidence = (): void => {
    submittedWorkerHeaders.length = 0;
    returnedWorkerIdentity = null;
    acceptedWorkerIdentity = null;
    publishedWorkerIdentity = null;
    latestSubmittedWorkerIdentity = null;
    workerBindingByPublishedPlan = new WeakMap();
    if (lastExactPaintEvidence?.workerIdentity) {
      lastExactPaintEvidence = Object.freeze({
        ...lastExactPaintEvidence,
        workerIdentity: null,
      });
    }
  };

  const ensureWorkerClient = (): DrawingWorkerClient | null => {
    if (rasterBackend !== "worker" || workerRasterDisabled) {
      effectiveRasterBackend = "main-thread";
      return null;
    }
    if (workerClient) return workerClient;
    // Worker job ids restart with each client. Keep the bounded identity
    // sequence scoped to one real transport so a recovery cannot splice two
    // independently monotonic generations into misleading drill evidence.
    resetWorkerIdentityEvidence();
    effectiveRasterBackend = "worker";
    workerScopeKey = binding?.store.getSnapshot().scopeKey ?? null;
    workerClient = createDrawingWorkerClient({
      ...(workerTransportFactory ? { transportFactory: workerTransportFactory } : {}),
      resultDeliveryDelayMs: workerResultDeliveryDelayMs,
      onStateChange(snapshot) {
        workerSnapshot = snapshot;
        const retainedJobIds = new Set<number>();
        if (snapshot.inFlightHeader) retainedJobIds.add(snapshot.inFlightHeader.jobId);
        if (snapshot.pendingHeader) retainedJobIds.add(snapshot.pendingHeader.jobId);
        for (const jobId of workerRequestedAt.keys()) {
          if (!retainedJobIds.has(jobId)) workerRequestedAt.delete(jobId);
        }
        for (const jobId of workerPlans.keys()) {
          if (!retainedJobIds.has(jobId)) workerPlans.delete(jobId);
        }
        drawingPerfCounters.recordWorkerQueue(snapshot.queueDepth);
        drawingPerfCounters.setGauge("workerInFlight", snapshot.inFlight);
      },
      onQueueDrop(dropped) {
        workerRequestedAt.delete(dropped.jobId);
        workerPlans.delete(dropped.jobId);
        drawingPerfCounters.incrementCounter("workerQueueDropCount");
      },
      onStaleResult(response) {
        workerRequestedAt.delete(response.header.jobId);
        workerPlans.delete(response.header.jobId);
        recordReturnedWorkerIdentity(response.header);
        drawingPerfCounters.incrementCounter("staleWorkerResultCount");
      },
      onResult(response) {
        const finalizeCpuStartedAt = now();
        const requestedAt = workerRequestedAt.get(response.header.jobId);
        workerRequestedAt.delete(response.header.jobId);
        try {
          const preparedPlan = workerPlans.get(response.header.jobId) ?? null;
          workerPlans.delete(response.header.jobId);
          const requested = lastWorkerRequestedStamp;
          if (!preparedPlan
            || !requested
            || preparedPlan.binding !== binding
            || preparedPlan.sceneEpoch !== sceneEpoch
            || !sameDrawingWorkerStamp(response.header.stamp, requested)
            || !sameDrawingWorkerStamp(response.header.stamp, preparedPlan.stamp)) {
            recordReturnedWorkerIdentity(response.header);
            drawingPerfCounters.incrementCounter("staleWorkerResultCount");
            releaseDrawingWorkerDrawResult(response.result);
            return;
          }
          const acceptedIdentity = snapshotWorkerIdentity(response.header);
          drawingPerfCounters.incrementCounter("workerResultCount");
          if (response.result.kind !== "bitmap-draw-result") {
            const preparedList = workerPreparedDisplayList(preparedPlan.list, response.result);
            const needsFreehandRaster = response.result.paintSpecs.length > 0;
            if (!preparedList || needsFreehandRaster) {
              releaseDrawingWorkerDrawResult(response.result);
              disableWorkerRaster();
              publishPreparedPlan(preparedPlan, preparedPlan.list, preparedPlan.hitIndex, "worker");
              return;
            }
            const preparedHitIndex = Object.freeze({
              ...preparedPlan.hitIndex,
              list: preparedList,
            });
            if (publishPreparedPlan(
              preparedPlan,
              preparedList,
              preparedHitIndex,
              "worker",
              acceptedIdentity,
            )) {
              effectiveRasterBackend = "main-thread";
              lastWorkerPublishedStamp = Object.freeze({ ...response.header.stamp });
            } else {
              releaseDrawingWorkerDrawResult(response.result);
            }
            return;
          }
          try {
            const rasterList = withDrawingFreehandRaster(preparedPlan.list, {
              bitmap: response.result.bitmap,
              widthCssPx: response.result.widthCssPx,
              heightCssPx: response.result.heightCssPx,
              dpr: response.result.dpr,
              atlasWidthPhysicalPx: response.result.atlasWidthPhysicalPx,
              atlasHeightPhysicalPx: response.result.atlasHeightPhysicalPx,
              layers: response.result.layers,
            });
            const rasterHitIndex = Object.freeze({
              ...preparedPlan.hitIndex,
              list: rasterList,
            });
            if (!publishPreparedPlan(
              preparedPlan,
              rasterList,
              rasterHitIndex,
              "worker",
              acceptedIdentity,
            )) {
              releaseDrawingWorkerDrawResult(response.result);
              return;
            }
            effectiveRasterBackend = "worker";
            lastWorkerPublishedStamp = Object.freeze({ ...response.header.stamp });
          } catch {
            releaseDrawingWorkerDrawResult(response.result);
            disableWorkerRaster();
            publishPreparedPlan(preparedPlan, preparedPlan.list, preparedPlan.hitIndex, "worker");
          }
        } finally {
          const finalizedAt = now();
          if (requestedAt !== undefined) {
            drawingPerfCounters.recordDuration(
              "workerFinalizeMs",
              Math.max(0, finalizedAt - requestedAt),
            );
          }
          const finalizeCpuDurationMs = Math.max(0, finalizedAt - finalizeCpuStartedAt);
          accumulateDrawingPerfFrameWork({
            drawingMainThreadMs: finalizeCpuDurationMs,
            sceneProjectPaintMs: finalizeCpuDurationMs,
          });
        }
      },
      onJobError(response) {
        workerRequestedAt.delete(response.header.jobId);
        const preparedPlan = workerPlans.get(response.header.jobId) ?? null;
        workerPlans.delete(response.header.jobId);
        const isLatest = response.header.jobId
          === workerSnapshot?.latestSubmittedHeader?.jobId;
        if (preparedPlan && isLatest) {
          disableWorkerRaster();
          publishPreparedPlan(preparedPlan, preparedPlan.list, preparedPlan.hitIndex, "worker");
        }
      },
      onUnavailable() {
        workerRasterDisabled = true;
        effectiveRasterBackend = "main-thread";
        const fallback = [...workerPlans.entries()].sort(
          ([left], [right]) => left - right,
        ).at(-1)?.[1] ?? null;
        workerPlans.clear();
        workerRequestedAt.clear();
        if (fallback) {
          void Promise.resolve().then(() => {
            publishPreparedPlan(fallback, fallback.list, fallback.hitIndex, "worker");
          });
        }
      },
    });
    workerSnapshot = workerClient.snapshot();
    if (!workerClient.available) effectiveRasterBackend = "main-thread";
    return workerClient;
  };

  const disposeWorkerClient = (): void => {
    workerClient?.dispose();
    workerSnapshot = workerClient?.snapshot() ?? workerSnapshot;
    workerClient = null;
    workerScopeKey = null;
    workerMirroredEntities = new Map();
    lastWorkerRequestedStamp = null;
    lastWorkerPublishedStamp = null;
    workerRequestedAt.clear();
    workerPlans.clear();
    effectiveRasterBackend = workerRasterDisabled ? "main-thread" : rasterBackend;
    drawingPerfCounters.recordWorkerQueue(0);
    drawingPerfCounters.setGauge("workerInFlight", 0);
  };

  const disableWorkerRaster = (): void => {
    workerRasterDisabled = true;
    disposeWorkerClient();
    effectiveRasterBackend = "main-thread";
  };

  const submitWorkerPlan = (plan: SceneRenderPlan): boolean => {
    if (!plan.list.entities.some((entity) => entity.renderSpec?.op === "freehand"
      && isDrawingWorkerRasterCompositeOperation(entity.renderSpec.compositeOperation))) {
      return false;
    }
    const client = ensureWorkerClient();
    if (!client?.available) return false;
    const patchBatch = workerEntityPatches(
      plan.document,
      plan.sceneNodes,
      workerMirroredEntities,
    );
    const viewport = workerViewportPayload(plan.list);
    try {
      const header = client.submit({
        stamp: plan.stamp,
        patches: patchBatch.patches,
        viewport,
      });
      if (!header) {
        releaseDrawingWorkerViewportPayload(viewport);
        releaseDrawingWorkerEntityPatches(patchBatch.patches);
        disableWorkerRaster();
        return false;
      }
      if (!client.available) return false;
      recordSubmittedWorkerIdentity(header);
      workerMirroredEntities = patchBatch.entities;
      lastWorkerRequestedStamp = Object.freeze({ ...header.stamp });
      workerRequestedAt.set(header.jobId, now());
      workerPlans.set(header.jobId, plan);
      drawingPerfCounters.incrementCounter("workerJobCount");
      return true;
    } catch {
      releaseDrawingWorkerViewportPayload(viewport);
      releaseDrawingWorkerEntityPatches(patchBatch.patches);
      disableWorkerRaster();
      return false;
    }
  };

  const clearParityDelay = (): void => {
    if (parityDelayHandle === null) return;
    cancelDelay(parityDelayHandle);
    parityDelayHandle = null;
  };

  const clearExactDelay = (): void => {
    if (exactDelayHandle === null) return;
    cancelDelay(exactDelayHandle);
    exactDelayHandle = null;
  };

  const settleExactPaintWaiter = (waiter: ExactPaintWaiter): boolean => {
    if (waiter.settled) return false;
    waiter.settled = true;
    exactPaintWaiters.delete(waiter);
    if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
    waiter.timeoutHandle = null;
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    return true;
  };

  const rejectExactPaintWaiter = (
    waiter: ExactPaintWaiter,
    code: DrawingSceneExactPaintErrorCode,
    message: string,
  ): void => {
    if (!settleExactPaintWaiter(waiter)) return;
    waiter.reject(new DrawingSceneExactPaintError(code, message));
  };

  const rejectExactPaintWaiters = (
    code: DrawingSceneExactPaintErrorCode,
    message: string,
  ): void => {
    for (const waiter of Array.from(exactPaintWaiters)) {
      rejectExactPaintWaiter(waiter, code, message);
    }
  };

  const rejectInvalidatedExactPaintWaiters = (
    nextBinding: DrawingSceneRuntimeBinding,
  ): void => {
    const document = nextBinding.store.getSnapshot();
    for (const waiter of Array.from(exactPaintWaiters)) {
      if (waiter.binding !== nextBinding || waiter.scopeKey !== document.scopeKey) {
        rejectExactPaintWaiter(
          waiter,
          "scope-invalidated",
          "drawing scene exact paint scope was invalidated",
        );
      } else if (waiter.documentRevision !== document.documentRevision) {
        rejectExactPaintWaiter(
          waiter,
          "document-invalidated",
          "drawing scene exact paint document was invalidated",
        );
      }
    }
  };

  const nextSceneEpoch = (): number => (
    sceneEpoch >= Number.MAX_SAFE_INTEGER ? 1 : sceneEpoch + 1
  );

  const invalidateScene = (reason: string): boolean => {
    sceneEpoch = nextSceneEpoch();
    return scheduler.invalidate(reason);
  };

  const scheduleExactViewportRender = (): void => {
    clearExactDelay();
    exactDelayHandle = scheduleDelay(() => {
      exactDelayHandle = null;
      if (disposed || faulted || !binding) return;
      lodToleranceClass = "settledExact";
      invalidateScene("viewport-exact");
    }, EXACT_VIEWPORT_SETTLE_DELAY_MS);
  };

  const scheduleParityInvalidation = (delayMs: number): void => {
    clearParityDelay();
    if (disposed || !binding?.compareParity || delayMs <= 0) return;
    parityDelayHandle = scheduleDelay(() => {
      parityDelayHandle = null;
      if (!disposed && binding?.compareParity) {
        // A static immutable plan does not need rebuilding merely to repeat
        // parity. runParityWork still validates document/frame identity and
        // fails closed into a fresh scene build when this plan is stale.
        scheduleParityInvalidation(parityRetryInterval);
        if (latestPublishedPlan?.binding === binding) {
          scheduleParityWork(latestPublishedPlan);
        } else {
          invalidateScene("parity-interval");
        }
      }
    }, Math.max(1, delayMs));
  };

  const clearParityWork = (): void => {
    if (parityWorkHandle !== null) cancelParityWork(parityWorkHandle);
    parityWorkHandle = null;
    pendingParityPlan = null;
  };

  /**
   * A coordinate-key transition invalidates every screen-space artifact even
   * though the canonical document and surface binding remain valid. Retire the
   * public plan synchronously so neither paint nor hit testing can observe the
   * previous coordinate system while the replacement frame is still queued.
   */
  const invalidateChangedCoordinateSpace = (frame: DrawingFrameSnapshot): boolean => {
    const nextCoordinateKey = frame.coordinateKey;
    if (observedCoordinateKey === null) {
      observedCoordinateKey = nextCoordinateKey;
      return false;
    }
    if (observedCoordinateKey === nextCoordinateKey) return false;
    observedCoordinateKey = nextCoordinateKey;

    // Advance before calling the visible sink. Any already-delivered worker
    // callback or prepared plan is stale before old pixels are cleared.
    sceneEpoch = nextSceneEpoch();
    clearParityDelay();
    clearParityWork();
    if (binding) clearDrawingSceneProjectorCaches(binding.adapter);
    latestPlan = null;
    latestHitIndex = null;
    latestPublishedPlan = null;
    pendingExactPaintStamp = null;
    lastExactSettleMs = null;
    lastExactPaintEvidence = null;
    lastWorkerRequestedStamp = null;
    lastWorkerPublishedStamp = null;
    workerRequestedAt.clear();
    workerPlans.clear();
    rawPointCount = 0;
    renderedPointCount = 0;
    drawingPerfCounters.setGauge("rawPoints", 0);
    drawingPerfCounters.setGauge("renderedPoints", 0);
    drawingPerfCounters.setGauge("lodRatio", 0);
    if (mode === "scene-canary") binding?.clearScene?.();
    return true;
  };

  const runParityWork = (): void => {
    parityWorkHandle = null;
    const plan = pendingParityPlan;
    pendingParityPlan = null;
    if (disposed || !plan || plan.binding !== binding) return;
    const compare = plan.binding.compareParity;
    if (!compare) return;
    if (plan.binding.store.getSnapshot() !== plan.document
      || plan.binding.renderer.documentSnapshot() !== plan.document
      || !plan.binding.adapter.isDrawingFrameCurrent(plan.frame)) {
      if (latestPublishedPlan === plan) latestPublishedPlan = null;
      onSkipped?.("parity-input-stale");
      invalidateScene("parity-input-stale");
      scheduleParityInvalidation(parityRetryInterval);
      return;
    }
    const timestamp = now();
    if (timestamp - lastParitySuccessAt < parityInterval
      || timestamp - lastParityAttemptAt < parityRetryInterval) {
      const nextEligibleAt = Math.max(
        lastParitySuccessAt + parityInterval,
        lastParityAttemptAt + parityRetryInterval,
      );
      scheduleParityInvalidation(Math.max(0, nextEligibleAt - timestamp));
      return;
    }
    lastParityAttemptAt = timestamp;
    const parityStartedAt = now();
    try {
      const result = compare(plan.list, plan.document, plan.sceneCanonicalIds, plan.frame);
      if (result) {
        lastParitySuccessAt = timestamp;
        onParity?.(result);
        scheduleParityInvalidation(parityInterval);
      } else {
        onSkipped?.("legacy-parity-unavailable");
        scheduleParityInvalidation(parityRetryInterval);
      }
    } catch (error) {
      onError?.(error);
      scheduleParityInvalidation(parityRetryInterval);
    } finally {
      onParityDuration?.(Math.max(0, now() - parityStartedAt));
    }
  };

  const scheduleParityWork = (plan: SceneRenderPlan): void => {
    pendingParityPlan = plan;
    if (parityWorkHandle !== null) return;
    parityWorkHandle = requestParityWork(runParityWork);
  };

  const createRenderInput = (
    activeBinding: DrawingSceneRuntimeBinding,
    document: DrawingDocument,
    frame: DrawingFrameSnapshot,
  ): SceneRenderInput => {
    invalidateChangedCoordinateSpace(frame);
    return Object.freeze({
      adapter: activeBinding.adapter,
      binding: activeBinding,
      document,
      frame,
      stamp: frameStamp(document, frame),
      lodToleranceClass,
      sceneEpoch,
    });
  };

  const readInput = (): SceneRenderInput | null => {
    if (disposed || faulted || mode === "legacy" || !binding || !registry) return null;
    const document = binding.store.getSnapshot();
    // A store listener publishes inside dispatch, before the legacy renderer
    // adopts the committed document. Waiting for exact identity guarantees
    // that both backends observe one canonical revision.
    if (binding.renderer.documentSnapshot() !== document) {
      onSkipped?.("legacy-document-not-current");
      return null;
    }
    const frame = binding.adapter.captureDrawingFrame();
    if (!frame || !binding.adapter.isDrawingFrameCurrent(frame)) {
      onSkipped?.("drawing-frame-unavailable");
      return null;
    }
    return createRenderInput(binding, document, frame);
  };

  function publishPreparedPlan(
    plan: SceneRenderPlan,
    publishedList: DrawingScreenDisplayList,
    publishedHitIndex: DrawingHitIndex,
    source: "main-thread" | "worker",
    workerIdentity: DrawingWorkerJobHeader | null = null,
  ): boolean {
    const publicationWorkerBinding = Object.freeze({
      workerIdentity: source === "worker" && workerIdentity
        ? snapshotWorkerIdentity(workerIdentity)
        : null,
    });
    const currentDocument = plan.binding.store.getSnapshot();
    const documentCurrent = currentDocument === plan.document
      && plan.binding.renderer.documentSnapshot() === plan.document
      && plan.stamp.scopeKey === currentDocument.scopeKey
      && plan.stamp.documentRevision === currentDocument.documentRevision;
    if (plan.binding !== binding
      || plan.sceneEpoch !== sceneEpoch
      || !documentCurrent
      || !plan.binding.adapter.isDrawingFrameCurrent(plan.frame)) {
      onSkipped?.(!documentCurrent
        ? "scene-publish-document-stale"
        : plan.sceneEpoch !== sceneEpoch
          ? "scene-publish-epoch-stale"
          : "scene-publish-frame-stale");
      if (source === "worker") {
        // This guard runs before the visible surface publication boundary.
        // A worker result rejected here was dropped safely; it was never
        // offered to publishScene and must not trip the stale-publish gate.
        drawingPerfCounters.incrementCounter("staleWorkerResultCount");
        if (workerIdentity) recordReturnedWorkerIdentity(workerIdentity);
      }
      invalidateScene(documentCurrent ? "publish-frame-stale" : "publish-document-stale");
      return false;
    }
    if (source === "worker" && workerIdentity) {
      acceptedWorkerIdentity = workerIdentity;
    }
    let visiblePublicationAccepted = true;
    let visiblePublicationError: unknown = null;
    if (mode === "scene-canary") {
      // Install provenance before crossing the visible publication boundary.
      // A bridge may acknowledge only this exact immutable plan; rejected
      // publications remove the provisional binding below.
      workerBindingByPublishedPlan.set(publishedList, publicationWorkerBinding);
      try {
        visiblePublicationAccepted = plan.binding.publishScene?.(publishedList) === true;
      } catch (error) {
        visiblePublicationAccepted = false;
        visiblePublicationError = error;
      }
    }
    if (!visiblePublicationAccepted) {
      workerBindingByPublishedPlan.delete(publishedList);
      onSkipped?.("scene-publish-surface-stale");
      // A rejected visible publication is an ownership failure, not a stale
      // projector input. Stop consuming frame invalidations so a missing or
      // replaced surface cannot become an unbounded rAF rebuild loop. The
      // lifecycle decides whether pre-mutation legacy fallback is still safe.
      faulted = true;
      if (source === "worker") {
        staleWorkerPublishCount += 1;
        drawingPerfCounters.incrementCounter("staleWorkerPublishCount");
      }
      rejectExactPaintWaiters(
        "runtime-unavailable",
        "drawing scene exact paint runtime rejected publication",
      );
      removeSubscriptions();
      onError?.(visiblePublicationError
        ?? new Error("drawing scene publication was rejected by the current surface"));
      return false;
    }
    latestPlan = publishedList;
    latestHitIndex = publishedHitIndex;
    latestPublishedPlan = plan;
    publishedWorkerIdentity = publicationWorkerBinding.workerIdentity;
    latestOwnedEntityCount = plan.totalEntityCount;
    rawPointCount = freehandRawPointCount(plan.sceneNodes);
    renderedPointCount = publishedList.entities.reduce((count, entity) => (
      entity.kind === "freehand" || entity.kind === "highlighter"
        ? count + entity.pointCount
        : count
    ), 0);
    drawingPerfCounters.setGauge("rawPoints", rawPointCount);
    drawingPerfCounters.setGauge("renderedPoints", renderedPointCount);
    drawingPerfCounters.setGauge(
      "lodRatio",
      rawPointCount > 0 ? Math.min(1, renderedPointCount / rawPointCount) : 0,
    );
    if (plan.binding === binding && plan.stamp.viewportRevision === plan.frame.viewportRevision
      && (plan.lodToleranceClass === "settledExact"
        || plan.lodToleranceClass === "normalStatic")
      && exactRequestedAt !== null) {
      pendingExactPaintStamp = Object.freeze({ ...plan.stamp });
    }
    recoveryPublicationPending = false;
    if (source === "main-thread") effectiveRasterBackend = "main-thread";
    onMetrics?.(Object.freeze({
      buildDurationMs: plan.buildDurationMs,
      culledEntityCount: Math.max(0, plan.totalEntityCount - plan.visibleEntityCount),
      totalEntityCount: plan.totalEntityCount,
      visibleEntityCount: plan.visibleEntityCount,
    }));
    const compare = mode === "shadow" ? plan.binding.compareParity : undefined;
    const timestamp = now();
    if (compare
      && timestamp - lastParitySuccessAt >= parityInterval
      && timestamp - lastParityAttemptAt >= parityRetryInterval) {
      scheduleParityWork(plan);
    } else if (compare) {
      const nextEligibleAt = Math.max(
        lastParitySuccessAt + parityInterval,
        lastParityAttemptAt + parityRetryInterval,
      );
      scheduleParityInvalidation(Math.max(0, nextEligibleAt - timestamp));
    }
    return true;
  }

  const scheduler: DrawingRenderScheduler<SceneRenderInput> = createDrawingRenderScheduler<
    SceneRenderInput,
    SceneRenderPlan
  >({
    readInput,
    isInputCurrent(input, plan) {
      return !disposed
        && !faulted
        && input.binding === binding
        && input.binding.store.getSnapshot() === input.document
        && input.binding.renderer.documentSnapshot() === input.document
        && input.adapter.isDrawingFrameCurrent(input.frame)
        && input.sceneEpoch === sceneEpoch
        && drawingRenderRevisionKey(plan.stamp) === drawingRenderRevisionKey(input.stamp);
    },
    buildPlan(input) {
      const activeRegistry = registry;
      if (!activeRegistry || input.binding !== binding) return null;
      const buildScenePlan = (): SceneRenderPlan | null => {
        const startedAt = now();
        const reconciled = activeRegistry.reconcile(input.document);
        if (!reconciled.ok) throw new Error(reconciled.error);
        const allNodes = reconciled.snapshot.nodes;
        const ownedNodes = input.binding.shouldProjectNode
          ? Object.freeze(allNodes.filter(input.binding.shouldProjectNode))
          : allNodes;
        if (!warmDrawingSceneWorldResolutions({
          adapter: input.adapter,
          document: input.document,
          frame: input.frame,
          nodes: ownedNodes,
        })) {
          throw new Error("drawing scene source-anchor warmup was unresolved");
        }
        const visibleNodes = input.binding.isVisible?.() === false
          ? Object.freeze([])
          : queryCandidates(activeRegistry, ownedNodes, input.frame);
        const list = input.binding.projectScene({
          adapter: input.adapter,
          document: input.document,
          frame: input.frame,
          nodes: visibleNodes,
          selectedId: input.binding.selectedId?.() ?? null,
          stamp: input.stamp,
          lodToleranceClass: input.lodToleranceClass,
        });
        if (!list) {
          onSkipped?.("scene-projection-unresolved");
          if (mode === "scene-canary") {
            throw new Error("drawing scene projection was unresolved");
          }
          return null;
        }
        if (drawingRenderRevisionKey(list.stamp) !== drawingRenderRevisionKey(input.stamp)) {
          throw new Error("drawing scene projector returned a mismatched revision stamp");
        }
        const hitIndex = createDrawingHitIndex(list);
        const buildDurationMs = Math.max(0, now() - startedAt);
        // Reconcile, culling, LOD, final LWC-bound projection, and hit-index
        // construction all execute synchronously in this drawing frame. Count
        // that work alongside the eventual scene paint so the Phase 6 gate
        // cannot pass while the pre-paint path is slow.
        accumulateDrawingPerfFrameWork({
          drawingMainThreadMs: buildDurationMs,
          sceneProjectPaintMs: buildDurationMs,
        });
        return Object.freeze({
          binding: input.binding,
          buildDurationMs,
          document: input.document,
          frame: input.frame,
          hitIndex,
          list,
          lodToleranceClass: input.lodToleranceClass,
          sceneCanonicalIds: Object.freeze(ownedNodes.map((node) => node.id)),
          sceneNodes: ownedNodes,
          sceneEpoch: input.sceneEpoch,
          stamp: input.stamp,
          totalEntityCount: ownedNodes.length,
          visibleEntityCount: list.entities.length,
        });
      };
      if (!input.adapter.runDrawingFrameProjectionSession) return buildScenePlan();
      let projectionReturnedNull = false;
      const plan = input.adapter.runDrawingFrameProjectionSession(input.frame, () => {
        const built = buildScenePlan();
        projectionReturnedNull = built === null;
        return built;
      });
      if (!plan && !projectionReturnedNull) {
        onSkipped?.("drawing-frame-projection-session-stale");
        // A provider can advance synchronously inside a public chart call
        // without first emitting an invalidation. Queue a fresh atomic read
        // so the scene cannot remain stranded on its last accepted plan.
        scheduler.invalidate("projection-session-stale");
      }
      return plan;
    },
    publish(plan) {
      const publishStartedAt = now();
      try {
        // A worker round-trip cannot complete before the chart consumes this
        // frame. During updateAllViews publish the continuous/main-thread plan
        // immediately; the quiet-window settle pass also submits worker raster.
        if (mode === "scene-canary" && !publishingFromChartUpdate) {
          const workerSubmitted = submitWorkerPlan(plan);
          if (workerSubmitted) {
            const publishExactLatencyHedge = plan.lodToleranceClass === "settledExact"
              && latestPublishedPlan?.binding === binding
              && !hasSourceLineageFreehand(plan.sceneNodes);
            // A worker round-trip must not spend the stop-to-painted SLO. Once
            // visible pixels already exist, publish the same exact plan now and
            // let the bounded latest-wins worker replace it with a raster later.
            // First publication remains worker-owned.
            if (!publishExactLatencyHedge) return;
          }
        }
        publishPreparedPlan(plan, plan.list, plan.hitIndex, "main-thread");
      } finally {
        const publishDurationMs = Math.max(0, now() - publishStartedAt);
        accumulateDrawingPerfFrameWork({
          drawingMainThreadMs: publishDurationMs,
          sceneProjectPaintMs: publishDurationMs,
        });
      }
    },
    onError(error) {
      if (mode === "scene-canary") {
        // A visible scene cannot silently retain stale pixels after projection
        // fails. Stop consuming invalidations and let the lifecycle choose the
        // pre-mutation legacy fallback or the post-boundary last-valid-plan
        // fault path. Keep latestPlan intact for the latter.
        faulted = true;
        rejectExactPaintWaiters(
          "runtime-unavailable",
          "drawing scene exact paint runtime faulted",
        );
        removeSubscriptions();
      }
      onError?.(error);
    },
    requestFrame: scheduleSceneFrame,
    cancelFrame: cancelSceneFrame,
    restartPendingFrameOnInvalidate: mode === "shadow",
  });

  const synchronizeChartFrame = (): boolean => {
    if (disposed
      || faulted
      || mode !== "scene-canary"
      || !binding
      || !registry
      || latestOwnedEntityCount === 0
      || publishingFromChartUpdate) return false;

    let document: DrawingDocument;
    let frame: DrawingFrameSnapshot | null;
    try {
      document = binding.store.getSnapshot();
      if (binding.renderer.documentSnapshot() !== document) return false;
      if (document.zOrder.length === 0) return false;
      frame = binding.adapter.captureDrawingFrame();
    } catch (error) {
      onError?.(error);
      return false;
    }
    if (!frame || !binding.adapter.isDrawingFrameCurrent(frame)) return false;

    const published = latestPublishedPlan;
    // With no accepted pixels there is nothing for the chart to drag ahead
    // of. Keep first publication (and same-stamp exact refreshes) on their
    // normal worker path; this boundary is only for replacing stale pixels.
    if (!published || published.binding !== binding) return false;
    const targetStamp = frameStamp(document, frame);
    const currentPlan = drawingRenderRevisionKey(published.stamp)
      === drawingRenderRevisionKey(targetStamp);
    if (currentPlan) return false;

    const viewportChanged = (
      published.stamp.viewportRevision !== targetStamp.viewportRevision
      || published.stamp.widthCssPx !== targetStamp.widthCssPx
      || published.stamp.heightCssPx !== targetStamp.heightCssPx
      || published.stamp.dpr !== targetStamp.dpr
    );
    if (viewportChanged) {
      lodToleranceClass = "continuousViewport";
      exactRequestedAt = now();
      pendingExactPaintStamp = null;
      scheduleExactViewportRender();
    }

    if (!invalidateScene("chart-frame-sync")) return false;
    const input = createRenderInput(binding, document, frame);
    publishingFromChartUpdate = true;
    try {
      return scheduler.flushNow(input);
    } finally {
      publishingFromChartUpdate = false;
    }
  };

  const flushMutationAdmission = (): boolean => {
    if (disposed
      || faulted
      || mode !== "scene-canary"
      || !binding
      || !registry
      || publishingFromChartUpdate) return false;

    let document: DrawingDocument;
    let frame: DrawingFrameSnapshot | null;
    try {
      document = binding.store.getSnapshot();
      if (binding.renderer.documentSnapshot() !== document) return false;
      frame = binding.adapter.captureDrawingFrame();
    } catch (error) {
      onError?.(error);
      return false;
    }
    if (!frame || !binding.adapter.isDrawingFrameCurrent(frame)) return false;

    // Mutation admission is the one first-publication path where waiting for a
    // worker round-trip would discard a real user pointerdown. The normal
    // worker submission still follows on later invalidations; this synchronous
    // plan crosses the same binding/frame/surface validation as every publish.
    if (!invalidateScene("mutation-admission")) return false;
    const input = createRenderInput(binding, document, frame);
    publishingFromChartUpdate = true;
    try {
      return scheduler.flushNow(input);
    } finally {
      publishingFromChartUpdate = false;
    }
  };

  const acceptScenePainted = (stamp: DrawingRenderRevisionStamp): void => {
    if (exactRequestedAt === null || !pendingExactPaintStamp) return;
    if (drawingRenderRevisionKey(stamp)
      !== drawingRenderRevisionKey(pendingExactPaintStamp)) return;
    lastExactSettleMs = Math.max(0, now() - exactRequestedAt);
    drawingPerfCounters.recordDuration("exactRenderMs", lastExactSettleMs);
    exactRequestedAt = null;
    pendingExactPaintStamp = null;
  };

  const isNewerExactPaintEvidence = (
    candidate: ExactPaintEvidence,
    baseline: ExactPaintEvidence | null,
  ): boolean => {
    if (!baseline) return true;
    if (candidate.attachmentRevision !== baseline.attachmentRevision) {
      return candidate.attachmentRevision > baseline.attachmentRevision;
    }
    return candidate.paintSequence > baseline.paintSequence;
  };

  const acceptSceneExactPainted = (ack: DrawingScenePaintAck): void => {
    const plan = latestPublishedPlan;
    const activeBinding = binding;
    if (disposed
      || faulted
      || mode !== "scene-canary"
      || !activeBinding
      || !plan
      || ack.plan !== latestPlan
      || ack.plan !== latestHitIndex?.list
      || ack.stamp !== ack.plan.stamp
      || plan.binding !== activeBinding
      || plan.sceneEpoch !== sceneEpoch
      || !Number.isSafeInteger(ack.attachmentRevision)
      || ack.attachmentRevision < 0
      || !Number.isSafeInteger(ack.paintSequence)
      || ack.paintSequence <= 0) return;

    const document = activeBinding.store.getSnapshot();
    if (document !== plan.document
      || activeBinding.renderer.documentSnapshot() !== document
      || plan.stamp.scopeKey !== document.scopeKey
      || plan.stamp.documentRevision !== document.documentRevision
      || drawingRenderRevisionKey(ack.stamp) !== drawingRenderRevisionKey(plan.stamp)
      || !activeBinding.adapter.isDrawingFrameCurrent(plan.frame)) return;

    const evidence = Object.freeze({
      attachmentRevision: ack.attachmentRevision,
      paintSequence: ack.paintSequence,
      observedAt: new Date().toISOString(),
      stamp: Object.freeze({ ...ack.stamp }),
      workerIdentity: workerBindingByPublishedPlan.get(ack.plan)?.workerIdentity ?? null,
    });
    if (!isNewerExactPaintEvidence(evidence, lastExactPaintEvidence)) return;
    lastExactPaintEvidence = evidence;
    acceptScenePainted(ack.stamp);

    if (plan.lodToleranceClass !== "settledExact") return;
    for (const waiter of Array.from(exactPaintWaiters)) {
      if (waiter.binding !== activeBinding
        || waiter.scopeKey !== document.scopeKey
        || waiter.documentRevision !== document.documentRevision
        || plan.sceneEpoch < waiter.minimumSceneEpoch
        || ack.plan === waiter.previousPlan
        || !isNewerExactPaintEvidence(evidence, waiter.baseline)) continue;
      if (!settleExactPaintWaiter(waiter)) continue;
      waiter.resolve(Object.freeze({
        plan: ack.plan,
        stamp: ack.stamp,
        sceneEpoch: plan.sceneEpoch,
        lodToleranceClass: "settledExact",
        attachmentRevision: ack.attachmentRevision,
        paintSequence: ack.paintSequence,
      }));
    }
  };

  const removeSubscriptions = (): void => {
    unsubscribeDocument?.();
    unsubscribeFrame?.();
    unsubscribeScenePainted?.();
    unsubscribeSceneExactPainted?.();
    unsubscribeDocument = null;
    unsubscribeFrame = null;
    unsubscribeScenePainted = null;
    unsubscribeSceneExactPainted = null;
  };

  const installSubscriptions = (nextBinding: DrawingSceneRuntimeBinding): void => {
    // Faults deliberately remove both subscriptions to stop a rejected scene
    // from rebuilding forever. A same-binding activation is the explicit
    // recovery boundary, so it must restore both listeners before scheduling
    // the replacement plan. Replacing the pair also keeps this idempotent when
    // React asks an already-healthy runtime to reactivate.
    removeSubscriptions();
    if (nextBinding.subscribeSceneExactPainted) {
      unsubscribeSceneExactPainted = nextBinding.subscribeSceneExactPainted(
        acceptSceneExactPainted,
      );
    } else {
      unsubscribeScenePainted = nextBinding.subscribeScenePainted?.(acceptScenePainted) ?? null;
    }
    unsubscribeDocument = nextBinding.store.subscribe((document) => {
      if (nextBinding.renderer.documentSnapshot() !== document
        && nextBinding.synchronizePublishedDocument) {
        let synchronized = false;
        try {
          synchronized = nextBinding.synchronizePublishedDocument(document);
        } catch {
          synchronized = false;
        }
        if (!synchronized || nextBinding.renderer.documentSnapshot() !== document) {
          onSkipped?.("published-document-synchronization-failed");
        }
      }
      rejectInvalidatedExactPaintWaiters(nextBinding);
      lodToleranceClass = "settledExact";
      exactRequestedAt = now();
      pendingExactPaintStamp = null;
      clearExactDelay();
      invalidateScene("document");
    });
    unsubscribeFrame = nextBinding.adapter.subscribeDrawingFrameInvalidation((reason = "manual") => {
      // Viewport churn already schedules readInput(), which captures the same
      // atomic frame before projection. Avoid doing that relatively expensive
      // provider walk twice for every wheel/pan input. Explicit/manual
      // invalidations still retire a changed coordinate space synchronously.
      const currentFrame = reason === "viewport"
        ? null
        : nextBinding.adapter.captureDrawingFrame();
      const coordinateSpaceChanged = currentFrame !== null
        && nextBinding.adapter.isDrawingFrameCurrent(currentFrame)
        && invalidateChangedCoordinateSpace(currentFrame);
      if (mode === "scene-canary" && latestOwnedEntityCount === 0 && !coordinateSpaceChanged) return;
      if (reason === "viewport") {
        lodToleranceClass = "continuousViewport";
        exactRequestedAt = now();
        pendingExactPaintStamp = null;
        scheduleExactViewportRender();
      } else {
        lodToleranceClass = "settledExact";
        exactRequestedAt = now();
        pendingExactPaintStamp = null;
        clearExactDelay();
      }
      if (coordinateSpaceChanged) scheduler.invalidate(`frame:${reason}`);
      else invalidateScene(`frame:${reason}`);
    });
  };

  const runtime: DrawingSceneRuntime = {
    activate(nextBinding) {
      if (disposed || mode === "legacy") return false;
      const scopeKey = nextBinding.store.getSnapshot().scopeKey;
      if (!scopeKey || nextBinding.renderer.documentSnapshot() !== nextBinding.store.getSnapshot()) {
        onSkipped?.("scene-activation-not-current");
        return false;
      }
      if (binding
        && registry?.scopeKey === scopeKey
        && binding.adapter === nextBinding.adapter
        && binding.renderer === nextBinding.renderer
        && binding.store === nextBinding.store
        && binding.projectScene === nextBinding.projectScene) {
        rejectExactPaintWaiters(
          "runtime-unavailable",
          "drawing scene exact paint runtime was reactivated",
        );
        recoveryPublicationPending = recoveryPublicationPending || faulted;
        if (faulted || workerScopeKey !== scopeKey) disposeWorkerClient();
        faulted = false;
        binding = nextBinding;
        latestPublishedPlan = null;
        installSubscriptions(nextBinding);
        ensureWorkerClient();
        exactRequestedAt = now();
        pendingExactPaintStamp = null;
        return invalidateScene("reactivate");
      }
      if (binding) {
        const previousScopeKey = binding.store.getSnapshot().scopeKey;
        rejectExactPaintWaiters(
          previousScopeKey === scopeKey ? "runtime-unavailable" : "scope-invalidated",
          previousScopeKey === scopeKey
            ? "drawing scene exact paint binding was replaced"
            : "drawing scene exact paint scope was replaced",
        );
      }
      removeSubscriptions();
      clearParityDelay();
      clearParityWork();
      if (binding) clearDrawingSceneProjectorCaches(binding.adapter);
      disposeWorkerClient();
      resetWorkerIdentityEvidence();
      faulted = false;
      recoveryPublicationPending = false;
      binding = nextBinding;
      registry = createDrawingSceneRegistry(scopeKey);
      observedCoordinateKey = null;
      latestPlan = null;
      latestHitIndex = null;
      latestPublishedPlan = null;
      latestOwnedEntityCount = null;
      lodToleranceClass = "normalStatic";
      exactRequestedAt = now();
      pendingExactPaintStamp = null;
      lastExactSettleMs = null;
      lastExactPaintEvidence = null;
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
      installSubscriptions(nextBinding);
      ensureWorkerClient();
      return invalidateScene("activate");
    },
    invalidate(reason = "external") {
      return !faulted && mode !== "legacy" && binding !== null && invalidateScene(reason);
    },
    synchronizeChartFrame,
    flushMutationAdmission,
    requestParity() {
      if (mode !== "shadow" || !binding?.compareParity || disposed) return false;
      clearParityDelay();
      clearParityWork();
      clearExactDelay();
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
      if (latestPublishedPlan?.binding === binding) {
        scheduleParityWork(latestPublishedPlan);
      } else {
        invalidateScene("parity-request");
      }
      return true;
    },
    waitForExactPaint(request) {
      const activeBinding = binding;
      const unavailable = (message: string): Promise<DrawingSceneExactPaintReceipt> => (
        Promise.reject(new DrawingSceneExactPaintError("runtime-unavailable", message))
      );
      if (disposed
        || faulted
        || mode !== "scene-canary"
        || !activeBinding
        || typeof activeBinding.publishScene !== "function") {
        return unavailable("drawing scene exact paint runtime is unavailable");
      }
      if (typeof activeBinding.subscribeSceneExactPainted !== "function") {
        return unavailable("drawing scene exact paint evidence is unavailable");
      }
      const document = activeBinding.store.getSnapshot();
      if (request.scopeKey !== document.scopeKey) {
        return Promise.reject(new DrawingSceneExactPaintError(
          "scope-invalidated",
          "drawing scene exact paint scope is no longer current",
        ));
      }
      if (request.documentRevision !== document.documentRevision
        || activeBinding.renderer.documentSnapshot() !== document) {
        return Promise.reject(new DrawingSceneExactPaintError(
          "document-invalidated",
          "drawing scene exact paint document is no longer current",
        ));
      }
      if (request.signal?.aborted) {
        return Promise.reject(new DrawingSceneExactPaintError(
          "aborted",
          "drawing scene exact paint wait was aborted",
        ));
      }
      const timeoutMs = request.timeoutMs ?? 3_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new DrawingSceneExactPaintError(
          "timeout",
          "drawing scene exact paint wait timed out",
        ));
      }

      return new Promise<DrawingSceneExactPaintReceipt>((resolve, reject) => {
        const signal = request.signal ?? null;
        const handleAbort = (): void => {
          rejectExactPaintWaiter(
            waiter,
            "aborted",
            "drawing scene exact paint wait was aborted",
          );
        };
        const abortListener = signal ? handleAbort : null;
        const waiter: ExactPaintWaiter = {
          binding: activeBinding,
          scopeKey: request.scopeKey,
          documentRevision: request.documentRevision,
          minimumSceneEpoch: nextSceneEpoch(),
          previousPlan: latestPlan,
          baseline: lastExactPaintEvidence,
          signal,
          abortListener,
          resolve,
          reject,
          timeoutHandle: null,
          settled: false,
        };
        exactPaintWaiters.add(waiter);
        if (signal && abortListener) {
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) {
            abortListener();
            return;
          }
        }
        waiter.timeoutHandle = setTimeout(() => {
          rejectExactPaintWaiter(
            waiter,
            "timeout",
            "drawing scene exact paint wait timed out",
          );
        }, timeoutMs);

        lodToleranceClass = "settledExact";
        exactRequestedAt = now();
        pendingExactPaintStamp = null;
        clearExactDelay();
        if (!invalidateScene("exact-paint-barrier")) {
          rejectExactPaintWaiter(
            waiter,
            "runtime-unavailable",
            "drawing scene exact paint runtime could not invalidate",
          );
          return;
        }
        if (!waiter.settled) scheduler.flushNow();
      });
    },
    flushNow() {
      return !faulted && mode !== "legacy" && binding !== null && scheduler.flushNow();
    },
    suspend() {
      rejectExactPaintWaiters(
        "scope-invalidated",
        "drawing scene exact paint scope was suspended",
      );
      if (mode === "scene-canary") binding?.clearScene?.();
      if (binding) clearDrawingSceneProjectorCaches(binding.adapter);
      removeSubscriptions();
      clearParityDelay();
      clearParityWork();
      clearExactDelay();
      disposeWorkerClient();
      resetWorkerIdentityEvidence();
      binding = null;
      registry = null;
      observedCoordinateKey = null;
      faulted = false;
      recoveryPublicationPending = false;
      latestPlan = null;
      latestHitIndex = null;
      latestPublishedPlan = null;
      latestOwnedEntityCount = null;
      lodToleranceClass = "normalStatic";
      exactRequestedAt = null;
      pendingExactPaintStamp = null;
      lastExactSettleMs = null;
      lastExactPaintEvidence = null;
      rawPointCount = 0;
      renderedPointCount = 0;
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
    },
    snapshot() {
      const paintReceipt: DrawingSceneRuntimePaintReceipt | null = lastExactPaintEvidence
        ? Object.freeze({
            kind: "drawing-scene-bridge-paint-ack",
            observedAt: lastExactPaintEvidence.observedAt,
            stamp: lastExactPaintEvidence.stamp,
            attachmentRevision: lastExactPaintEvidence.attachmentRevision,
            paintSequence: lastExactPaintEvidence.paintSequence,
          })
        : null;
      return Object.freeze({
        active: binding !== null && !faulted,
        disposed,
        mode,
        hitIndex: latestHitIndex,
        lodToleranceClass,
        lastExactSettleMs,
        rasterBackend: effectiveRasterBackend,
        offscreenSupported: typeof OffscreenCanvas === "function",
        worker: workerSnapshot,
        lastWorkerRequestedStamp,
        lastWorkerPublishedStamp,
        submittedWorkerHeaders: Object.freeze([...submittedWorkerHeaders]),
        returnedWorkerIdentity,
        acceptedWorkerIdentity,
        publishedWorkerIdentity,
        paintedWorkerIdentity: lastExactPaintEvidence?.workerIdentity ?? null,
        latestSubmittedWorkerIdentity,
        lastPaintedStamp: lastExactPaintEvidence?.stamp ?? null,
        paintReceipt,
        staleWorkerPublishCount,
        workerResultDeliveryDelayMs,
        rawPointCount,
        renderedPointCount,
        plan: latestPlan,
        publicationReady: latestPlan !== null && !faulted && !recoveryPublicationPending,
        scopeKey: binding?.store.getSnapshot().scopeKey ?? null,
      });
    },
    dispose() {
      if (disposed) return;
      rejectExactPaintWaiters(
        "runtime-unavailable",
        "drawing scene exact paint runtime was disposed",
      );
      runtime.suspend();
      disposed = true;
      scheduler.dispose();
    },
  };
  return Object.freeze(runtime);
}
