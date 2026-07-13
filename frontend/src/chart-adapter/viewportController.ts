import type {
  IChartApiBase,
  ITimeScaleApi,
  Logical,
  LogicalRange,
} from "lightweight-charts";
import type {
  ChartSeriesInputRow,
  ChartTime,
  ViewportAnchor,
  ViewportLogicalRange,
  ViewportRestorePlan,
} from "./chartAdapterTypes.js";

const DEFAULT_UNLOCK_DELAY_MS = 200;
const PRIORITY = {
  fit: 10,
  restore: 20,
  compensate: 30,
};
const COMPENSATE_INTENT = "compensateShift";
const LOGICAL_SHIFT_EPSILON = 1e-7;

type AdapterChart = IChartApiBase<ChartTime>;
type AdapterTimeScale = ITimeScaleApi<ChartTime>;
type TimerHandle = ReturnType<typeof setTimeout>;

interface ViewportIntent {
  name: string;
  priority: number;
  shift?: number;
  apply: (timeScale: AdapterTimeScale, chart: AdapterChart | null) => unknown;
}

export interface ViewportControllerOptions {
  chartProvider?: (() => AdapterChart | null) | null;
  contentLogicalRangeProvider?: (() => ViewportLogicalRange | null) | null;
  unlockDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

function safeCall<TResult>(fn: () => TResult, fallback: TResult): TResult {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toLogicalRange(range: ViewportLogicalRange): LogicalRange {
  return {
    from: range.from as Logical,
    to: range.to as Logical,
  };
}

export class ViewportController {
  private readonly chartProvider: () => AdapterChart | null;
  private readonly contentLogicalRangeProvider: (() => ViewportLogicalRange | null) | null;
  private readonly unlockDelayMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private userInteracting: boolean;
  private unlockTimer: TimerHandle | null;
  private pendingIntent: ViewportIntent | null;
  private readonly fitSessionKeys: Set<string>;

  constructor({
    chartProvider,
    contentLogicalRangeProvider = null,
    unlockDelayMs = DEFAULT_UNLOCK_DELAY_MS,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: ViewportControllerOptions = {}) {
    this.chartProvider = chartProvider || (() => null);
    this.contentLogicalRangeProvider = contentLogicalRangeProvider;
    this.unlockDelayMs = unlockDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.userInteracting = false;
    this.unlockTimer = null;
    this.pendingIntent = null;
    this.fitSessionKeys = new Set();
  }

  getChart(): AdapterChart | null {
    return this.chartProvider?.() || null;
  }

  getTimeScale(): AdapterTimeScale | null {
    return this.getChart()?.timeScale?.() || null;
  }

  isLocked(): boolean {
    return this.userInteracting;
  }

  markUserInteracting(): void {
    this.userInteracting = true;
    if (this.unlockTimer) this.clearTimer(this.unlockTimer);
    this.unlockTimer = this.setTimer(() => {
      this.userInteracting = false;
      this.unlockTimer = null;
      this.flushPendingIntent();
    }, this.unlockDelayMs);
  }

  dispose(): void {
    this.resetSession();
  }

  resetSession(): void {
    if (this.unlockTimer != null) this.clearTimer(this.unlockTimer);
    this.unlockTimer = null;
    this.userInteracting = false;
    this.pendingIntent = null;
    this.fitSessionKeys.clear();
  }

  applyIntent(
    name: string,
    priority: number,
    apply: ViewportIntent["apply"],
  ): boolean {
    if (this.userInteracting) {
      if (!this.pendingIntent || priority >= this.pendingIntent.priority) {
        this.pendingIntent = { name, priority, apply };
      }
      return false;
    }
    const timeScale = this.getTimeScale();
    if (!timeScale) return false;
    return Boolean(apply(timeScale, this.getChart()));
  }

  flushPendingIntent(): boolean {
    const intent = this.pendingIntent;
    this.pendingIntent = null;
    if (!intent) return false;
    return this.applyIntent(intent.name, intent.priority, intent.apply);
  }

  fitSemanticContent(timeScale: AdapterTimeScale): boolean {
    const contentRangeProvider = this.contentLogicalRangeProvider;
    const contentRange = contentRangeProvider
      ? safeCall(() => contentRangeProvider(), null)
      : null;
    if (finiteNumber(contentRange?.from)
      && finiteNumber(contentRange?.to)
      && contentRange.from <= contentRange.to
      && typeof timeScale?.setVisibleLogicalRange === "function") {
      const configuredRightOffset = safeCall(
        () => Number(timeScale.options?.().rightOffset),
        0,
      );
      const rightOffset = Number.isFinite(configuredRightOffset)
        ? Math.max(0, configuredRightOffset)
        : 0;
      const to = Math.max(contentRange.from + 1, contentRange.to + rightOffset);
      timeScale.setVisibleLogicalRange(toLogicalRange({ from: contentRange.from, to }));
      return true;
    }
    timeScale?.fitContent?.();
    return true;
  }

  fitOnce(sessionKey = "default"): boolean {
    if (this.fitSessionKeys.has(sessionKey)) return false;
    this.fitSessionKeys.add(sessionKey);
    return this.applyIntent("fitOnce", PRIORITY.fit, (timeScale) => {
      return this.fitSemanticContent(timeScale);
    });
  }

  resetFit(sessionKey: string | null = null): void {
    if (sessionKey == null) {
      this.fitSessionKeys.clear();
      return;
    }
    this.fitSessionKeys.delete(sessionKey);
  }

  applySessionRestore(
    plan: ViewportRestorePlan | null | undefined,
    { sessionKey = "default" }: { sessionKey?: string } = {},
  ): boolean {
    if (!plan) return this.fitOnce(sessionKey);
    return this.applyIntent("sessionRestore", PRIORITY.restore, (timeScale) => {
      if (finiteNumber(plan.barSpacing)) {
        timeScale.applyOptions?.({ barSpacing: plan.barSpacing });
      }

      let restored = false;
      if (plan.mode === "anchor") {
        // plan.rightOffset carries timeScale.scrollPosition() semantics
        // (bars from the right edge). It must be restored through
        // scrollToPosition, never through the rightOffset option, which is
        // a permanent whitespace setting with a different meaning.
        if (finiteNumber(plan.rightOffset)) {
          timeScale.scrollToPosition?.(plan.rightOffset, false);
        }
        restored = true;
      }
      const timeRange = plan.timeRange;
      if (!restored && plan.mode === "time" && timeRange) {
        restored = safeCall(() => {
          timeScale.setVisibleRange(timeRange);
          return true;
        }, false);
      }
      const logicalRange = plan.logicalRange;
      if (!restored && plan.mode === "logical" && logicalRange) {
        restored = safeCall(() => {
          timeScale.setVisibleLogicalRange(toLogicalRange(logicalRange));
          return true;
        }, false);
      }
      if (restored && finiteNumber(plan.scrollPosition)) {
        timeScale.scrollToPosition?.(plan.scrollPosition, false);
      }
      if (!restored) {
        this.fitSemanticContent(timeScale);
      }
      this.fitSessionKeys.add(sessionKey);
      return true;
    });
  }

  restoreProjectionRange(
    logicalRange: ViewportLogicalRange | null | undefined,
    { barSpacing = null }: { barSpacing?: number | null } = {},
  ): boolean {
    return this.applyIntent("projectionRestore", PRIORITY.restore, (timeScale) => {
      if (finiteNumber(barSpacing)) {
        timeScale.applyOptions?.({ barSpacing });
      }
      if (finiteNumber(logicalRange?.from) && finiteNumber(logicalRange?.to)) {
        timeScale.setVisibleLogicalRange?.(toLogicalRange(logicalRange));
        return true;
      }
      return this.fitSemanticContent(timeScale);
    });
  }

  captureAnchor(previousRows: ChartSeriesInputRow[]): ViewportAnchor | null {
    if (!previousRows?.length) return null;
    const timeScale = this.getTimeScale();
    const range = safeCall(() => timeScale?.getVisibleLogicalRange?.(), null);
    if (!range || !Number.isFinite(range.from)) return null;
    const index = Math.min(previousRows.length - 1, Math.max(0, Math.round(range.from)));
    const time = previousRows[index]?.time;
    if (time == null) return null;
    return {
      time,
      index,
      screenOffset: index - range.from,
    };
  }

  applyAnchorShift(
    anchor: ViewportAnchor | null | undefined,
    indexOfTime: ((time: ChartTime) => number) | null | undefined,
  ): boolean {
    if (!anchor || typeof indexOfTime !== "function") return false;
    const newIndex = indexOfTime(anchor.time);
    if (
      !Number.isFinite(newIndex)
      || newIndex < 0
      || !Number.isFinite(anchor.screenOffset)
    ) return false;

    const timeScale = this.getTimeScale();
    const currentRange = safeCall(() => timeScale?.getVisibleLogicalRange?.(), null);
    if (
      !currentRange
      || !Number.isFinite(currentRange.from)
      || !Number.isFinite(currentRange.to)
    ) return false;

    // Lightweight Charts rebases the logical range automatically for a pure
    // prepend. Preserve the anchor's screen offset and apply only any residual
    // shift left after setData (for example, a mid-window merge). This avoids
    // double-shifting prepends while keeping structural updates pixel-stable.
    const desiredFrom = newIndex - anchor.screenOffset;
    return this.applyLogicalShiftNow(desiredFrom - currentRange.from, currentRange);
  }

  applyLogicalShiftNow(shift: number, currentRange: LogicalRange | null = null): boolean {
    if (!Number.isFinite(shift)) return false;
    if (Math.abs(shift) <= LOGICAL_SHIFT_EPSILON) return true;

    const timeScale = this.getTimeScale();
    const range = currentRange || safeCall(() => timeScale?.getVisibleLogicalRange?.(), null);
    if (
      !timeScale
      || !range
      || !Number.isFinite(range.from)
      || !Number.isFinite(range.to)
    ) return false;

    // Structural compensation is coordinate rebasing, not an independent
    // navigation intent. It must happen synchronously with setData even while
    // the user-interaction lock is active, otherwise one wrong frame is shown
    // and the queued correction becomes a visible jump.
    return safeCall(() => {
      timeScale.setVisibleLogicalRange?.(toLogicalRange({
        from: range.from + shift,
        to: range.to + shift,
      }));
      return true;
    }, false);
  }

  queueShift(shift: number): boolean {
    if (!Number.isFinite(shift) || shift === 0) return false;
    if (this.userInteracting && this.pendingIntent?.name === COMPENSATE_INTENT) {
      // Accumulate shifts queued during one interaction so none are lost.
      this.pendingIntent.shift = (this.pendingIntent.shift || 0) + shift;
      return false;
    }
    const intent: ViewportIntent = {
      name: COMPENSATE_INTENT,
      priority: PRIORITY.compensate,
      shift,
      apply: () => false,
    };
    intent.apply = (timeScale) => {
      const range = safeCall(() => timeScale.getVisibleLogicalRange?.(), null);
      if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return false;
      const intentShift = intent.shift || 0;
      timeScale.setVisibleLogicalRange?.(toLogicalRange({
        from: range.from + intentShift,
        to: range.to + intentShift,
      }));
      return true;
    };
    if (this.userInteracting) {
      if (!this.pendingIntent || intent.priority >= this.pendingIntent.priority) {
        this.pendingIntent = intent;
      }
      return false;
    }
    const timeScale = this.getTimeScale();
    if (!timeScale) return false;
    return Boolean(intent.apply(timeScale, this.getChart()));
  }

  compensateInsert(addedLeft = 0): boolean {
    return this.applyLogicalShiftNow(Number(addedLeft) || 0);
  }
}

export function createViewportController(
  options: ViewportControllerOptions = {},
): ViewportController {
  return new ViewportController(options);
}
