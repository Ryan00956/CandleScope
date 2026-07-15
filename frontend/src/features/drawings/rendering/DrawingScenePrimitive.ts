import type {
  DrawingAttachedParameter,
  PrimitivePaneView,
} from "../drawingTypes.js";
import { drawingPerfCounters } from "../performance/drawingPerfCounters.js";
import type { DrawingScreenDisplayList } from "./drawingDisplayList.js";
import { DrawingSceneRenderer } from "./drawingSceneRenderer.js";

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
  readonly #renderer = new DrawingSceneRenderer();
  readonly #paneView = new DrawingScenePaneView(this.#renderer);
  readonly #paneViews: readonly PrimitivePaneView[] = Object.freeze([this.#paneView]);
  readonly #requestFrame: (callback: () => void) => unknown;
  readonly #cancelFrame: (handle: unknown) => void;
  #requestUpdate: (() => void) | null = null;
  #updateFrameHandle: unknown = null;
  #updateScheduled = false;
  _series: DrawingAttachedParameter["series"] | null = null;

  constructor({
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
  }: DrawingScenePrimitiveOptions = {}) {
    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
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
    this._series = series;
    this.#requestUpdate = requestUpdate;
  }

  detached(): void {
    this.#cancelPendingUpdate();
    this._series = null;
    this.#requestUpdate = null;
    this.#renderer.setPlan(null);
  }

  /** Used after removeSeries(), which invalidates credentials without a safe detach call. */
  releaseSurfaceCredentials(): void {
    this.detached();
  }

  updateAllViews(): void {
    // Prepared scene plans are published explicitly. Cursor-only and ordinary
    // chart updates must not project, scan, allocate, or replace this plan.
  }

  paneViews(): readonly PrimitivePaneView[] {
    return this.#paneViews;
  }

  publishPlan(plan: DrawingScreenDisplayList): boolean {
    if (!this.#requestUpdate || !this._series) return false;
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
}
