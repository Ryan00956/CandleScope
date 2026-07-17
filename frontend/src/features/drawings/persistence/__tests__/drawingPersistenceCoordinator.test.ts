import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingDocumentStore,
} from "../../core/drawingDocumentStore.js";
import {
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type { DrawingDocumentStore } from "../../core/drawingDocumentStore.js";
import {
  createDrawingDocumentRepository,
} from "../drawingDocumentRepository.js";
import type {
  DrawingDocumentRecordV1,
  DrawingDocumentRepositoryBackend,
} from "../drawingDocumentRepository.js";
import {
  createDrawingPersistenceCoordinator,
  DRAWING_PERSISTENCE_DEBOUNCE_MS,
} from "../drawingPersistenceCoordinator.js";
import type {
  DrawingPersistenceAttemptMetric,
} from "../drawingPersistenceCoordinator.js";
import {
  createLegacyDrawingImporter,
  legacyDrawingStorageKey,
} from "../legacyDrawingImporter.js";

interface DeferredWrite {
  readonly record: DrawingDocumentRecordV1;
  resolve(): void;
  reject(error: Error): void;
}

class ControlledBackend implements DrawingDocumentRepositoryBackend {
  readonly records = new Map<string, unknown>();
  readonly writes: DeferredWrite[] = [];
  active = 0;
  maxActive = 0;

  async get(scopeKey: string): Promise<unknown | undefined> {
    return this.records.get(scopeKey);
  }

  async put(record: DrawingDocumentRecordV1): Promise<void> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let resolveWrite!: () => void;
    let rejectWrite!: (error: Error) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    this.writes.push({
      record,
      resolve: resolveWrite,
      reject: rejectWrite,
    });
    try {
      await settled;
      this.records.set(record.scopeKey, structuredClone(record));
    } finally {
      this.active -= 1;
    }
  }
}

interface ManualTask {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

class ManualScheduler {
  readonly delays: ManualTask[] = [];
  readonly idles: ManualTask[] = [];

  scheduleDelay = (callback: () => void, delayMs: number): ManualTask => {
    const task = { callback, delayMs, cancelled: false };
    this.delays.push(task);
    return task;
  };

  cancelDelay = (handle: unknown): void => {
    (handle as ManualTask).cancelled = true;
  };

  scheduleIdle = (callback: () => void): ManualTask => {
    const task = { callback, delayMs: 0, cancelled: false };
    this.idles.push(task);
    return task;
  };

  cancelIdle = (handle: unknown): void => {
    (handle as ManualTask).cancelled = true;
  };

  runLatestDelay(): void {
    const task = [...this.delays].reverse().find((candidate) => !candidate.cancelled);
    if (!task) throw new Error("no pending delay");
    task.cancelled = true;
    task.callback();
  }
}

function memoryStorage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function entity(id: string, offset = 0) {
  return createDrawingEntity({
    id,
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [
        { time: 100 + offset, price: 1 + offset },
        { time: 200 + offset, price: 2 + offset },
      ],
    },
    style: { kind: "line", color: "#fff", lineWidth: 2 },
  });
}

