import type { DrawingFrameSnapshot } from "../../../chart-adapter/drawingFrameSnapshot.js";
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
  readonly staleWorkerPublishCount: number;
  readonly workerResultDeliveryDelayMs: number;
  readonly rawPointCount: number;
  readonly renderedPointCount: number;
}

export interface DrawingSceneRuntime {
  activate(binding: DrawingSceneRuntimeBinding): boolean;
  invalidate(reason?: string): boolean;
  requestParity(): boolean;
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
  let latestPlan: DrawingScreenDisplayList | null = null;
  let latestHitIndex: DrawingHitIndex | null = null;
  let latestPublishedPlan: SceneRenderPlan | null = null;
  let latestOwnedEntityCount: number | null = null;
  let lodToleranceClass: DrawingLodToleranceClass = "normalStatic";
  let exactDelayHandle: unknown = null;
  let exactRequestedAt: number | null = null;
  let pendingExactPaintStamp: DrawingRenderRevisionStamp | null = null;
  let lastExactSettleMs: number | null = null;
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
  let staleWorkerPublishCount = 0;
  let rawPointCount = 0;
  let renderedPointCount = 0;
  let sceneEpoch = 0;
  let disposed = false;
  let faulted = false;
  let recoveryPublicationPending = false;
  let lastParityAttemptAt = Number.NEGATIVE_INFINITY;
  let lastParitySuccessAt = Number.NEGATIVE_INFINITY;
  let parityDelayHandle: unknown = null;
  let parityWorkHandle: unknown = null;
  let pendingParityPlan: SceneRenderPlan | null = null;

  const ensureWorkerClient = (): DrawingWorkerClient | null => {
    if (rasterBackend !== "worker" || workerRasterDisabled) {
      effectiveRasterBackend = "main-thread";
      return null;
    }
    if (workerClient) return workerClient;
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
            drawingPerfCounters.incrementCounter("staleWorkerResultCount");
            releaseDrawingWorkerDrawResult(response.result);
            return;
          }
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
            if (publishPreparedPlan(preparedPlan, preparedList, preparedHitIndex, "worker")) {
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
            if (!publishPreparedPlan(preparedPlan, rasterList, rasterHitIndex, "worker")) {
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
      && isDrawingWorkerRasterCompositeOperation(entity.renderSpec.compositeOperation))) return false;
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

  const invalidateScene = (reason: string): boolean => {
    sceneEpoch = sceneEpoch >= Number.MAX_SAFE_INTEGER ? 1 : sceneEpoch + 1;
    return scheduler.invalidate(reason);
  };

  const scheduleExactViewportRender = (): void => {
    clearExactDelay();
    exactDelayHandle = scheduleDelay(() => {
      exactDelayHandle = null;
      if (disposed || faulted || !binding) return;
      lodToleranceClass = "settledExact";
      invalidateScene("viewport-exact");
    }, 100);
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
    return Object.freeze({
      adapter: binding.adapter,
      binding,
      document,
      frame,
      stamp: frameStamp(document, frame),
      lodToleranceClass,
      sceneEpoch,
    });
  };

