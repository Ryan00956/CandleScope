import {
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
} from "./indicatorRangeCoverage.js";
import type { IndicatorRange, IndicatorRevision } from "./indicatorTypes.js";

export interface IndicatorRangeRefreshSignatureOptions {
  seriesKey: unknown;
  requestScope?: unknown;
  requestGeneration?: unknown;
  targetKey: unknown;
  requestRange: unknown;
  invalidateRange?: unknown;
  cascadeRight?: boolean;
  revision?: unknown;
}

export interface CompletedIndicatorRangeRequestLedger {
  clear(): void;
  forget(signature: string): void;
  has(signature: string): boolean;
  remember(signature: string): void;
  readonly size: number;
}

export interface IndicatorInitialHydrationSignatureOptions {
  seriesKey: unknown;
  requestScope?: unknown;
  requestGeneration?: unknown;
  targetKeys: Iterable<unknown>;
}

export interface IndicatorInitialHydrationGate {
  begin(signature: string): boolean;
  clear(): void;
  complete(signature: string): void;
  isCompleted(signature: string): boolean;
  isPending(signature: string): boolean;
  release(signature: string): void;
  releasePending(): number;
}

interface DeferredIndicatorHistoryEvent {
  id?: unknown;
  start?: unknown;
  end?: unknown;
}

export interface DeferredIndicatorRangeWaitOptions {
  seriesKey: unknown;
  targetKey: unknown;
  range: unknown;
  revision?: unknown;
  afterEventId?: unknown;
}

export interface DeferredIndicatorRangeWaitRegistry {
  block(options: DeferredIndicatorRangeWaitOptions): boolean;
  blocks(options: DeferredIndicatorRangeWaitOptions): boolean;
  clear(): void;
  releaseForEvents(seriesKey: unknown, events: Iterable<DeferredIndicatorHistoryEvent>): number;
  releaseForRevision(seriesKey: unknown, revision: unknown): number;
  readonly size: number;
}

export interface DeferredIndicatorRangeIntent<TPayload = unknown> {
  fingerprint: string;
  key: string;
  payload: TPayload;
  range: IndicatorRange;
  revision?: unknown;
  seriesKey: string;
}

export interface DeferredIndicatorRangeIntentAttempt<TPayload = unknown> {
  intent: DeferredIndicatorRangeIntent<TPayload>;
  version: number;
}

export interface DeferredIndicatorRangeIntentRegistry<TPayload = unknown> {
  begin(key: string, expectedVersion?: number): DeferredIndicatorRangeIntentAttempt<TPayload> | null;
  clear(): void;
  complete(key: string, version: number): boolean;
  defer(
    key: string,
    version: number,
    options: { afterEventId?: unknown; revision?: unknown },
  ): boolean;
  fail(key: string, version: number): boolean;
  has(key: string, fingerprint?: string): boolean;
  remember(intent: DeferredIndicatorRangeIntent<TPayload>): number | null;
  readyForSeries(
    seriesKey: unknown,
  ): DeferredIndicatorRangeIntentAttempt<TPayload>[];
  release(key: string, version: number): boolean;
  releaseForEvents(
    seriesKey: unknown,
    events: Iterable<DeferredIndicatorHistoryEvent>,
  ): DeferredIndicatorRangeIntentAttempt<TPayload>[];
  releaseForRevision(
    seriesKey: unknown,
    revision: unknown,
  ): DeferredIndicatorRangeIntentAttempt<TPayload>[];
  readonly size: number;
}

type IndicatorRetryTimer = ReturnType<typeof setTimeout>;

export interface KeyedIndicatorRetryTimers {
  cancelAll(): void;
  cancel(key: string): void;
  has(key: string): boolean;
  schedule(key: string, callback: () => void, delayMs: number): void;
  readonly size: number;
}

export function createKeyedIndicatorRetryTimers({
  cancelTimer = (timer: IndicatorRetryTimer) => clearTimeout(timer),
  setTimer = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
}: {
  cancelTimer?: (timer: IndicatorRetryTimer) => void;
  setTimer?: (callback: () => void, delayMs: number) => IndicatorRetryTimer;
} = {}): KeyedIndicatorRetryTimers {
  const timers = new Map<string, IndicatorRetryTimer>();
  return {
    cancelAll() {
      for (const timer of timers.values()) cancelTimer(timer);
      timers.clear();
    },
    cancel(key) {
      const timer = timers.get(key);
      if (timer === undefined) return;
      cancelTimer(timer);
      timers.delete(key);
    },
    has(key) {
      return timers.has(key);
    },
    schedule(key, callback, delayMs) {
      const previous = timers.get(key);
      if (previous !== undefined) cancelTimer(previous);
      const timer = setTimer(() => {
        if (timers.get(key) !== timer) return;
        timers.delete(key);
        callback();
      }, delayMs);
      timers.set(key, timer);
    },
    get size() {
      return timers.size;
    },
  };
}

