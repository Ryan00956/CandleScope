import type {
  DrawingAttachedParameter,
  PrimitivePaneView,
} from "../drawingTypes.js";
import { drawingPerfCounters } from "../performance/drawingPerfCounters.js";
import type { DrawingScreenDisplayList } from "./drawingDisplayList.js";
import { DrawingSceneRenderer } from "./drawingSceneRenderer.js";

export interface DrawingScenePaintAck {
  readonly plan: DrawingScreenDisplayList;
  readonly stamp: DrawingScreenDisplayList["stamp"];
  readonly attachmentRevision: number;
  readonly paintSequence: number;
}

export type DrawingScenePaintListener = (ack: DrawingScenePaintAck) => void;

type DrawingScenePaintRetryFrame = (callback: () => void) => unknown;
type DrawingSceneCancelPaintRetryFrame = (handle: unknown) => void;

function requestNativePaintRetryFrame(callback: () => void): unknown | null {
  if (typeof requestAnimationFrame !== "function") return null;
  return requestAnimationFrame(callback);
}

function cancelNativePaintRetryFrame(handle: unknown): void {
  if (typeof cancelAnimationFrame !== "function") return;
  cancelAnimationFrame(handle as number);
}

export interface DrawingScenePrimitiveOptions {
  /**
   * Called from Lightweight Charts' own view-update phase. The lifecycle uses
   * this boundary to replace a stale viewport plan before the current bitmap
   * is consumed, without teaching the primitive how to project geometry.
   */
  synchronizeChartFrame?: () => void;
  /**
   * Test/host seam for the single post-publication paint recovery check. It
   * deliberately has no timer fallback: server-side primitives have no chart
   * bitmap to recover.
   */
  requestPaintRetryFrame?: DrawingScenePaintRetryFrame;
  cancelPaintRetryFrame?: DrawingSceneCancelPaintRetryFrame;
}

class DrawingScenePaneView implements PrimitivePaneView {
  readonly #renderer: DrawingSceneRenderer;

  constructor(renderer: DrawingSceneRenderer) {
    this.#renderer = renderer;
  }

  renderer(): DrawingSceneRenderer {
    return this.#renderer;
  }

  zOrder(): "normal" {
    return "normal";
  }
}

/**
 * The only LWC primitive owned by the visible static drawing scene. Geometry
 * remains owned by the scene runtime; this primitive only gives that runtime
 * one pre-paint synchronization boundary and consumes its published plan.
 */
export class DrawingScenePrimitive {
  readonly #renderer: DrawingSceneRenderer;
  readonly #paneView: DrawingScenePaneView;
  readonly #paneViews: readonly PrimitivePaneView[];
  readonly #synchronizeChartFrame: () => void;
  readonly #requestPaintRetryFrame: DrawingScenePaintRetryFrame;
  readonly #cancelPaintRetryFrame: DrawingSceneCancelPaintRetryFrame;
  readonly #paintListeners = new Set<DrawingScenePaintListener>();
  #requestUpdate: (() => void) | null = null;
  #updatingAllViews = false;
  #attachmentRevision = 0;
  #paintSequence = 0;
  #lastPaintedPlan: DrawingScreenDisplayList | null = null;
  #paintRetryFrame: unknown = null;
  #paintRetryGeneration = 0;
  #paintRetryPlan: DrawingScreenDisplayList | null = null;
  #disposed = false;
  _series: DrawingAttachedParameter["series"] | null = null;

