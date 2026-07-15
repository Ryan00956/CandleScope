import type { DrawingFrameSnapshot } from "../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  CoordinateDataPoint,
  SourceLineageSpanInput,
} from "../../../chart-adapter/coordinateBridge.js";
import type { DrawingDocument } from "../core/drawingDocument.js";
import type { DrawingDocumentStore } from "../core/drawingDocumentStore.js";
import type { LegacyPrimitiveRenderer } from "../legacy/legacyPrimitiveRenderer.js";
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
import type {
  DrawingSceneTextMeasurement,
  DrawingSceneTextMeasureRequest,
} from "./drawingSceneProjector.js";

export interface DrawingSceneFrameAdapter {
  captureDrawingFrame(): DrawingFrameSnapshot | null;
  isDrawingFrameCurrent(frame: DrawingFrameSnapshot): boolean;
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
  subscribeDrawingFrameInvalidation(listener: () => void): () => void;
}

export interface DrawingSceneProjectionRequest {
  readonly adapter: DrawingSceneFrameAdapter;
  readonly document: DrawingDocument;
  readonly frame: DrawingFrameSnapshot;
  readonly nodes: readonly DrawingSceneNode[];
  readonly selectedId: string | null;
  readonly stamp: DrawingRenderRevisionStamp;
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
}

export interface DrawingSceneRuntimeSnapshot {
  readonly active: boolean;
  readonly disposed: boolean;
  readonly mode: "legacy" | "shadow" | "scene-canary";
  readonly plan: DrawingScreenDisplayList | null;
  /** True only after the current activation/recovery accepted a publication. */
  readonly publicationReady: boolean;
  readonly scopeKey: string | null;
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
}

interface SceneRenderPlan extends DrawingPreparedRenderPlan {
  readonly binding: DrawingSceneRuntimeBinding;
  readonly buildDurationMs: number;
  readonly document: DrawingDocument;
  readonly frame: DrawingFrameSnapshot;
  readonly list: DrawingScreenDisplayList;
  readonly sceneCanonicalIds: readonly string[];
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
  return Object.freeze(nodes.filter((node) => candidateIds.has(node.id)
    || node.entity.kind === "angle-measure"
    || node.entity.kind === "fibonacci"
    || node.entity.kind === "text"
    || node.entity.kind === "position"));
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
  let latestPlan: DrawingScreenDisplayList | null = null;
  let latestPublishedPlan: SceneRenderPlan | null = null;
  let latestOwnedEntityCount: number | null = null;
  let disposed = false;
  let faulted = false;
  let recoveryPublicationPending = false;
  let lastParityAttemptAt = Number.NEGATIVE_INFINITY;
  let lastParitySuccessAt = Number.NEGATIVE_INFINITY;
  let parityDelayHandle: unknown = null;
  let parityWorkHandle: unknown = null;
  let pendingParityPlan: SceneRenderPlan | null = null;

  const clearParityDelay = (): void => {
    if (parityDelayHandle === null) return;
    cancelDelay(parityDelayHandle);
    parityDelayHandle = null;
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
          scheduler.invalidate("parity-interval");
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
      scheduler.invalidate("parity-input-stale");
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
    });
  };

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
      return Object.freeze({
        binding: input.binding,
        buildDurationMs: Math.max(0, now() - startedAt),
        document: input.document,
        frame: input.frame,
        list,
        sceneCanonicalIds: Object.freeze(ownedNodes.map((node) => node.id)),
        stamp: input.stamp,
        totalEntityCount: ownedNodes.length,
        visibleEntityCount: list.entities.length,
      });
    },
    publish(plan) {
      if (plan.binding !== binding || !plan.binding.adapter.isDrawingFrameCurrent(plan.frame)) {
        onSkipped?.("scene-publish-frame-stale");
        scheduler.invalidate("publish-frame-stale");
        return;
      }
      let visiblePublicationAccepted = true;
      let visiblePublicationError: unknown = null;
      if (mode === "scene-canary") {
        try {
          visiblePublicationAccepted = plan.binding.publishScene?.(plan.list) === true;
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
        removeSubscriptions();
        onError?.(visiblePublicationError
          ?? new Error("drawing scene publication was rejected by the current surface"));
        return;
      }
      latestPlan = plan.list;
      latestPublishedPlan = plan;
      latestOwnedEntityCount = plan.totalEntityCount;
      recoveryPublicationPending = false;
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

  const removeSubscriptions = (): void => {
    unsubscribeDocument?.();
    unsubscribeFrame?.();
    unsubscribeDocument = null;
    unsubscribeFrame = null;
  };

  const installSubscriptions = (nextBinding: DrawingSceneRuntimeBinding): void => {
    // Faults deliberately remove both subscriptions to stop a rejected scene
    // from rebuilding forever. A same-binding activation is the explicit
    // recovery boundary, so it must restore both listeners before scheduling
    // the replacement plan. Replacing the pair also keeps this idempotent when
    // React asks an already-healthy runtime to reactivate.
    removeSubscriptions();
    unsubscribeDocument = nextBinding.store.subscribe(() => {
      scheduler.invalidate("document");
    });
    unsubscribeFrame = nextBinding.adapter.subscribeDrawingFrameInvalidation(() => {
      if (mode === "scene-canary" && latestOwnedEntityCount === 0) return;
      scheduler.invalidate("frame");
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
        faulted = false;
        binding = nextBinding;
        latestPublishedPlan = null;
        installSubscriptions(nextBinding);
        return scheduler.invalidate("reactivate");
      }
      removeSubscriptions();
      clearParityDelay();
      clearParityWork();
      faulted = false;
      recoveryPublicationPending = false;
      binding = nextBinding;
      registry = createDrawingSceneRegistry(scopeKey);
      latestPlan = null;
      latestPublishedPlan = null;
      latestOwnedEntityCount = null;
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
      installSubscriptions(nextBinding);
      return scheduler.invalidate("activate");
    },
    invalidate(reason = "external") {
      return !faulted && mode !== "legacy" && binding !== null && scheduler.invalidate(reason);
    },
    requestParity() {
      if (mode !== "shadow" || !binding?.compareParity || disposed) return false;
      clearParityDelay();
      clearParityWork();
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
      if (latestPublishedPlan?.binding === binding) {
        scheduleParityWork(latestPublishedPlan);
      } else {
        scheduler.invalidate("parity-request");
      }
      return true;
    },
    flushNow() {
      return !faulted && mode !== "legacy" && binding !== null && scheduler.flushNow();
    },
    suspend() {
      if (mode === "scene-canary") binding?.clearScene?.();
      removeSubscriptions();
      clearParityDelay();
      clearParityWork();
      binding = null;
      registry = null;
      faulted = false;
      recoveryPublicationPending = false;
      latestPlan = null;
      latestPublishedPlan = null;
      latestOwnedEntityCount = null;
      lastParityAttemptAt = Number.NEGATIVE_INFINITY;
      lastParitySuccessAt = Number.NEGATIVE_INFINITY;
    },
    snapshot() {
      return Object.freeze({
        active: binding !== null && !faulted,
        disposed,
        mode,
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
