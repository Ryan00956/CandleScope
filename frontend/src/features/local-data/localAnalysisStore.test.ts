import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalAnalysisStorageKey,
  LocalAnalysisEventStore,
  LocalAnalysisStorageError,
} from "./localAnalysisStore.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const identity = { datasetId: "dataset-1", dataEpoch: "sha256:abc" };

test("manual analysis events persist per immutable dataset revision", () => {
  const storage = new MemoryStorage();
  let id = 0;
  let now = 0;
  const store = new LocalAnalysisEventStore(identity, {
    storage,
    idFactory: () => `event-${++id}`,
    now: () => new Date(1_700_000_000_000 + now++ * 1_000),
  });
  const created = store.create({
    time: 1_700_000_000,
    price: 42_000.5,
    kind: "entry",
    label: "模型开仓",
    note: "突破过滤器通过",
    color: "#22C55E",
  });

  assert.equal(store.getSnapshot().events.length, 1);
  assert.equal(created.color, "#22c55e");
  assert.ok(storage.getItem(buildLocalAnalysisStorageKey(identity))?.includes("模型开仓"));

  const restored = new LocalAnalysisEventStore(identity, { storage });
  assert.deepEqual(restored.getSnapshot().events.map((event) => ({
    id: event.id,
    time: event.time,
    kind: event.kind,
    label: event.label,
  })), [{ id: "event-1", time: 1_700_000_000, kind: "entry", label: "模型开仓" }]);

  restored.update(created.id, {
    time: created.time,
    price: created.price,
    kind: "signal",
    label: "候选信号",
    note: "等待确认",
    color: "#8b5cf6",
  });
  assert.equal(restored.getSnapshot().events[0]?.kind, "signal");
  assert.equal(restored.delete(created.id), true);
  assert.equal(restored.getSnapshot().events.length, 0);
});

test("a persistence failure never publishes an in-memory event", () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const store = new LocalAnalysisEventStore(identity, { storage, idFactory: () => "event-1" });

  assert.throws(() => store.create({
    time: 100,
    price: null,
    kind: "note",
    label: "",
    note: "",
    color: "#f59e0b",
  }), (reason: unknown) => (
    reason instanceof LocalAnalysisStorageError && reason.message === "quota exceeded"
  ));
  assert.equal(store.getSnapshot().events.length, 0);
  assert.equal(store.getSnapshot().revision, 0);
});

test("corrupt event storage fails closed until the user explicitly resets it", () => {
  const storage = new MemoryStorage();
  storage.setItem(buildLocalAnalysisStorageKey(identity), "{not-json");
  const store = new LocalAnalysisEventStore(identity, { storage });

  assert.match(store.getSnapshot().storage_error ?? "", /不是有效 JSON/);
  assert.throws(() => store.create({
    time: 100,
    price: null,
    kind: "note",
    label: "",
    note: "",
    color: "#f59e0b",
  }), LocalAnalysisStorageError);

  store.resetCorruptDocument();
  assert.equal(store.getSnapshot().storage_error, null);
  assert.equal(storage.getItem(buildLocalAnalysisStorageKey(identity)), null);
});

test("different dataset revisions never share analysis events", () => {
  const storage = new MemoryStorage();
  const first = new LocalAnalysisEventStore(identity, { storage, idFactory: () => "event-1" });
  first.create({
    time: 100,
    price: 1,
    kind: "custom",
    label: "A",
    note: "",
    color: "#38bdf8",
  });
  const nextRevision = new LocalAnalysisEventStore({
    datasetId: identity.datasetId,
    dataEpoch: "sha256:def",
  }, { storage });
  assert.equal(nextRevision.getSnapshot().events.length, 0);
});

test("CSV events import atomically and repeated source rows are skipped", () => {
  const storage = new MemoryStorage();
  const store = new LocalAnalysisEventStore(identity, {
    storage,
    now: () => new Date("2026-08-05T00:00:00Z"),
  });
  const drafts = [{
    id: `csv:${"a".repeat(64)}:2`,
    time: 1_700_000_000,
    price: 42_000,
    kind: "entry" as const,
    label: "CSV entry",
    note: "model=alpha",
    color: "#22c55e",
    source: "csv" as const,
    extra: { csv_row: 2, model_score: "0.83" },
  }];

  assert.deepEqual(store.importBatch(drafts), { imported: 1, skipped: 0 });
  assert.deepEqual(store.importBatch(drafts), { imported: 0, skipped: 1 });
  assert.equal(store.getSnapshot().events[0]?.source, "csv");
  assert.equal(store.getSnapshot().events[0]?.extra.model_score, "0.83");

  const restored = new LocalAnalysisEventStore(identity, { storage });
  assert.equal(restored.getSnapshot().events[0]?.source, "csv");
});

test("a duplicate ID inside one CSV batch fails without publishing any row", () => {
  const store = new LocalAnalysisEventStore(identity, { storage: new MemoryStorage() });
  const draft = {
    id: "csv:duplicate:2",
    time: 1_700_000_000,
    price: null,
    kind: "note" as const,
    label: "",
    note: "",
    color: "#f59e0b",
    source: "csv" as const,
    extra: {},
  };
  assert.throws(() => store.importBatch([draft, draft]), /重复/);
  assert.equal(store.getSnapshot().events.length, 0);
});