  constructor({
    synchronizeChartFrame = () => {},
    requestPaintRetryFrame = requestNativePaintRetryFrame,
    cancelPaintRetryFrame = cancelNativePaintRetryFrame,
  }: DrawingScenePrimitiveOptions = {}) {
    this.#synchronizeChartFrame = synchronizeChartFrame;
    this.#requestPaintRetryFrame = requestPaintRetryFrame;
    this.#cancelPaintRetryFrame = cancelPaintRetryFrame;
    this.#renderer = new DrawingSceneRenderer((plan) => {
      this.#acknowledgePainted(plan);
    });
    this.#paneView = new DrawingScenePaneView(this.#renderer);
    this.#paneViews = Object.freeze([this.#paneView]);
  }

  #clearPaintListeners(): void {
    this.#paintListeners.clear();
  }

  #cancelPaintRetry(): void {
    this.#paintRetryGeneration += 1;
    const frame = this.#paintRetryFrame;
    this.#paintRetryFrame = null;
    this.#paintRetryPlan = null;
    if (frame === null) return;
    try {
      this.#cancelPaintRetryFrame(frame);
    } catch {
      // A host cancellation failure must not prevent credential retirement.
    }
  }

  /**
   * The normal path always asks LWC for an update immediately. This is only a
   * bounded recovery for a dropped first paint: if the exact immutable plan
   * still has no renderer acknowledgement after that update's frame, request
   * one more chart frame. It never schedules another retry from the recovery.
   */
  #schedulePaintRetry(plan: DrawingScreenDisplayList): void {
    this.#cancelPaintRetry();
    const generation = this.#paintRetryGeneration;
    this.#paintRetryPlan = plan;
    const retry = () => {
      if (generation !== this.#paintRetryGeneration
        || this.#paintRetryPlan !== plan) return;
      this.#paintRetryFrame = null;
      this.#paintRetryPlan = null;
      if (this.#disposed
        || !this.#requestUpdate
        || !this._series
        || this.#renderer.plan() !== plan
        || this.#lastPaintedPlan === plan) return;
      this.#requestChartUpdate();
    };
    let frame: unknown;
    try {
      frame = this.#requestPaintRetryFrame(retry);
    } catch {
      this.#paintRetryPlan = null;
      return;
    }
    // Browser rAF callbacks are asynchronous, but retain correct semantics
    // for a synchronous host/test seam too.
    if (generation !== this.#paintRetryGeneration
      || this.#paintRetryPlan !== plan) return;
    if (frame === null || typeof frame === "undefined") {
      this.#paintRetryPlan = null;
      return;
    }
    this.#paintRetryFrame = frame;
  }

  #acknowledgePainted(plan: DrawingScreenDisplayList): void {
    if (this.#disposed
      || !this.#requestUpdate
      || !this._series
      || this.#renderer.plan() !== plan) return;
    this.#lastPaintedPlan = plan;
    if (this.#paintRetryPlan === plan) this.#cancelPaintRetry();
    this.#paintSequence += 1;
    const ack: DrawingScenePaintAck = Object.freeze({
      plan,
      stamp: plan.stamp,
      attachmentRevision: this.#attachmentRevision,
      paintSequence: this.#paintSequence,
    });
    for (const listener of Array.from(this.#paintListeners)) {
      if (!this.#paintListeners.has(listener)) continue;
      try {
        listener(ack);
      } catch {
        // Paint observers are outside the chart renderer's failure boundary.
      }
    }
  }

  #requestChartUpdate(): void {
    const requestUpdate = this.#requestUpdate;
    if (!requestUpdate || this.#updatingAllViews) return;
    drawingPerfCounters.recordRequestUpdate();
    requestUpdate();
  }

  attached({ series, requestUpdate }: DrawingAttachedParameter): void {
    if (this.#disposed) return;
    this.#attachmentRevision += 1;
    this._series = series;
    this.#requestUpdate = requestUpdate;
  }

  detached(): void {
    this.#attachmentRevision += 1;
    this.#cancelPaintRetry();
    this.#clearPaintListeners();
    this._series = null;
    this.#requestUpdate = null;
    this.#lastPaintedPlan = null;
    this.#renderer.setPlan(null);
  }

  /** Used after removeSeries(), which invalidates credentials without a safe detach call. */
  releaseSurfaceCredentials(): void {
    this.detached();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.detached();
    this.#disposed = true;
  }

  updateAllViews(): void {
    if (this.#disposed || this.#updatingAllViews || !this.#requestUpdate || !this._series) return;
    this.#updatingAllViews = true;
    try {
      this.#synchronizeChartFrame();
    } finally {
      this.#updatingAllViews = false;
    }
  }

  paneViews(): readonly PrimitivePaneView[] {
    return this.#paneViews;
  }

  publishPlan(plan: DrawingScreenDisplayList): boolean {
    if (this.#disposed || !this.#requestUpdate || !this._series) return false;
    if (this.#renderer.plan() === plan) return true;
    this.#cancelPaintRetry();
    this.#lastPaintedPlan = null;
    this.#renderer.setPlan(plan);
    this.#requestChartUpdate();
    // Schedule after the direct request so LWC's own rAF gets first chance to
    // paint. A synchronous host paint above already set lastPaintedPlan.
    if (this.#renderer.plan() === plan && this.#lastPaintedPlan !== plan) {
      this.#schedulePaintRetry(plan);
    }
    return true;
  }

  clearPlan(requestUpdate = true): void {
    if (this.#renderer.plan() === null) return;
    this.#cancelPaintRetry();
    this.#lastPaintedPlan = null;
    this.#renderer.setPlan(null);
    if (requestUpdate) this.#requestChartUpdate();
  }

  plan(): DrawingScreenDisplayList | null {
    return this.#renderer.plan();
  }

  /** Subscribe to bitmap consumption of the exact currently-published plan. */
  subscribePainted(listener: DrawingScenePaintListener): () => void {
    if (this.#disposed || typeof listener !== "function") return () => {};
    this.#paintListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#paintListeners.delete(listener);
    };
  }
}
