import type { IndicatorValuesMessage } from "./indicatorTypes.js";
import type {
  IndicatorDefinition,
  IndicatorSubscriptionContext,
} from "./indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { buildHostedSubscriptionSignature } from "./indicatorWsRuntime.js";

export interface IndicatorRealtimeValueUpdate {
  bar?: KlineBar;
  barTime: number;
  contextKey: string;
  indicatorId: string;
  indicatorConfigSignature: string;
  isFinal: boolean;
  payload: IndicatorValuesMessage | null;
  values: Record<string, unknown>;
}

export interface IndicatorRealtimeFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

interface IndicatorRealtimeValueBatcherOptions {
  onFlush(updates: readonly IndicatorRealtimeValueUpdate[]): void;
  isUpdateCurrent?(update: IndicatorRealtimeValueUpdate): boolean;
  scheduler?: IndicatorRealtimeFrameScheduler;
}

interface PendingUpdate {
  order: number;
  update: IndicatorRealtimeValueUpdate;
}

function defaultFrameScheduler(): IndicatorRealtimeFrameScheduler {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    };
  }
  return {
    request: (callback) => globalThis.setTimeout(callback, 16) as unknown as number,
    cancel: (handle) => globalThis.clearTimeout(handle),
  };
}

function updateKey(update: IndicatorRealtimeValueUpdate): string {
  return `${update.contextKey}\u0000${update.indicatorId}\u0000${update.indicatorConfigSignature}\u0000${update.barTime}`;
}

/** Stable wire-computation identity; runtime line hydration is intentionally excluded. */
export function buildIndicatorRealtimeConfigSignature(
  indicator: IndicatorDefinition,
  context: IndicatorSubscriptionContext,
): string {
  return buildHostedSubscriptionSignature(indicator, context);
}

function sameRecord(
  left: object | null | undefined,
  right: object | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.is(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function sameUpdate(
  left: IndicatorRealtimeValueUpdate,
  right: IndicatorRealtimeValueUpdate,
): boolean {
  return left.barTime === right.barTime
    && left.contextKey === right.contextKey
    && left.indicatorId === right.indicatorId
    && left.indicatorConfigSignature === right.indicatorConfigSignature
    && left.isFinal === right.isFinal
    && left.payload?.seq === right.payload?.seq
    && sameRecord(left.values, right.values)
    && sameRecord(left.bar, right.bar);
}

/**
 * Coalesces the high-frequency forming-bar lane to one render commit per frame.
 * Preview messages are latest-only per indicator; final updates are retained per
 * timestamp so a close followed by the next bar's preview cannot lose the close.
 */
export function createIndicatorRealtimeValueBatcher({
  onFlush,
  isUpdateCurrent,
  scheduler = defaultFrameScheduler(),
}: IndicatorRealtimeValueBatcherOptions) {
  const pending = new Map<string, PendingUpdate>();
  let frameHandle: number | null = null;
  let nextOrder = 0;

  const flush = () => {
    frameHandle = null;
    if (pending.size === 0) return;
    const updates = [...pending.values()]
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.update)
      .filter((update) => isUpdateCurrent?.(update) ?? true);
    pending.clear();
    if (updates.length === 0) return;
    onFlush(updates);
  };

  const schedule = () => {
    if (frameHandle !== null) return;
    frameHandle = scheduler.request(flush);
  };

  const enqueue = (update: IndicatorRealtimeValueUpdate): void => {
    if (!update.indicatorId || !Number.isFinite(update.barTime) || update.barTime <= 0) return;

    if (!update.isFinal) {
      for (const [key, entry] of pending) {
        const candidate = entry.update;
        if (candidate.contextKey !== update.contextKey
          || candidate.indicatorId !== update.indicatorId
          || candidate.indicatorConfigSignature !== update.indicatorConfigSignature
          || candidate.isFinal) continue;
        if (candidate.barTime > update.barTime) return;
        if (candidate.barTime < update.barTime) pending.delete(key);
      }
    }

    const key = updateKey(update);
    const previous = pending.get(key);
    // A final value is authoritative for its timestamp; a delayed preview may
    // not replace it even if it arrives later in the same browser frame.
    if (previous?.update.isFinal && !update.isFinal) return;
    if (previous && sameUpdate(previous.update, update)) return;
    pending.set(key, {
      order: previous?.order ?? nextOrder++,
      update,
    });
    schedule();
  };

  const clear = (): void => {
    pending.clear();
    if (frameHandle !== null) scheduler.cancel(frameHandle);
    frameHandle = null;
  };

  return {
    clear,
    enqueue,
    flushNow: flush,
  };
}
