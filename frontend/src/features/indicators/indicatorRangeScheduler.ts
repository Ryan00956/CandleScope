import {
  mergeIndicatorRangeSegments,
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
  subtractIndicatorRange,
} from "./indicatorRangeCoverage.js";
import { isIndicatorRecord } from "./indicatorContracts.js";
import type {
  IndicatorRange,
  IndicatorRangeSegment,
  IndicatorRevision,
} from "./indicatorTypes.js";

interface IndicatorRangeTarget {
  key?: string;
  id?: string;
}

function indicatorRangeTargetKey(target: IndicatorRangeTarget): string {
  return String(target.key || target.id || "");
}

interface SchedulerExecutionContext<TTarget> {
  epoch: number;
  range: IndicatorRange;
  reason: string;
  signal: AbortSignal;
  target: TTarget;
}

interface SchedulerApplyContext<TTarget, TResult> extends Omit<SchedulerExecutionContext<TTarget>, "signal"> {
  result: TResult;
}

interface SchedulerSettlementDetail<TTarget, TResult> {
  aborted?: boolean;
  cacheHit?: boolean;
  coalesced?: boolean;
  error?: unknown;
  parts?: number;
  range?: IndicatorRange;
  ranges?: IndicatorRange[];
  result?: TResult;
  stale?: boolean;
  target?: TTarget;
}

type SchedulerSettlementListener<TTarget, TResult> = (
  ok: boolean,
  detail: SchedulerSettlementDetail<TTarget, TResult>,
) => void;

interface EnsureCoverageOptions<TTarget, TResult> {
  apply?: (context: SchedulerApplyContext<TTarget, TResult>) => void | Promise<void>;
  execute?: (context: SchedulerExecutionContext<TTarget>) => TResult | Promise<TResult>;
  getCoveredSegments?: (target: TTarget) => readonly IndicatorRangeSegment[];
  onError?: (error: unknown, context: Pick<SchedulerExecutionContext<TTarget>, "range" | "reason" | "target">) => void;
  onSettled?: SchedulerSettlementListener<TTarget, TResult>;
  range?: unknown;
  reason?: string;
  revision?: unknown;
  sessionKey?: unknown;
  step?: unknown;
  targets?: readonly TTarget[];
}

interface SchedulerEntry<TTarget, TResult> {
  apply?: EnsureCoverageOptions<TTarget, TResult>["apply"];
  epoch: number;
  execute: NonNullable<EnsureCoverageOptions<TTarget, TResult>["execute"]>;
  getCoveredSegments?: EnsureCoverageOptions<TTarget, TResult>["getCoveredSegments"];
  listeners: Set<SchedulerSettlementListener<TTarget, TResult>>;
  onError?: EnsureCoverageOptions<TTarget, TResult>["onError"];
  ranges: IndicatorRange[];
  reasons: Set<string>;
  revision: IndicatorRevision | null;
  sessionKey: string;
  step: number;
  target: TTarget;
  targetKey: string;
}

interface SchedulerTaskResult<TResult> {
  applied: boolean;
  stale?: boolean;
  aborted?: boolean;
  error?: unknown;
  result?: TResult;
}

interface SchedulerTask<TTarget, TResult> {
  controller: AbortController;
  epoch: number;
  listeners: Set<SchedulerSettlementListener<TTarget, TResult>>;
  range: IndicatorRange;
  revision: IndicatorRevision | null;
  revisionSignature: string;
  sessionKey: string;
  targetKey: string;
  promise: Promise<SchedulerTaskResult<TResult>>;
}

function positiveStep(value: unknown): number {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 1;
}