function add(store: DrawingDocumentStore, id: string, offset = 0): void {
  const result = store.dispatch(Object.freeze({ type: "create" as const, entity: entity(id, offset) }));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function fixture(options: Readonly<{
  monotonicNow?: () => number;
  onPersistenceAttempt?: (attempt: DrawingPersistenceAttemptMetric) => void;
}> = {}) {
  const backend = new ControlledBackend();
  const scheduler = new ManualScheduler();
  const legacyValues = new Map<string, string>();
  const importer = createLegacyDrawingImporter({ storage: memoryStorage(legacyValues) });
  const repository = createDrawingDocumentRepository({
    backend,
    legacyImporter: importer,
    manifestStorage: memoryStorage(new Map()),
  });
  const coordinator = createDrawingPersistenceCoordinator({
    repository,
    legacyImporter: importer,
    scheduleDelay: scheduler.scheduleDelay,
    cancelDelay: scheduler.cancelDelay,
    scheduleIdle: scheduler.scheduleIdle,
    cancelIdle: scheduler.cancelIdle,
    now: () => 1000,
    ...options,
  });
  return { backend, coordinator, importer, legacyValues, repository, scheduler };
}

test("every background transaction records one success or failure duration", async () => {
  let clock = 10;
  const attempts: DrawingPersistenceAttemptMetric[] = [];
  const { backend, coordinator, scheduler } = fixture({
    monotonicNow: () => clock,
    onPersistenceAttempt: (attempt) => { attempts.push(attempt); },
  });
  const store = createDrawingDocumentStore("telemetry");
  add(store, "one");
  coordinator.schedule(store);
  scheduler.runLatestDelay();
  await settle();
  clock = 35;
  backend.writes[0]?.resolve();
  await settle();
  assert.equal(attempts.length, 1);
  const success = attempts[0] as DrawingPersistenceAttemptMetric | undefined;
  assert.ok(success);
  assert.equal(success.durationMs, 25);
  assert.equal(success.error, null);
  assert.equal(success.ok, true);
  assert.equal(success.revision, 1);
  assert.equal(success.scopeKey, "telemetry");
  assert.ok((success.maxEncodeChunkDurationMs ?? -1) >= 0);

  add(store, "two", 2);
  coordinator.schedule(store);
  scheduler.runLatestDelay();
  await settle();
  clock = 50;
  backend.writes[1]?.reject(new Error("quota"));
  await settle();
  assert.equal(attempts.length, 2);
  const failure = attempts[1] as DrawingPersistenceAttemptMetric | undefined;
  assert.ok(failure);
  assert.equal(failure.durationMs, 15);
  assert.equal(failure.ok, false);
  assert.equal(failure.maxEncodeChunkDurationMs, null);
  assert.ok(failure.error);
  assert.match(failure.error.message, /quota/);
});

test("coordinator debounces 400ms and keeps one in-flight plus one pending latest", async () => {
  const { backend, coordinator, scheduler } = fixture();
  const store = createDrawingDocumentStore("latest");
  add(store, "one");
  assert.equal(coordinator.schedule(store), true);
  assert.equal(scheduler.delays.at(-1)?.delayMs, DRAWING_PERSISTENCE_DEBOUNCE_MS);
  scheduler.runLatestDelay();
  await settle();
  assert.equal(backend.writes.length, 1);
  assert.equal(backend.writes[0]?.record.documentRevision, 1);

  add(store, "two", 10);
  coordinator.schedule(store);
  scheduler.runLatestDelay();
  await settle();
  assert.deepEqual(coordinator.snapshot("latest"), {
    scopeKey: "latest",
    phase: "debounced",
    queueDepth: 2,
    inFlightRevision: 1,
    pendingRevision: 2,
    dirtyRevision: 2,
    lastPersistedRevision: null,
    lastError: null,
    lastErrorName: null,
    legacySnapshotRevision: null,
    legacySnapshotError: null,
  });

  backend.writes[0]?.resolve();
  await settle();
  assert.equal(store.dirtyRevision, 2, "rev1 completion must not acknowledge rev2");
  assert.equal(backend.writes.length, 2);
  assert.equal(backend.writes[1]?.record.documentRevision, 2);
  assert.equal(backend.maxActive, 1);

  backend.writes[1]?.resolve();
  await settle();
  assert.equal(store.dirty, false);
  assert.equal(coordinator.snapshot("latest")?.lastPersistedRevision, 2);
  assert.ok((coordinator.snapshot("latest")?.queueDepth ?? 1) <= 2);
});

test("failed explicit flush retains its pending revision and a later retry commits it", async () => {
  const { backend, coordinator } = fixture();
  const store = createDrawingDocumentStore("failure");
  const oldRecord = Object.freeze({ sentinel: "old-bytes" });
  backend.records.set("failure", oldRecord);
  add(store, "line");
  coordinator.schedule(store);

  const flushing = coordinator.flush("failure");
  await settle();
  assert.equal(backend.writes.length, 1);
  const quotaError = new Error("quota exceeded");
  quotaError.name = "QuotaExceededError";
  backend.writes[0]?.reject(quotaError);
  const result = await flushing;
  assert.equal(result.ok, false);
  assert.equal(store.dirty, true);
  assert.equal(coordinator.snapshot("failure")?.phase, "error");
  assert.equal(coordinator.snapshot("failure")?.pendingRevision, 1);
  assert.equal(coordinator.snapshot("failure")?.lastError, "quota exceeded");
  assert.equal(coordinator.snapshot("failure")?.lastErrorName, "QuotaExceededError");
  assert.deepEqual(backend.records.get("failure"), oldRecord);

  const retrying = coordinator.flush("failure");
  await settle();
  assert.equal(backend.writes.length, 2);
  assert.equal(backend.writes[1]?.record.documentRevision, 1);
  assert.deepEqual(
    backend.writes[1]?.record,
    backend.writes[0]?.record,
    "retry must persist the exact retained job, including its original updatedAt",
  );
  assert.equal(coordinator.snapshot("failure")?.inFlightRevision, 1);
  assert.equal(coordinator.snapshot("failure")?.pendingRevision, null);
  backend.writes[1]?.resolve();
  const retryResult = await retrying;
  assert.equal(retryResult.ok, true);
  assert.equal(retryResult.ok && retryResult.persistedRevision, 1);
  assert.equal(store.dirty, false);
  assert.equal(coordinator.snapshot("failure")?.phase, "persisted");
  assert.equal(coordinator.snapshot("failure")?.lastPersistedRevision, 1);
  assert.equal(coordinator.snapshot("failure")?.lastError, null);
  assert.equal(coordinator.snapshot("failure")?.lastErrorName, null);
  assert.equal(
    (backend.records.get("failure") as DrawingDocumentRecordV1 | undefined)?.documentRevision,
    1,
  );
});

test("idle legacy snapshots publish only the latest successfully persisted revision", async () => {
  const { backend, coordinator, legacyValues, scheduler } = fixture();
  const store = createDrawingDocumentStore("legacy-latest");
  add(store, "one");
  coordinator.schedule(store);
  scheduler.runLatestDelay();
  await settle();
  backend.writes[0]?.resolve();
  await settle();
  const staleIdle = scheduler.idles[0];
  assert.ok(staleIdle);

  add(store, "two", 10);
  coordinator.schedule(store);
  scheduler.runLatestDelay();
  await settle();
  backend.writes[1]?.resolve();
  await settle();
  const latestIdle = scheduler.idles.at(-1);
  assert.ok(latestIdle);

  staleIdle.callback();
  assert.equal(legacyValues.has(legacyDrawingStorageKey("legacy-latest")), false);
  latestIdle.callback();
  await settle();
  const raw = legacyValues.get(legacyDrawingStorageKey("legacy-latest"));
  assert.ok(raw);
  const saved = JSON.parse(raw) as Array<{ id?: string }>;
  assert.deepEqual(saved.map((item) => item.id), ["one", "two"]);
  assert.equal(coordinator.snapshot("legacy-latest")?.legacySnapshotRevision, 2);
});

test("clear writes an empty v2 tombstone and an idle legacy empty snapshot", async () => {
  const { backend, coordinator, legacyValues, scheduler } = fixture();
  const store = createDrawingDocumentStore("clear");
  add(store, "line");
  assert.equal(coordinator.clear(store), true);
  assert.equal(store.getSnapshot().entities.size, 0);
  const flushing = coordinator.flush("clear");
  await settle();
  assert.equal(backend.writes.length, 1);
  backend.writes[0]?.resolve();
  const result = await flushing;
  assert.equal(result.ok, true);
  await settle();
  const stored = backend.records.get("clear") as DrawingDocumentRecordV1;
  assert.equal(stored.entities.length, 0);
  assert.equal(store.dirty, false);
  scheduler.idles.at(-1)?.callback();
  await settle();
  assert.equal(legacyValues.get(legacyDrawingStorageKey("clear")), "[]");
});
