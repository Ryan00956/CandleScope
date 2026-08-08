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
  /**
   * Optional lightweight freshness check for callers whose input capture is
   * materially more expensive than comparing provider revisions.
   */
  isInputCurrent?(input: TInput, plan: TPlan): boolean;
  onDiscard?(plan: TPlan, reason: "disposed" | "stale"): void;
  onError?(error: unknown, input: TInput, reasons: readonly string[]): void;
  requestFrame?(callback: () => void): unknown;
  cancelFrame?(handle: unknown): void;
  /** Shadow-only debounce: restart pending work when a newer invalidation arrives. */
  restartPendingFrameOnInvalidate?: boolean;
}

export interface DrawingRenderScheduler<TInput extends DrawingRenderInput = DrawingRenderInput> {
  readonly disposed: boolean;
  readonly scheduled: boolean;
  invalidate(reason?: string): boolean;
  flushNow(input?: TInput): boolean;
  /** Cancel pending work while keeping the scheduler reusable after reactivation. */
  suspend(): void;
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
  isInputCurrent,
  onDiscard,
  onError,
  requestFrame: scheduleFrame = defaultRequestFrame,
  cancelFrame: cancelScheduledFrame = defaultCancelFrame,
  restartPendingFrameOnInvalidate = false,
}: DrawingRenderSchedulerOptions<TInput, TPlan>): DrawingRenderScheduler<TInput> {
  let disposed = false;
  let frameHandle: unknown = null;
  let running = false;
  let invalidationGeneration = 0;
  let frameScheduleGeneration = 0;
  const reasons = new Set<string>();

  const cancelPendingWork = (): void => {
    reasons.clear();
    frameScheduleGeneration += 1;
    if (frameHandle !== null) cancelScheduledFrame(frameHandle);
    frameHandle = null;
  };

  const schedulePendingFrame = (): void => {
    const scheduleGeneration = ++frameScheduleGeneration;
    frameHandle = scheduleFrame(() => {
      if (scheduleGeneration !== frameScheduleGeneration) return;
      run();
    });
  };

  const run = (prefetchedInput?: TInput): boolean => {
    frameHandle = null;
    if (disposed || running) return false;
    const input = prefetchedInput ?? readInput();
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
    if (!plan) {
      // An atomic build may deliberately fail closed after an invalidation
      // raised from inside projection. `invalidate()` cannot schedule while
      // `running` is true, so preserve that follow-up instead of stranding it.
      if (reasons.size > 0 && !disposed) scheduler.invalidate("follow-up");
      return false;
    }
    if (disposed) {
      onDiscard?.(plan, "disposed");
      return false;
    }
    const expectedKey = drawingRenderRevisionKey(input.stamp);
    const inputCurrent = isInputCurrent
      ? isInputCurrent(input, plan)
      : (() => {
          const latest = readInput();
          return Boolean(latest && drawingRenderRevisionKey(latest.stamp) === expectedKey);
        })();
    if (invalidationGeneration !== buildGeneration
      || !inputCurrent
      || drawingRenderRevisionKey(plan.stamp) !== expectedKey) {
      onDiscard?.(plan, "stale");
      if (!disposed) scheduler.invalidate("stale-retry");
      return false;
    }
    publish(plan, consumedReasons);
    if (reasons.size > 0 && !disposed) scheduler.invalidate("follow-up");
    return true;
  };

  const scheduler: DrawingRenderScheduler<TInput> = {
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
    flushNow(input) {
      if (disposed) return false;
      if (frameHandle !== null) {
        cancelScheduledFrame(frameHandle);
        frameScheduleGeneration += 1;
        frameHandle = null;
      }
      return run(input);
    },
    suspend() {
      if (disposed) return;
      cancelPendingWork();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingWork();
    },
  };
  return Object.freeze(scheduler);
}