function isAbortError(error: unknown): boolean {
  return isIndicatorRecord(error)
    && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

function selectReason(reasons: ReadonlySet<string>): string {
  const priority = [
    "initial-visible",
    "recomputed",
    "backfill-completed",
    "window-delta",
    "auto-right-catchup",
    "auto-catchup",
    "range",
  ];
  for (const reason of priority) {
    if (reasons.has(reason)) return reason;
  }
  return reasons.values().next().value || "range";
}

function revisionSignature(revisionInput: unknown): string {
  const revision = normalizeIndicatorRevision(revisionInput);
  if (!revision) return "legacy";
  return [
    revision.serverEpoch || "",
    revision.correctionRevision || "",
    revision.token || "",
    revision.historyInvalid ? "invalid" : "valid",
  ].join(":");
}

export function createIndicatorRangeScheduler<
  TTarget extends IndicatorRangeTarget = IndicatorRangeTarget,
  TResult = unknown,
>() {
  let sessionKey: string | null = null;
  let epoch = 0;
  let flushQueued = false;
  const pending = new Map<string, SchedulerEntry<TTarget, TResult>>();
  const inFlight = new Map<string, SchedulerTask<TTarget, TResult>>();
  const latestRevisionByTarget = new Map<string, string>();

  function setSession(nextSessionKey: unknown): number {
    const normalized = String(nextSessionKey || "");
    if (normalized === sessionKey) return epoch;
    sessionKey = normalized;
    epoch += 1;
    pending.clear();
    latestRevisionByTarget.clear();
    for (const task of inFlight.values()) task.controller.abort();
    inFlight.clear();
    return epoch;
  }

  function notify(
    listeners: ReadonlySet<SchedulerSettlementListener<TTarget, TResult>>,
    ok: boolean,
    detail: SchedulerSettlementDetail<TTarget, TResult>,
  ): void {
    for (const listener of listeners) {
      try {
        listener(ok, detail);
      } catch {
        // A consumer callback must not break scheduler cleanup.
      }
    }
  }

  function activeTasksFor(targetKey: string, revision: unknown): Array<SchedulerTask<TTarget, TResult>> {
    return Array.from(inFlight.values())
      .filter((task) => (
        task.sessionKey === sessionKey
        && task.targetKey === targetKey
        && task.revisionSignature === revisionSignature(revision)
      ));
  }

  function activeSegmentsFor(tasks: Array<SchedulerTask<TTarget, TResult>>): IndicatorRangeSegment[] {
    return tasks.map((task) => ({
      ...task.range,
      ...(task.revision ? { revision: task.revision } : {}),
    }));
  }

  function rangesOverlap(left: IndicatorRange, right: IndicatorRange): boolean {
    return left.start <= right.end && right.start <= left.end;
  }

  function attachSettlementBarrier(
    tasks: Array<SchedulerTask<TTarget, TResult>>,
    listeners: ReadonlySet<SchedulerSettlementListener<TTarget, TResult>>,
    detailBase: SchedulerSettlementDetail<TTarget, TResult>,
  ): void {
    if (!tasks.length || !listeners.size) return;
    let remaining = tasks.length;
    let allOk = true;
    let lastDetail: SchedulerSettlementDetail<TTarget, TResult> = {};
    const settle: SchedulerSettlementListener<TTarget, TResult> = (ok, detail = {}) => {
      allOk = allOk && ok;
      lastDetail = detail;
      remaining -= 1;
      if (remaining === 0) {
        notify(listeners, allOk, { ...lastDetail, ...detailBase, parts: tasks.length });
      }
    };
    for (const task of tasks) task.listeners.add(settle);
  }

  function launch(
    entry: SchedulerEntry<TTarget, TResult>,
    range: IndicatorRange,
    reason: string,
    taskEpoch: number,
  ): SchedulerTask<TTarget, TResult> {
    const taskRevisionSignature = revisionSignature(entry.revision);
    const taskKey = `${entry.targetKey}|${taskRevisionSignature}|${range.start}|${range.end}`;
    const existingTask = inFlight.get(taskKey);
    if (existingTask) return existingTask;
    const controller = new AbortController();
    const task: SchedulerTask<TTarget, TResult> = {
      controller,
      epoch: taskEpoch,
      listeners: new Set<SchedulerSettlementListener<TTarget, TResult>>(),
      range,
      revision: entry.revision,
      revisionSignature: taskRevisionSignature,
      sessionKey: sessionKey ?? "",
      targetKey: entry.targetKey,
      promise: Promise.resolve({ applied: false }),
    };
    task.promise = Promise.resolve().then(() => entry.execute({
      epoch: taskEpoch,
      range,
      reason,
      signal: controller.signal,
      target: entry.target,
    })).then(async (result): Promise<SchedulerTaskResult<TResult>> => {
      const latestRevision = latestRevisionByTarget.get(`${sessionKey ?? ""}|${entry.targetKey}`);
      if (
        controller.signal.aborted
        || taskEpoch !== epoch
        || sessionKey !== task.sessionKey
        || latestRevision !== task.revisionSignature
      ) {
        notify(task.listeners, false, {
          aborted: controller.signal.aborted,
          range,
          stale: true,
          target: entry.target,
        });
        return { applied: false, stale: true };
      }
      await entry.apply?.({
        epoch: taskEpoch,
        range,
        reason,
        result,
        target: entry.target,
      });
      notify(task.listeners, true, { range, result, target: entry.target });
      return { applied: true, result };
    }).catch((error: unknown): SchedulerTaskResult<TResult> => {
      const aborted = controller.signal.aborted || isAbortError(error) || taskEpoch !== epoch;
      if (!aborted) entry.onError?.(error, { range, reason, target: entry.target });
      notify(task.listeners, false, {
        aborted,
        error,
        range,
        stale: taskEpoch !== epoch,
        target: entry.target,
      });
      return { applied: false, aborted, error };
    }).finally(() => {
      if (inFlight.get(taskKey) === task) inFlight.delete(taskKey);
    });
    inFlight.set(taskKey, task);
    return task;
  }

  function flush(): void {
    flushQueued = false;
    const batch = Array.from(pending.values());
    pending.clear();
    for (const entry of batch) {
      if (entry.epoch !== epoch || entry.sessionKey !== sessionKey) continue;
      const step = positiveStep(entry.step);
      const desiredRanges = mergeIndicatorRangeSegments(entry.ranges, { step });
      const cachedSegments = entry.getCoveredSegments?.(entry.target) || [];
      const activeTasks = activeTasksFor(entry.targetKey, entry.revision);
      const inFlightSegments = activeSegmentsFor(activeTasks);
      const neededBeyondCache = mergeIndicatorRangeSegments(
        desiredRanges.flatMap((range) => subtractIndicatorRange(
          range,
          cachedSegments,
          { step, revision: entry.revision },
        )),
        { step },
      );
      const reason = selectReason(entry.reasons);
      if (neededBeyondCache.length === 0) {
        notify(entry.listeners, true, {
          cacheHit: true,
          coalesced: false,
          ranges: desiredRanges,
          target: entry.target,
        });
        continue;
      }
      const relevantActiveTasks = activeTasks.filter((task) => (
        neededBeyondCache.some((range) => rangesOverlap(range, task.range))
      ));
      const missing = mergeIndicatorRangeSegments(
        neededBeyondCache.flatMap((range) => subtractIndicatorRange(
          range,
          inFlightSegments,
          { step, revision: entry.revision },
        )),
        { step },
      );
      const requiredTasks = [...relevantActiveTasks];
      for (const range of missing) {
        requiredTasks.push(launch(entry, range, reason, entry.epoch));
      }
      attachSettlementBarrier(
        Array.from(new Set(requiredTasks)),
        entry.listeners,
        {
          cacheHit: false,
          coalesced: relevantActiveTasks.length > 0,
          ranges: desiredRanges,
          target: entry.target,
        },
      );
    }
  }

  function scheduleFlush(): void {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(flush);
  }

  function ensureCoverage({
    apply,
    execute,
    getCoveredSegments,
    onError,
    onSettled,
    range: rangeInput,
    reason = "range",
    revision = null,
    sessionKey: nextSessionKey,
    step = 1,
    targets,
  }: EnsureCoverageOptions<TTarget, TResult> = {}): { accepted: boolean; epoch: number; queued: number } {
    const range = normalizeIndicatorRange(rangeInput);
    const normalizedTargets: readonly TTarget[] = Array.isArray(targets) ? targets : [];
    if (
      !range ||
      typeof execute !== "function" ||
      normalizedTargets.length === 0
    ) {
      return { accepted: false, epoch, queued: 0 };
    }
    const nextEpoch = setSession(nextSessionKey);
    const normalizedRevision = normalizeIndicatorRevision(revision);
    let queued = 0;
    for (const target of normalizedTargets) {
      const targetKey = indicatorRangeTargetKey(target);
      if (!targetKey) continue;
      const pendingKey = `${sessionKey}|${targetKey}`;
      latestRevisionByTarget.set(pendingKey, revisionSignature(normalizedRevision));
      let entry = pending.get(pendingKey);
      if (!entry) {
        entry = {
          apply,
          epoch: nextEpoch,
          execute,
          getCoveredSegments,
          listeners: new Set<SchedulerSettlementListener<TTarget, TResult>>(),
          onError,
          ranges: [],
          reasons: new Set(),
          revision: normalizedRevision,
          sessionKey: sessionKey ?? "",
          step: positiveStep(step),
          target,
          targetKey,
        };
        pending.set(pendingKey, entry);
      }
      entry.ranges.push(range);
      entry.reasons.add(reason);
      if (typeof onSettled === "function") entry.listeners.add(onSettled);
      queued += 1;
    }
    if (queued) scheduleFlush();
    return { accepted: queued > 0, epoch: nextEpoch, queued };
  }

  async function drain(): Promise<void> {
    if (flushQueued) await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    while (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight.values()).map((task) => task.promise));
    }
  }

  function dispose(): void {
    sessionKey = null;
    epoch += 1;
    pending.clear();
    latestRevisionByTarget.clear();
    for (const task of inFlight.values()) task.controller.abort();
    inFlight.clear();
  }

  function snapshot(): {
    epoch: number;
    inFlight: Array<{ range: IndicatorRange; sessionKey: string; targetKey: string }>;
    pending: number;
    sessionKey: string | null;
  } {
    return {
      epoch,
      inFlight: Array.from(inFlight.values()).map((task) => ({
        range: { ...task.range },
        sessionKey: task.sessionKey,
        targetKey: task.targetKey,
      })),
      pending: pending.size,
      sessionKey,
    };
  }

  return {
    dispose,
    drain,
    ensureCoverage,
    setSession,
    snapshot,
  };
}