export interface PendingIndicatorCorrection {
  dirtyRange: IndicatorRange;
  indicatorId: string;
  revision: IndicatorRevision | null;
  seriesKey: string;
  targetKey: string;
}

export function mergePendingIndicatorCorrection(
  queued: PendingIndicatorCorrection | null | undefined,
  incoming: PendingIndicatorCorrection,
  preferQueuedRevision = false,
): PendingIndicatorCorrection {
  if (
    !queued
    || queued.indicatorId !== incoming.indicatorId
    || queued.seriesKey !== incoming.seriesKey
    || queued.targetKey !== incoming.targetKey
  ) return incoming;
  return {
    ...incoming,
    dirtyRange: {
      start: Math.min(queued.dirtyRange.start, incoming.dirtyRange.start),
      end: Math.max(queued.dirtyRange.end, incoming.dirtyRange.end),
    },
    revision: preferQueuedRevision
      ? (queued.revision || incoming.revision)
      : (incoming.revision || queued.revision),
  };
}

/**
 * `closedThrough` is intentionally excluded.  Advancing the closed-bar cursor
 * does not change an already closed historical range, while a correction,
 * server reset, or opaque revision token does.
 */
export function meaningfulIndicatorRevisionSignature(revisionInput: unknown): string {
  const revision = normalizeIndicatorRevision(revisionInput);
  if (!revision) return "legacy";
  return JSON.stringify([
    revision.serverEpoch || "",
    revision.correctionRevision || "",
    revision.token || "",
    revision.historyInvalid ? "invalid" : "valid",
  ]);
}

/** A released intent always follows the active series revision, never the one captured when it waited. */
export function resolveDirectIndicatorRangeRevision(
  currentRevision: unknown,
  capturedRevision: unknown,
): IndicatorRevision | null {
  const current = normalizeIndicatorRevision(currentRevision);
  const captured = normalizeIndicatorRevision(capturedRevision);
  if (!current) return captured;
  if (!captured) return current;
  if (
    (current.serverEpoch || "") === (captured.serverEpoch || "")
    && Number.isFinite(Number(current.correctionRevision))
    && Number.isFinite(Number(captured.correctionRevision))
    && Number(captured.correctionRevision) > Number(current.correctionRevision)
  ) return captured;
  return current;
}

export function buildIndicatorRangeRefreshSignature({
  seriesKey,
  requestScope,
  requestGeneration,
  targetKey,
  requestRange: requestRangeInput,
  invalidateRange: invalidateRangeInput,
  cascadeRight = false,
  revision,
}: IndicatorRangeRefreshSignatureOptions): string | null {
  const requestRange = normalizeIndicatorRange(requestRangeInput);
  if (!requestRange) return null;
  const invalidateRange = normalizeIndicatorRange(invalidateRangeInput);
  return JSON.stringify([
    "indicator-range-refresh-v1",
    String(seriesKey || ""),
    String(requestScope || ""),
    Number.isFinite(Number(requestGeneration)) ? Math.floor(Number(requestGeneration)) : "",
    String(targetKey || ""),
    requestRange.start,
    requestRange.end,
    invalidateRange?.start || "",
    invalidateRange?.end || "",
    invalidateRange ? Boolean(cascadeRight) : false,
    meaningfulIndicatorRevisionSignature(revision),
  ]);
}

/**
 * Initial hydration is a lifecycle action, not a chart-window fingerprint.
 * Once it succeeds, prepend commits are handled by their precise delta path;
 * changing the padded/visible start must not hydrate the whole viewport again.
 */
export function buildIndicatorInitialHydrationSignature({
  seriesKey,
  requestScope,
  requestGeneration,
  targetKeys,
}: IndicatorInitialHydrationSignatureOptions): string {
  return JSON.stringify([
    "indicator-initial-hydration-v1",
    String(seriesKey || ""),
    String(requestScope || ""),
    Number.isFinite(Number(requestGeneration)) ? Math.floor(Number(requestGeneration)) : "",
    Array.from(targetKeys, (value) => String(value || "")).sort(),
  ]);
}

export function createIndicatorInitialHydrationGate(): IndicatorInitialHydrationGate {
  const completed = new Set<string>();
  const pending = new Set<string>();
  return {
    begin(signature) {
      if (!signature || completed.has(signature) || pending.has(signature)) return false;
      pending.add(signature);
      return true;
    },
    clear() {
      completed.clear();
      pending.clear();
    },
    complete(signature) {
      pending.delete(signature);
      completed.add(signature);
    },
    isCompleted(signature) {
      return completed.has(signature);
    },
    isPending(signature) {
      return pending.has(signature);
    },
    release(signature) {
      pending.delete(signature);
    },
    releasePending() {
      const released = pending.size;
      pending.clear();
      return released;
    },
  };
}

