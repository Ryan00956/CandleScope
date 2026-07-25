import { clearIndicatorLineData } from "./indicatorPayloadRuntime.js";
import type {
  IndicatorCacheResult,
  IndicatorDefinition,
} from "./indicatorTypes.js";

export type IndicatorHydrationContentVersion = number | string;

export interface IndicatorHydrationIdentity {
  lifecycleKey: string;
  contentSignature: string;
  contentVersion: IndicatorHydrationContentVersion;
}

export interface IndicatorHydrationTaskScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface IndicatorHydrationRequest extends IndicatorHydrationIdentity {
  isCurrent?: (identity: IndicatorHydrationIdentity) => boolean;
  run(identity: IndicatorHydrationIdentity): void;
}

export interface IndicatorHydrationScheduleResult {
  key: string;
  status: "deduplicated" | "disposed" | "scheduled";
}

interface PendingHydration {
  epoch: number;
  handle: number;
  identity: IndicatorHydrationIdentity;
  key: string;
  request: IndicatorHydrationRequest;
}

function defaultTaskScheduler(): IndicatorHydrationTaskScheduler {
  return {
    request: (callback) => globalThis.setTimeout(callback, 0) as unknown as number,
    cancel: (handle) => globalThis.clearTimeout(handle),
  };
}

export function buildIndicatorHydrationKey({
  contentSignature,
  contentVersion,
  lifecycleKey,
}: IndicatorHydrationIdentity): string {
  return JSON.stringify([lifecycleKey, contentSignature, contentVersion]);
}

/**
 * Publishes cache-owned line arrays without cloning. Missing entries are
 * cleared only at an explicit ownership boundary so deferred auxiliary work
 * can never retain lines from the previous chart context. Explicit-local
 * terminal errors survive a cache miss: their completed job owns no success
 * snapshot, and clearing the error would create a silent empty terminal state.
 */
export function hydrateIndicatorDefinitionsFromCache(
  indicators: IndicatorDefinition[] = [],
  entries: IndicatorCacheResult[] = [],
  { clearMissing = true }: { clearMissing?: boolean } = {},
): IndicatorDefinition[] {
  const cachedById = new Map(entries.map((entry) => [entry.indicatorId, entry]));
  let changed = false;
  const next = indicators.map((indicator) => {
    const cached = cachedById.get(indicator.id);
    if (cached) {
      const schema = cached.schema.length > 0 ? cached.schema : indicator.paramSchema;
      if (
        indicator.lines === cached.normalized.lines
        && indicator.error === null
        && indicator.paramSchema === schema
      ) return indicator;
      changed = true;
      return {
        ...indicator,
        lines: cached.normalized.lines,
        error: null,
        ...(cached.schema.length > 0 ? { paramSchema: cached.schema } : {}),
      };
    }
    if (!clearMissing) return indicator;
    const lines = indicator.lines || [];
    const hasRuntimeData = lines.some((line) => (
      (line.data?.length || 0) > 0 || (line.colorData?.length || 0) > 0
    ));
    const preserveError = indicator.executionTarget === "local";
    if (!hasRuntimeData && (preserveError || indicator.error === null)) return indicator;
    changed = true;
    return {
      ...indicator,
      lines: hasRuntimeData ? clearIndicatorLineData(lines) : lines,
      ...(preserveError ? {} : { error: null }),
    };
  });
  return changed ? next : indicators;
}

/**
 * Defers cache hydration out of the synchronous chart-publication path. Only
 * one identity is pending at a time: a newer lifecycle or content generation
 * cancels and fences the older callback, while repeat scheduling of the same
 * identity updates its closure without requesting another deferred task.
 */
export function createIndicatorHydrationScheduler({
  scheduler = defaultTaskScheduler(),
}: { scheduler?: IndicatorHydrationTaskScheduler } = {}) {
  let activeLifecycleKey = "";
  let currentKey: string | null = null;
  let disposed = false;
  let epoch = 0;
  let pending: PendingHydration | null = null;

  function cancelPending(): void {
    const task = pending;
    pending = null;
    if (task) scheduler.cancel(task.handle);
  }

  function cancel(): void {
    if (disposed) return;
    currentKey = null;
    epoch += 1;
    cancelPending();
  }

  function activate(lifecycleKey: string): number {
    if (disposed || lifecycleKey === activeLifecycleKey) return epoch;
    activeLifecycleKey = lifecycleKey;
    currentKey = null;
    epoch += 1;
    cancelPending();
    return epoch;
  }

  function isCurrent(identity: IndicatorHydrationIdentity): boolean {
    return !disposed
      && identity.lifecycleKey === activeLifecycleKey
      && buildIndicatorHydrationKey(identity) === currentKey;
  }

  function schedule(request: IndicatorHydrationRequest): IndicatorHydrationScheduleResult {
    const identity: IndicatorHydrationIdentity = {
      lifecycleKey: request.lifecycleKey,
      contentSignature: request.contentSignature,
      contentVersion: request.contentVersion,
    };
    const key = buildIndicatorHydrationKey(identity);
    if (disposed) return { key, status: "disposed" };

    activate(identity.lifecycleKey);
    currentKey = key;
    if (pending?.key === key) {
      pending.identity = identity;
      pending.request = request;
      return { key, status: "deduplicated" };
    }

    cancelPending();
    const taskEpoch = epoch;
    const task: PendingHydration = {
      epoch: taskEpoch,
      handle: 0,
      identity,
      key,
      request,
    };
    pending = task;
    task.handle = scheduler.request(() => {
      const isPendingTask = pending === task;
      if (isPendingTask) pending = null;
      if (
        !isPendingTask
        || disposed
        || task.epoch !== epoch
        || task.key !== currentKey
        || task.identity.lifecycleKey !== activeLifecycleKey
        || (task.request.isCurrent && !task.request.isCurrent(task.identity))
      ) return;
      task.request.run(task.identity);
    });
    return { key, status: "scheduled" };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    activeLifecycleKey = "";
    currentKey = null;
    epoch += 1;
    cancelPending();
  }

  function snapshot() {
    return {
      activeLifecycleKey,
      currentKey,
      disposed,
      epoch,
      pending: pending !== null,
    };
  }

  return {
    activate,
    cancel,
    dispose,
    isCurrent,
    schedule,
    snapshot,
  };
}
