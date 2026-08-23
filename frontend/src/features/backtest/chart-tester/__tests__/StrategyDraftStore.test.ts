import assert from "node:assert/strict";
import test from "node:test";

import {
  STRATEGY_DRAFT_STORAGE_KEY,
  StrategyDraftStore,
  createLocalStorageStrategyDraftAdapter,
  createMemoryStrategyDraftAdapter,
  type StrategyDraftStoreAdapter,
} from "../StrategyDraftStore.js";

const draft = (source: string) => ({
  id: "draft-12345678",
  displayName: "趋势策略",
  language: "pyne" as const,
  source,
  cursor: { line: 2, column: 4 },
});

test("draft source, language, cursor, revision, and save state live outside workspace", async () => {
  let now = 100;
  const adapter = createMemoryStrategyDraftAdapter();
  const store = new StrategyDraftStore(adapter, () => ++now);
  const states: string[] = [];
  store.subscribe((_id, view) => states.push(view.saveState));

  const first = await store.save(draft("return close"));
  const second = await store.save(draft("return close > open"));
  assert.equal(first.revision, 0);
  assert.equal(second.revision, 1);
  assert.equal(second.source, "return close > open");
  assert.deepEqual(second.cursor, { line: 2, column: 4 });
  assert.deepEqual(states, ["SAVING", "SAVED", "SAVING", "SAVED"]);

  const restored = new StrategyDraftStore(adapter);
  assert.equal((await restored.load(second.id)).record?.source, second.source);
  assert.equal(restored.snapshot(second.id).saveState, "SAVED");
});

test("concurrent draft saves serialize and preserve the newest revision", async () => {
  let now = 10;
  const store = new StrategyDraftStore(createMemoryStrategyDraftAdapter(), () => ++now);
  const [first, second] = await Promise.all([
    store.save(draft("first")),
    store.save(draft("second")),
  ]);
  assert.equal(first.revision, 0);
  assert.equal(second.revision, 1);
  assert.equal(store.snapshot(second.id).record?.source, "second");
});

test("adapter failures become an explicit ERROR state", async () => {
  const adapter: StrategyDraftStoreAdapter = {
    load: async () => null,
    save: async () => { throw new Error("disk unavailable"); },
    remove: async () => undefined,
  };
  const store = new StrategyDraftStore(adapter, () => 1);
  await assert.rejects(store.save(draft("source")), /disk unavailable/);
  assert.equal(store.snapshot(draft("source").id).saveState, "ERROR");
  assert.equal(store.snapshot(draft("source").id).error, "disk unavailable");
});

test("local storage adapter fails closed on malformed content and writes only its own key", async () => {
  const values = new Map<string, string>([[STRATEGY_DRAFT_STORAGE_KEY, "{broken"]]);
  const adapter = createLocalStorageStrategyDraftAdapter({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  });
  assert.equal(await adapter.load("draft-12345678"), null);
  const store = new StrategyDraftStore(adapter, () => 5);
  await store.save(draft("source"));
  assert.deepEqual([...values.keys()], [STRATEGY_DRAFT_STORAGE_KEY]);
  assert.match(values.get(STRATEGY_DRAFT_STORAGE_KEY) ?? "", /return|source/);
});
