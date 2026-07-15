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

export interface DrawingScenePrimitiveOptions {
  requestFrame?: (callback: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}

function defaultRequestFrame(callback: () => void): unknown {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function defaultCancelFrame(handle: unknown): void {
  if (typeof cancelAnimationFrame === "function" && typeof handle === "number") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
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
 * is prepared before publication; chart-driven view updates are intentionally
 * no-ops and can never trigger projection work.
 */
export class DrawingScenePrimitive {
  readonly #renderer: DrawingSceneRenderer;
  readonly #paneView: DrawingScenePaneView;
  readonly #paneViews: readonly PrimitivePaneView[];
  readonly #requestFrame: (callback: () => void) => unknown;
  readonly #cancelFrame: (handle: unknown) => void;
  readonly #paintListeners = new Set<DrawingScenePaintListener>();
  #requestUpdate: (() => void) | null = null;
  #updateFrameHandle: unknown = null;
  #updateScheduled = false;
  #attachmentRevision = 0;
  #paintSequence = 0;
  #disposed = false;
  _series: DrawingAttachedParameter["series"] | null = null;

  constructor({
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
  }: DrawingScenePrimitiveOptions = {}) {
    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
    this.#renderer = new DrawingSceneRenderer((plan) => {
      this.#acknowledgePainted(plan);
    });
    this.#paneView = new DrawingScenePaneView(this.#renderer);
    this.#paneViews = Object.freeze([this.#paneView]);
  }

  #clearPaintListeners(): void {
    this.#paintListeners.clear();
  }

  #acknowledgePainted(plan: DrawingScreenDisplayList): void {
    if (this.#disposed
      || !this.#requestUpdate
      || !this._series
      || this.#renderer.plan() !== plan) return;
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

  #cancelPendingUpdate(): void {
    if (!this.#updateScheduled) return;
    this.#cancelFrame(this.#updateFrameHandle);
    this.#updateFrameHandle = null;
    this.#updateScheduled = false;
  }

  #scheduleUpdate(): void {
    if (!this.#requestUpdate || this.#updateScheduled) return;
    this.#updateScheduled = true;
    this.#updateFrameHandle = this.#requestFrame(() => {
      this.#updateFrameHandle = null;
      this.#updateScheduled = false;
      const requestUpdate = this.#requestUpdate;
      if (!requestUpdate) return;
      drawingPerfCounters.recordRequestUpdate();
      requestUpdate();
    });
  }

  attached({ series, requestUpdate }: DrawingAttachedParameter): void {
    if (this.#disposed) return;
    this.#attachmentRevision += 1;
    this._series = series;
    this.#requestUpdate = requestUpdate;
  }

  detached(): void {
    this.#cancelPendingUpdate();
    this.#attachmentRevision += 1;
    this.#clearPaintListeners();
    this._series = null;
    this.#requestUpdate = null;
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
    // Prepared scene plans are published explicitly. Cursor-only and ordinary
    // chart updates must not project, scan, allocate, or replace this plan.
  }

  paneViews(): readonly PrimitivePaneView[] {
    return this.#paneViews;
  }

  publishPlan(plan: DrawingScreenDisplayList): boolean {
    if (this.#disposed || !this.#requestUpdate || !this._series) return false;
    if (this.#renderer.plan() === plan) return true;
    this.#renderer.setPlan(plan);
    this.#scheduleUpdate();
    return true;
  }

  clearPlan(requestUpdate = true): void {
    if (this.#renderer.plan() === null) return;
    this.#renderer.setPlan(null);
    if (requestUpdate) this.#scheduleUpdate();
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
