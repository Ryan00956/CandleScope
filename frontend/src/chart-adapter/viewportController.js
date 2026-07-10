const DEFAULT_UNLOCK_DELAY_MS = 200;
const PRIORITY = {
  fit: 10,
  restore: 20,
  compensate: 30,
};
const COMPENSATE_INTENT = "compensateShift";

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export class ViewportController {
  constructor({
    chartProvider,
    unlockDelayMs = DEFAULT_UNLOCK_DELAY_MS,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    this.chartProvider = chartProvider || (() => null);
    this.unlockDelayMs = unlockDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.userInteracting = false;
    this.unlockTimer = null;
    this.pendingIntent = null;
    this.fitSessionKeys = new Set();
  }

  getChart() {
    return this.chartProvider?.() || null;
  }

  getTimeScale() {
    return this.getChart()?.timeScale?.() || null;
  }

  isLocked() {
    return this.userInteracting;
  }

  markUserInteracting() {
    this.userInteracting = true;
    if (this.unlockTimer) this.clearTimer(this.unlockTimer);
    this.unlockTimer = this.setTimer(() => {
      this.userInteracting = false;
      this.unlockTimer = null;
      this.flushPendingIntent();
    }, this.unlockDelayMs);
  }

  dispose() {
    if (this.unlockTimer) this.clearTimer(this.unlockTimer);
    this.unlockTimer = null;
    this.pendingIntent = null;
  }

  applyIntent(name, priority, apply) {
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

  flushPendingIntent() {
    const intent = this.pendingIntent;
    this.pendingIntent = null;
    if (!intent) return false;
    return this.applyIntent(intent.name, intent.priority, intent.apply);
  }

  fitOnce(sessionKey = "default") {
    if (this.fitSessionKeys.has(sessionKey)) return false;
    this.fitSessionKeys.add(sessionKey);
    return this.applyIntent("fitOnce", PRIORITY.fit, (timeScale) => {
      timeScale.fitContent?.();
      return true;
    });
  }

  resetFit(sessionKey = null) {
    if (sessionKey == null) {
      this.fitSessionKeys.clear();
      return;
    }
    this.fitSessionKeys.delete(sessionKey);
  }

  applySessionRestore(plan, { sessionKey = "default" } = {}) {
    if (!plan) return this.fitOnce(sessionKey);
    return this.applyIntent("sessionRestore", PRIORITY.restore, (timeScale) => {
      if (Number.isFinite(plan.barSpacing)) {
        timeScale.applyOptions?.({ barSpacing: plan.barSpacing });
      }

      let restored = false;
      if (plan.mode === "anchor") {
        // plan.rightOffset carries timeScale.scrollPosition() semantics
        // (bars from the right edge). It must be restored through
        // scrollToPosition, never through the rightOffset option, which is
        // a permanent whitespace setting with a different meaning.
        if (Number.isFinite(plan.rightOffset)) {
          timeScale.scrollToPosition?.(plan.rightOffset, false);
        }
        restored = true;
      }
      if (!restored && plan.mode === "time" && plan.timeRange) {
        restored = safeCall(() => {
          timeScale.setVisibleRange(plan.timeRange);
          return true;
        }, false);
      }
      if (!restored && plan.mode === "logical" && plan.logicalRange) {
        restored = safeCall(() => {
          timeScale.setVisibleLogicalRange(plan.logicalRange);
          return true;
        }, false);
      }
      if (restored && Number.isFinite(plan.scrollPosition)) {
        timeScale.scrollToPosition?.(plan.scrollPosition, false);
      }
      if (!restored) {
        timeScale.fitContent?.();
      }
      this.fitSessionKeys.add(sessionKey);
      return true;
    });
  }

  captureAnchor(previousRows) {
    if (!previousRows?.length) return null;
    const timeScale = this.getTimeScale();
    const range = timeScale?.getVisibleLogicalRange?.();
    if (!range || !Number.isFinite(range.from)) return null;
    const index = Math.min(previousRows.length - 1, Math.max(0, Math.round(range.from)));
    const time = previousRows[index]?.time;
    if (time == null) return null;
    return { time, index };
  }

  applyAnchorShift(anchor, indexOfTime) {
    if (!anchor || typeof indexOfTime !== "function") return false;
    const newIndex = indexOfTime(anchor.time);
    if (!Number.isFinite(newIndex) || newIndex < 0) return false;
    const shift = newIndex - anchor.index;
    if (shift === 0) return true;
    this.queueShift(shift);
    return true;
  }

  queueShift(shift) {
    if (!Number.isFinite(shift) || shift === 0) return false;
    if (this.userInteracting && this.pendingIntent?.name === COMPENSATE_INTENT) {
      // Accumulate shifts queued during one interaction so none are lost.
      this.pendingIntent.shift += shift;
      return false;
    }
    const intent = {
      name: COMPENSATE_INTENT,
      priority: PRIORITY.compensate,
      shift,
    };
    intent.apply = (timeScale) => {
      const range = timeScale.getVisibleLogicalRange?.();
      if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return false;
      timeScale.setVisibleLogicalRange?.({
        from: range.from + intent.shift,
        to: range.to + intent.shift,
      });
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

  compensateInsert(addedLeft = 0) {
    return this.queueShift(Number(addedLeft) || 0);
  }
}

export function createViewportController(options = {}) {
  return new ViewportController(options);
}
