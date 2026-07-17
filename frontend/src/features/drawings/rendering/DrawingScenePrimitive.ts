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
  /**
   * Called from Lightweight Charts' own view-update phase. The lifecycle uses
   * this boundary to replace a stale viewport plan before the current bitmap
   * is consumed, without teaching the primitive how to project geometry.
   */
  synchronizeChartFrame?: () => void;
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
  readonly #paintListeners = new Set<DrawingScenePaintListener>();
  #requestUpdate: (() => void) | null = null;
  #updatingAllViews = false;
  #attachmentRevision = 0;
  #paintSequence = 0;
  #disposed = false;
  _series: DrawingAttachedParameter["series"] | null = null;

  constructor({
    synchronizeChartFrame = () => {},
  }: DrawingScenePrimitiveOptions = {}) {
    this.#synchronizeChartFrame = synchronizeChartFrame;
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
    this.#renderer.setPlan(plan);
    this.#requestChartUpdate();
    return true;
  }

  clearPlan(requestUpdate = true): void {
    if (this.#renderer.plan() === null) return;
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