function rangesOverlap(left: IndicatorRange, right: IndicatorRange): boolean {
  return left.start <= right.end && right.start <= left.end;
}

/**
 * A NOT_READY response represents an event wait, not a retry delay.  Keep a
 * bounded record of the exact range/revision so React renders, realtime ticks,
 * and unrelated timers cannot turn it into polling.  Only a newer overlapping
 * history event or a meaningful revision advance releases the wait.
 */
export function createDeferredIndicatorRangeWaitRegistry(
  maxEntries = 2_048,
): DeferredIndicatorRangeWaitRegistry {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 1));
  const entries = new Map<string, {
    afterEventId: number;
    range: IndicatorRange;
    revisionSignature: string;
    seriesKey: string;
    targetKey: string;
  }>();

  const normalized = (options: DeferredIndicatorRangeWaitOptions) => {
    const range = normalizeIndicatorRange(options.range);
    const seriesKey = String(options.seriesKey || "");
    const targetKey = String(options.targetKey || "");
    if (!range || !seriesKey || !targetKey) return null;
    const revisionSignature = meaningfulIndicatorRevisionSignature(options.revision);
    const afterEventId = Number.isFinite(Number(options.afterEventId))
      ? Math.max(0, Math.floor(Number(options.afterEventId)))
      : 0;
    return {
      afterEventId,
      range,
      revisionSignature,
      seriesKey,
      targetKey,
      key: JSON.stringify([
        "indicator-range-event-wait-v1",
        seriesKey,
        targetKey,
        range.start,
        range.end,
        revisionSignature,
      ]),
    };
  };

  return {
    block(options) {
      const entry = normalized(options);
      if (!entry) return false;
      entries.delete(entry.key);
      entries.set(entry.key, entry);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return true;
    },
    blocks(options) {
      const candidate = normalized(options);
      if (!candidate) return false;
      for (const entry of entries.values()) {
        if (
          entry.seriesKey === candidate.seriesKey
          && entry.targetKey === candidate.targetKey
          && entry.revisionSignature === candidate.revisionSignature
          && rangesOverlap(entry.range, candidate.range)
        ) return true;
      }
      return false;
    },
    clear() {
      entries.clear();
    },
    releaseForEvents(seriesKeyInput, events) {
      const seriesKey = String(seriesKeyInput || "");
      if (!seriesKey) return 0;
      const normalizedEvents = Array.from(events || [], (event) => ({
        id: Number.isFinite(Number(event?.id)) ? Math.floor(Number(event.id)) : 0,
        range: normalizeIndicatorRange(event),
      })).filter((event): event is { id: number; range: IndicatorRange } => (
        event.id > 0 && event.range !== null
      ));
      let released = 0;
      for (const [key, entry] of entries) {
        if (entry.seriesKey !== seriesKey) continue;
        if (normalizedEvents.some((event) => (
          event.id > entry.afterEventId && rangesOverlap(event.range, entry.range)
        ))) {
          entries.delete(key);
          released += 1;
        }
      }
      return released;
    },
    releaseForRevision(seriesKeyInput, revision) {
      const seriesKey = String(seriesKeyInput || "");
      const revisionSignature = meaningfulIndicatorRevisionSignature(revision);
      if (!seriesKey) return 0;
      let released = 0;
      for (const [key, entry] of entries) {
        if (
          entry.seriesKey === seriesKey
          && entry.revisionSignature !== revisionSignature
        ) {
          entries.delete(key);
          released += 1;
        }
      }
      return released;
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Keeps user-driven range intents alive until their physical requests settle.
 * A transport accepting work is not completion.  NOT_READY moves the intent
 * into an event wait; only a newer overlapping event or meaningful revision
 * makes it runnable again.  Versions prevent a late response from completing
 * a newer pan/WS intent that reused the same logical key.
 */
export function createDeferredIndicatorRangeIntentRegistry<TPayload = unknown>(
  maxEntries = 256,
): DeferredIndicatorRangeIntentRegistry<TPayload> {
  type State = "ready" | "in-flight" | "waiting";
  interface Entry {
    afterEventId: number;
    intent: DeferredIndicatorRangeIntent<TPayload>;
    revisionSignature: string;
    state: State;
    version: number;
  }
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 1));
  const entries = new Map<string, Entry>();
  let nextVersion = 1;

  const attempt = (entry: Entry): DeferredIndicatorRangeIntentAttempt<TPayload> => ({
    intent: entry.intent,
    version: entry.version,
  });
  const current = (key: string, version: number): Entry | null => {
    const entry = entries.get(key);
    return entry?.version === version ? entry : null;
  };
  const markReady = (entry: Entry): DeferredIndicatorRangeIntentAttempt<TPayload> => {
    entry.state = "ready";
    return attempt(entry);
  };

  return {
    begin(key, expectedVersion) {
      const entry = entries.get(String(key || ""));
      if (
        !entry
        || entry.state !== "ready"
        || (expectedVersion !== undefined && entry.version !== expectedVersion)
      ) return null;
      entry.state = "in-flight";
      return attempt(entry);
    },
    clear() {
      entries.clear();
    },
    complete(key, version) {
      const entry = current(key, version);
      if (!entry) return false;
      entries.delete(key);
      return true;
    },
    defer(key, version, options) {
      const entry = current(key, version);
      if (!entry || entry.state !== "in-flight") return false;
      entry.afterEventId = Number.isFinite(Number(options.afterEventId))
        ? Math.max(0, Math.floor(Number(options.afterEventId)))
        : 0;
      entry.revisionSignature = meaningfulIndicatorRevisionSignature(
        options.revision ?? entry.intent.revision,
      );
      entry.state = "waiting";
      return true;
    },
    fail(key, version) {
      const entry = current(key, version);
      if (!entry || entry.state !== "in-flight") return false;
      entry.state = "ready";
      return true;
    },
    has(key, fingerprint) {
      const entry = entries.get(String(key || ""));
      return Boolean(
        entry
        && (fingerprint === undefined || entry.intent.fingerprint === fingerprint),
      );
    },
    remember(intent) {
      const key = String(intent?.key || "");
      const seriesKey = String(intent?.seriesKey || "");
      const range = normalizeIndicatorRange(intent?.range);
      if (!key || !seriesKey || !range) return null;
      const fingerprint = String(intent?.fingerprint || "");
      const previous = entries.get(key);
      if (previous?.intent.fingerprint === fingerprint) return previous.version;
      const normalizedIntent: DeferredIndicatorRangeIntent<TPayload> = {
        ...intent,
        fingerprint,
        key,
        range,
        seriesKey,
      };
      const entry: Entry = {
        afterEventId: 0,
        intent: normalizedIntent,
        revisionSignature: meaningfulIndicatorRevisionSignature(intent.revision),
        state: "ready",
        version: nextVersion++,
      };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return entry.version;
    },
    readyForSeries(seriesKeyInput) {
      const seriesKey = String(seriesKeyInput || "");
      if (!seriesKey) return [];
      return Array.from(entries.values())
        .filter((entry) => (
          entry.state === "ready" && entry.intent.seriesKey === seriesKey
        ))
        .map(attempt);
    },
    release(key, version) {
      const entry = current(key, version);
      if (!entry || entry.state !== "waiting") return false;
      entry.state = "ready";
      return true;
    },
    releaseForEvents(seriesKeyInput, events) {
      const seriesKey = String(seriesKeyInput || "");
      if (!seriesKey) return [];
      const normalizedEvents = Array.from(events || [], (event) => ({
        id: Number.isFinite(Number(event?.id)) ? Math.floor(Number(event.id)) : 0,
        range: normalizeIndicatorRange(event),
      })).filter((event): event is { id: number; range: IndicatorRange } => (
        event.id > 0 && event.range !== null
      ));
      const released: DeferredIndicatorRangeIntentAttempt<TPayload>[] = [];
      for (const entry of entries.values()) {
        if (entry.state !== "waiting" || entry.intent.seriesKey !== seriesKey) continue;
        if (normalizedEvents.some((event) => (
          event.id > entry.afterEventId && rangesOverlap(event.range, entry.intent.range)
        ))) released.push(markReady(entry));
      }
      return released;
    },
    releaseForRevision(seriesKeyInput, revision) {
      const seriesKey = String(seriesKeyInput || "");
      const revisionSignature = meaningfulIndicatorRevisionSignature(revision);
      if (!seriesKey) return [];
      const released: DeferredIndicatorRangeIntentAttempt<TPayload>[] = [];
      for (const entry of entries.values()) {
        if (
          entry.state === "waiting"
          && entry.intent.seriesKey === seriesKey
          && entry.revisionSignature !== revisionSignature
        ) released.push(markReady(entry));
      }
      return released;
    },
    get size() {
      return entries.size;
    },
  };
}

export function createCompletedIndicatorRangeRequestLedger(
  maxEntries = 2_048,
): CompletedIndicatorRangeRequestLedger {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 1));
  const completed = new Map<string, true>();
  return {
    clear() {
      completed.clear();
    },
    forget(signature) {
      completed.delete(signature);
    },
    has(signature) {
      return completed.has(signature);
    },
    remember(signature) {
      if (!signature) return;
      completed.delete(signature);
      completed.set(signature, true);
      while (completed.size > limit) {
        const oldest = completed.keys().next().value;
        if (oldest === undefined) break;
        completed.delete(oldest);
      }
    },
    get size() {
      return completed.size;
    },
  };
}
