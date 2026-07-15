export interface DrawingRenderRevisionStamp {
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly surfaceGeneration: number;
  readonly dataRevision: number;
  readonly projectionRevision: number;
  readonly lineageIndexRevision: number;
  readonly viewportRevision: number;
  readonly themeRevision: number;
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly dpr: number;
}

export interface DrawingRenderInput {
  readonly stamp: DrawingRenderRevisionStamp;
}

export interface DrawingPreparedRenderPlan {
  readonly stamp: DrawingRenderRevisionStamp;
}

export interface DrawingRenderSchedulerOptions<
  TInput extends DrawingRenderInput,
  TPlan extends DrawingPreparedRenderPlan,
> {
  readInput(): TInput | null;
  buildPlan(input: TInput): TPlan | null;
  publish(plan: TPlan, reasons: readonly string[]): void;
  onDiscard?(plan: TPlan, reason: "disposed" | "stale"): void;
  onError?(error: unknown, input: TInput, reasons: readonly string[]): void;
  requestFrame?(callback: () => void): unknown;
  cancelFrame?(handle: unknown): void;
  /** Shadow-only debounce: restart pending work when a newer invalidation arrives. */
  restartPendingFrameOnInvalidate?: boolean;
}

export interface DrawingRenderScheduler {
  readonly disposed: boolean;
  readonly scheduled: boolean;
  invalidate(reason?: string): boolean;
  flushNow(): boolean;
  dispose(): void;
}

export function drawingRenderRevisionKey(stamp: DrawingRenderRevisionStamp): string {
  return [
    stamp.scopeKey,
    stamp.documentRevision,
    stamp.surfaceGeneration,
    stamp.dataRevision,
    stamp.projectionRevision,
    stamp.lineageIndexRevision,
    stamp.viewportRevision,
    stamp.themeRevision,
    stamp.widthCssPx,
    stamp.heightCssPx,
    stamp.dpr,
  ].join(":");
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

/**
 * One-frame coalescing scheduler. Phase 3 builds on the main thread, but the
 * exact revision check already enforces the same stale-result contract later
 * worker phases will use.
 */
export function createDrawingRenderScheduler<
  TInput extends DrawingRenderInput,
  TPlan extends DrawingPreparedRenderPlan,
>({
  readInput,
  buildPlan,
  publish,
  onDiscard,
  onError,
  requestFrame: scheduleFrame = defaultRequestFrame,
  cancelFrame: cancelScheduledFrame = defaultCancelFrame,
  restartPendingFrameOnInvalidate = false,
}: DrawingRenderSchedulerOptions<TInput, TPlan>): DrawingRenderScheduler {
  let disposed = false;
  let frameHandle: unknown = null;
  let running = false;
  let invalidationGeneration = 0;
  let frameScheduleGeneration = 0;
  const reasons = new Set<string>();

  const schedulePendingFrame = (): void => {
    const scheduleGeneration = ++frameScheduleGeneration;
    frameHandle = scheduleFrame(() => {
      if (scheduleGeneration !== frameScheduleGeneration) return;
      run();
    });
  };

  const run = (): boolean => {
    frameHandle = null;
    if (disposed || running) return false;
    const input = readInput();
    if (!input) {
      reasons.clear();
      return false;
    }
    const consumedReasons = Object.freeze([...reasons]);
    reasons.clear();
    const buildGeneration = invalidationGeneration;
    running = true;
    let plan: TPlan | null = null;
    try {
      plan = buildPlan(input);
    } catch (error) {
      for (const reason of consumedReasons) reasons.add(reason);
      onError?.(error, input, consumedReasons);
      return false;
    } finally {
      running = false;
    }
    if (!plan) return false;
    if (disposed) {
      onDiscard?.(plan, "disposed");
      return false;
    }
    const latest = readInput();
    const expectedKey = drawingRenderRevisionKey(input.stamp);
    if (invalidationGeneration !== buildGeneration
      || !latest
      || drawingRenderRevisionKey(latest.stamp) !== expectedKey
      || drawingRenderRevisionKey(plan.stamp) !== expectedKey) {
      onDiscard?.(plan, "stale");
      if (!disposed) scheduler.invalidate("stale-retry");
      return false;
    }
    publish(plan, consumedReasons);
    if (reasons.size > 0 && !disposed) scheduler.invalidate("follow-up");
    return true;
  };

  const scheduler: DrawingRenderScheduler = {
    get disposed() { return disposed; },
    get scheduled() { return frameHandle !== null; },
    invalidate(reason = "unspecified") {
      if (disposed) return false;
      reasons.add(reason);
      invalidationGeneration += 1;
      if (running) return true;
      if (frameHandle !== null) {
        if (!restartPendingFrameOnInvalidate) return true;
        cancelScheduledFrame(frameHandle);
        frameHandle = null;
      }
      schedulePendingFrame();
      return true;
    },
    flushNow() {
      if (disposed) return false;
      if (frameHandle !== null) {
        cancelScheduledFrame(frameHandle);
        frameScheduleGeneration += 1;
        frameHandle = null;
      }
      return run();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reasons.clear();
      if (frameHandle !== null) {
        cancelScheduledFrame(frameHandle);
        frameScheduleGeneration += 1;
        frameHandle = null;
      }
    },
  };
  return Object.freeze(scheduler);
}
