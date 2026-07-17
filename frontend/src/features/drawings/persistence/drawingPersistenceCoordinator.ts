import type { DrawingDocument } from "../core/drawingDocument.js";
import type { DrawingDocumentStore } from "../core/drawingDocumentStore.js";
import { drawingPerfCounters } from "../performance/drawingPerfCounters.js";
import {
  drawingDocumentRepository,
} from "./drawingDocumentRepository.js";
import type {
  DrawingDocumentRepository,
} from "./drawingDocumentRepository.js";
import {
  legacyDrawingImporter,
} from "./legacyDrawingImporter.js";
import type {
  LegacyDrawingImporter,
} from "./legacyDrawingImporter.js";

export const DRAWING_PERSISTENCE_DEBOUNCE_MS = 400;

export type DrawingPersistencePhase =
  | "idle"
  | "debounced"
  | "persisting"
  | "persisted"
  | "error";

export interface DrawingPersistenceCoordinatorSnapshot {
  readonly scopeKey: string;
  readonly phase: DrawingPersistencePhase;
  readonly queueDepth: number;
  readonly inFlightRevision: number | null;
  readonly pendingRevision: number | null;
  readonly dirtyRevision: number | null;
  readonly lastPersistedRevision: number | null;
  readonly lastError: string | null;
  readonly lastErrorName: string | null;
  readonly legacySnapshotRevision: number | null;
  readonly legacySnapshotError: string | null;
}

export type DrawingPersistenceFlushResult =
  | Readonly<{
      ok: true;
      scopeKey: string;
      targetRevision: number;
      persistedRevision: number;
    }>
  | Readonly<{
      ok: false;
      scopeKey: string;
      targetRevision: number;
      error: Error;
    }>;

export interface DrawingPersistenceCoordinator {
  clear(store: DrawingDocumentStore): boolean;
  flush(scopeKey: string): Promise<DrawingPersistenceFlushResult>;
  flushAll(): Promise<readonly DrawingPersistenceFlushResult[]>;
  schedule(store: DrawingDocumentStore): boolean;
  snapshot(scopeKey: string): DrawingPersistenceCoordinatorSnapshot | null;
}

export interface DrawingPersistenceCoordinatorOptions {
  readonly repository?: DrawingDocumentRepository;
  readonly legacyImporter?: LegacyDrawingImporter;
  readonly debounceMs?: number;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly onPersistenceAttempt?: (attempt: DrawingPersistenceAttemptMetric) => void;
  readonly scheduleDelay?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelDelay?: (handle: unknown) => void;
  readonly scheduleIdle?: (callback: () => void) => unknown;
  readonly cancelIdle?: (handle: unknown) => void;
}

export interface DrawingPersistenceAttemptMetric {
  readonly durationMs: number;
  readonly error: Error | null;
  readonly maxEncodeChunkDurationMs: number | null;
  readonly ok: boolean;
  readonly revision: number;
  readonly scopeKey: string;
}

interface PersistenceJob {
  readonly document: DrawingDocument;
  readonly documentRevision: number;
  readonly scopeKey: string;
  readonly store: DrawingDocumentStore;
  readonly updatedAt: number;
}

interface PersistenceAttempt {
  readonly job: PersistenceJob;
  readonly ok: boolean;
  readonly error: Error | null;
}

interface PersistenceScopeState {
  readonly scopeKey: string;
  readonly store: DrawingDocumentStore;
  phase: DrawingPersistencePhase;
  pending: PersistenceJob | null;
  inFlight: PersistenceJob | null;
  inFlightPromise: Promise<PersistenceAttempt> | null;
  debounceHandle: unknown | null;
  legacyIdleHandle: unknown | null;
  legacyGeneration: number;
  latestScheduledDocument: DrawingDocument | null;
  lastPersistedRevision: number | null;
  lastError: Error | null;
  legacySnapshotRevision: number | null;
  legacySnapshotError: Error | null;
}