  function publishPreparedPlan(
    plan: SceneRenderPlan,
    publishedList: DrawingScreenDisplayList,
    publishedHitIndex: DrawingHitIndex,
    source: "main-thread" | "worker",
  ): boolean {
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
      }
      invalidateScene(documentCurrent ? "publish-frame-stale" : "publish-document-stale");
      return false;
    }
    let visiblePublicationAccepted = true;
    let visiblePublicationError: unknown = null;
    if (mode === "scene-canary") {
      try {
        visiblePublicationAccepted = plan.binding.publishScene?.(publishedList) === true;
      } catch (error) {
        visiblePublicationAccepted = false;
        visiblePublicationError = error;
      }
    }
    if (!visiblePublicationAccepted) {
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
      removeSubscriptions();
      onError?.(visiblePublicationError
        ?? new Error("drawing scene publication was rejected by the current surface"));
      return false;
    }
    latestPlan = publishedList;
    latestHitIndex = publishedHitIndex;
    latestPublishedPlan = plan;
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

  const scheduler: DrawingRenderScheduler = createDrawingRenderScheduler<
    SceneRenderInput,
    SceneRenderPlan
  >({
    readInput,
    buildPlan(input) {
      if (!registry || input.binding !== binding) return null;
      const startedAt = now();
      const reconciled = registry.reconcile(input.document);
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
        : queryCandidates(registry, ownedNodes, input.frame);
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
    },
    publish(plan) {
      const publishStartedAt = now();
      try {
        if (mode === "scene-canary" && submitWorkerPlan(plan)) return;
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
        removeSubscriptions();
      }
      onError?.(error);
    },
    requestFrame: scheduleSceneFrame,
    cancelFrame: cancelSceneFrame,
    restartPendingFrameOnInvalidate: mode === "shadow",
  });

  const acceptScenePainted = (stamp: DrawingRenderRevisionStamp): void => {
    if (exactRequestedAt === null || !pendingExactPaintStamp) return;
    if (drawingRenderRevisionKey(stamp)
      !== drawingRenderRevisionKey(pendingExactPaintStamp)) return;
    lastExactSettleMs = Math.max(0, now() - exactRequestedAt);
    drawingPerfCounters.recordDuration("exactRenderMs", lastExactSettleMs);
    exactRequestedAt = null;
    pendingExactPaintStamp = null;
  };

  const removeSubscriptions = (): void => {
    unsubscribeDocument?.();
    unsubscribeFrame?.();
    unsubscribeScenePainted?.();
    unsubscribeDocument = null;
    unsubscribeFrame = null;
    unsubscribeScenePainted = null;
  };

  const installSubscriptions = (nextBinding: DrawingSceneRuntimeBinding): void => {
    // Faults deliberately remove both subscriptions to stop a rejected scene
    // from rebuilding forever. A same-binding activation is the explicit
    // recovery boundary, so it must restore both listeners before scheduling
    // the replacement plan. Replacing the pair also keeps this idempotent when
    // React asks an already-healthy runtime to reactivate.
    removeSubscriptions();
    unsubscribeScenePainted = nextBinding.subscribeScenePainted?.(acceptScenePainted) ?? null;
    unsubscribeDocument = nextBinding.store.subscribe(() => {
      lodToleranceClass = "settledExact";
      exactRequestedAt = now();
      pendingExactPaintStamp = null;
      clearExactDelay();
      invalidateScene("document");
    });
    unsubscribeFrame = nextBinding.adapter.subscribeDrawingFrameInvalidation((reason = "manual") => {
      if (mode === "scene-canary" && latestOwnedEntityCount === 0) return;
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
      invalidateScene(`frame:${reason}`);
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
      removeSubscriptions();
      clearParityDelay();
      clearParityWork();
      if (binding) clearDrawingSceneProjectorCaches(binding.adapter);
      disposeWorkerClient();
      faulted = false;
      recoveryPublicationPending = false;
      binding = nextBinding;
      registry = createDrawingSceneRegistry(scopeKey);
      latestPlan = null;
      latestHitIndex = null;
      latestPublishedPlan = null;
      latestOwnedEntityCount = null;
      lodToleranceClass = "normalStatic";
      exactRequestedAt = now();
      pendingExactPaintStamp = null;
      lastExactSettleMs = null;
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
      installSubscriptions(nextBinding);
      ensureWorkerClient();
      return invalidateScene("activate");
    },
    invalidate(reason = "external") {
      return !faulted && mode !== "legacy" && binding !== null && invalidateScene(reason);
    },
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
    flushNow() {
      return !faulted && mode !== "legacy" && binding !== null && scheduler.flushNow();
    },
    suspend() {
      if (mode === "scene-canary") binding?.clearScene?.();
      if (binding) clearDrawingSceneProjectorCaches(binding.adapter);
      removeSubscriptions();
      clearParityDelay();
      clearParityWork();
      clearExactDelay();
      disposeWorkerClient();
      binding = null;
      registry = null;
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
      rawPointCount = 0;
      renderedPointCount = 0;
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
    },
    snapshot() {
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
      runtime.suspend();
      disposed = true;
      scheduler.dispose();
    },
  };
  return Object.freeze(runtime);
}