function errorFromUnknown(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function defaultScheduleDelay(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultCancelDelay(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultScheduleIdle(callback: () => void): unknown {
  if (typeof requestIdleCallback === "function") {
    return requestIdleCallback(() => callback(), { timeout: 1_000 });
  }
  return setTimeout(callback, 0);
}

function defaultCancelIdle(handle: unknown): void {
  if (typeof cancelIdleCallback === "function" && typeof handle === "number") {
    cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function jobFromStore(store: DrawingDocumentStore, now: () => number): PersistenceJob {
  const document = store.getSnapshot();
  return Object.freeze({
    document,
    documentRevision: document.documentRevision,
    scopeKey: document.scopeKey,
    store,
    updatedAt: now(),
  });
}

/**
 * Per-scope persistence queue: exactly one transaction in flight and one
 * replaceable pending-latest snapshot. Storage failures never roll back an
 * already committed canonical document.
 */
export function createDrawingPersistenceCoordinator({
  repository = drawingDocumentRepository,
  legacyImporter: importer = legacyDrawingImporter,
  debounceMs = DRAWING_PERSISTENCE_DEBOUNCE_MS,
  now = Date.now,
  monotonicNow = defaultMonotonicNow,
  onPersistenceAttempt,
  scheduleDelay = defaultScheduleDelay,
  cancelDelay = defaultCancelDelay,
  scheduleIdle = defaultScheduleIdle,
  cancelIdle = defaultCancelIdle,
}: DrawingPersistenceCoordinatorOptions = {}): DrawingPersistenceCoordinator {
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new TypeError("drawing persistence debounce must be non-negative");
  }
  const scopes = new Map<string, PersistenceScopeState>();

  const stateFor = (store: DrawingDocumentStore): PersistenceScopeState | null => {
    const scopeKey = store.getSnapshot().scopeKey;
    if (!scopeKey) return null;
    const existing = scopes.get(scopeKey);
    if (existing) return existing.store === store ? existing : null;
    const state: PersistenceScopeState = {
      scopeKey,
      store,
      phase: "idle",
      pending: null,
      inFlight: null,
      inFlightPromise: null,
      debounceHandle: null,
      legacyIdleHandle: null,
      legacyGeneration: 0,
      latestScheduledDocument: null,
      lastPersistedRevision: null,
      lastError: null,
      legacySnapshotRevision: null,
      legacySnapshotError: null,
    };
    scopes.set(scopeKey, state);
    return state;
  };

  const cancelDebounce = (state: PersistenceScopeState): void => {
    if (state.debounceHandle === null) return;
    cancelDelay(state.debounceHandle);
    state.debounceHandle = null;
  };

  const cancelLegacyIdle = (state: PersistenceScopeState): void => {
    state.legacyGeneration += 1;
    if (state.legacyIdleHandle === null) return;
    cancelIdle(state.legacyIdleHandle);
    state.legacyIdleHandle = null;
  };

  const scheduleLegacySnapshot = (
    state: PersistenceScopeState,
    job: PersistenceJob,
  ): void => {
    cancelLegacyIdle(state);
    const generation = state.legacyGeneration;
    state.legacyIdleHandle = scheduleIdle(() => {
      state.legacyIdleHandle = null;
      void (async () => {
        const currentDocument = state.store.getSnapshot();
        const stale = generation !== state.legacyGeneration
          || state.latestScheduledDocument !== job.document
          || state.lastPersistedRevision !== job.documentRevision
          || currentDocument !== job.document
          || state.pending !== null
          || state.inFlight !== null;
        if (stale) return;
        const encoded = await importer.encodeAsync(job.document);
        if (generation !== state.legacyGeneration
          || state.latestScheduledDocument !== job.document
          || state.lastPersistedRevision !== job.documentRevision
          || state.store.getSnapshot() !== job.document
          || state.pending !== null
          || state.inFlight !== null) return;
        if (!encoded
          || encoded.scopeKey !== state.scopeKey
          || encoded.documentRevision !== job.documentRevision) {
          state.legacySnapshotError = new TypeError("legacy drawing snapshot encoding failed");
          return;
        }
        const result = importer.write(encoded);
        if (result.ok) {
          state.legacySnapshotRevision = result.documentRevision;
          state.legacySnapshotError = null;
        } else {
          state.legacySnapshotError = result.error;
        }
      })().catch((error: unknown) => {
        if (generation === state.legacyGeneration) {
          state.legacySnapshotError = errorFromUnknown(
            error,
            "legacy drawing snapshot encoding failed",
          );
        }
      });
    });
  };

  const shouldReplacePending = (current: PersistenceJob | null, next: PersistenceJob): boolean => (
    current === null || next.documentRevision >= current.documentRevision
  );

  const persistJob = async (
    state: PersistenceScopeState,
    job: PersistenceJob,
  ): Promise<PersistenceAttempt> => {
    const startedAt = monotonicNow();
    let observedError: Error | null = null;
    let maxEncodeChunkDurationMs: number | null = null;
    try {
      const result = await repository.putDocument(job.document, job.updatedAt);
      maxEncodeChunkDurationMs = result.encodeMetrics.maxChunkDurationMs;
      state.lastPersistedRevision = state.lastPersistedRevision === null
        ? job.documentRevision
        : Math.max(state.lastPersistedRevision, job.documentRevision);
      state.lastError = null;
      job.store.acknowledgePersisted(job.scopeKey, job.documentRevision);
      scheduleLegacySnapshot(state, job);
      return Object.freeze({ job, ok: true, error: null });
    } catch (error) {
      const failure = errorFromUnknown(error, "drawing document persistence failed");
      observedError = failure;
      state.lastError = failure;
      return Object.freeze({ job, ok: false, error: failure });
    } finally {
      if (onPersistenceAttempt) {
        try {
          onPersistenceAttempt(Object.freeze({
            durationMs: Math.max(0, monotonicNow() - startedAt),
            error: observedError,
            maxEncodeChunkDurationMs,
            ok: observedError === null,
            revision: job.documentRevision,
            scopeKey: job.scopeKey,
          }));
        } catch {
          // Telemetry must never change persistence acknowledgement semantics.
        }
      }
    }
  };

  const startPending = (state: PersistenceScopeState): Promise<PersistenceAttempt> | null => {
    if (state.inFlightPromise || !state.pending) return state.inFlightPromise;
    const job = state.pending;
    state.pending = null;
    state.inFlight = job;
    state.phase = "persisting";
    const attemptPromise = persistJob(state, job);
    state.inFlightPromise = attemptPromise;
    void attemptPromise.then((attempt) => {
      state.inFlight = null;
      state.inFlightPromise = null;
      if (!attempt.ok) {
        // Retain the failed latest snapshot for an explicit flush or a later
        // mutation. A genuinely newer pending job supersedes it.
        if (!state.pending || state.pending.documentRevision <= job.documentRevision) {
          state.pending = job;
        }
        state.phase = "error";
      } else {
        state.phase = "persisted";
      }

      const hasNewerPending = state.pending !== null && state.pending !== job;
      if (hasNewerPending && state.debounceHandle === null) {
        void startPending(state);
      } else if (state.pending && state.pending !== job) {
        state.phase = "debounced";
      }
    }).catch((error: unknown) => {
      state.inFlight = null;
      state.inFlightPromise = null;
      state.lastError = errorFromUnknown(error, "drawing persistence queue failed");
      if (!state.pending || state.pending.documentRevision <= job.documentRevision) {
        state.pending = job;
      }
      state.phase = "error";
    });
    return attemptPromise;
  };

  const queue = (state: PersistenceScopeState, job: PersistenceJob): void => {
    if (shouldReplacePending(state.pending, job)) state.pending = job;
    state.latestScheduledDocument = job.document;
    cancelLegacyIdle(state);
    cancelDebounce(state);
    state.phase = "debounced";
    state.debounceHandle = scheduleDelay(() => {
      state.debounceHandle = null;
      void startPending(state);
    }, debounceMs);
  };

  const schedule = (store: DrawingDocumentStore): boolean => {
    const state = stateFor(store);
    if (!state) return false;
    queue(state, jobFromStore(store, now));
    return true;
  };

  const flush = async (scopeKey: string): Promise<DrawingPersistenceFlushResult> => {
    const state = scopes.get(scopeKey);
    if (!state) {
      return Object.freeze({
        ok: false as const,
        scopeKey,
        targetRevision: 0,
        error: new Error("drawing persistence scope is not scheduled"),
      });
    }
    const targetDocument = state.store.getSnapshot();
    const targetRevision = targetDocument.documentRevision;
    if (state.store.dirty
      && (!state.pending || state.pending.documentRevision < targetRevision)) {
      state.pending = jobFromStore(state.store, now);
      state.latestScheduledDocument = targetDocument;
    }
    cancelDebounce(state);

    while ((state.lastPersistedRevision ?? -1) < targetRevision || state.store.dirty) {
      const active = state.inFlightPromise ?? startPending(state);
      if (!active) {
        return Object.freeze({
          ok: false as const,
          scopeKey,
          targetRevision,
          error: state.lastError ?? new Error("drawing persistence has no pending snapshot"),
        });
      }
      const attempt = await active;
      if (!attempt.ok) {
        const newerPending = state.pending && state.pending !== attempt.job
          && state.pending.documentRevision > attempt.job.documentRevision;
        if (!newerPending) {
          return Object.freeze({
            ok: false as const,
            scopeKey,
            targetRevision,
            error: attempt.error ?? new Error("drawing document persistence failed"),
          });
        }
      }
      if ((state.lastPersistedRevision ?? -1) >= targetRevision
        && (state.store.dirtyRevision === null || state.store.dirtyRevision > targetRevision)) break;
      if (state.pending) cancelDebounce(state);
    }

    return Object.freeze({
      ok: true as const,
      scopeKey,
      targetRevision,
      persistedRevision: state.lastPersistedRevision ?? targetRevision,
    });
  };

  const coordinator: DrawingPersistenceCoordinator = {
    clear(store) {
      const scopeKey = store.getSnapshot().scopeKey;
      const result = store.dispatch(Object.freeze({ type: "clear" }));
      if (!result.ok) return false;
      if (!result.changed && !store.requirePersistence(scopeKey)) return false;
      return schedule(store);
    },
    flush,
    async flushAll() {
      return Object.freeze(await Promise.all([...scopes.keys()].map((scopeKey) => flush(scopeKey))));
    },
    schedule,
    snapshot(scopeKey) {
      const state = scopes.get(scopeKey);
      if (!state) return null;
      return Object.freeze({
        scopeKey,
        phase: state.phase,
        queueDepth: (state.inFlight ? 1 : 0) + (state.pending ? 1 : 0),
        inFlightRevision: state.inFlight?.documentRevision ?? null,
        pendingRevision: state.pending?.documentRevision ?? null,
        dirtyRevision: state.store.dirtyRevision,
        lastPersistedRevision: state.lastPersistedRevision,
        lastError: state.lastError?.message ?? null,
        lastErrorName: state.lastError?.name ?? null,
        legacySnapshotRevision: state.legacySnapshotRevision,
        legacySnapshotError: state.legacySnapshotError?.message ?? null,
      });
    },
  };
  return Object.freeze(coordinator);
}

export const drawingPersistenceCoordinator = createDrawingPersistenceCoordinator({
  onPersistenceAttempt: ({ durationMs, error, maxEncodeChunkDurationMs }) => {
    drawingPerfCounters.recordPersistenceDuration(durationMs);
    drawingPerfCounters.recordPersistenceAttempt(error);
    if (maxEncodeChunkDurationMs !== null) {
      drawingPerfCounters.recordDuration("persistenceChunkMs", maxEncodeChunkDurationMs);
    }
  },
});
