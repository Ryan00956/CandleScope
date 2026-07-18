import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKET_METRIC_SELECTION_STORAGE_KEY,
  MarketMetricSelectionStore,
  parseMarketMetricSelection,
} from "../marketMetricSelectionStore.js";
import {
  MARKET_METRIC_DEFINITIONS,
  type MarketMetricId,
} from "../marketMetricSelectionTypes.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function byId(store: MarketMetricSelectionStore, id: MarketMetricId) {
  const item = store.get(id);
  assert.ok(item);
  return item;
}

test("market metric definitions use stable IDs and default to no added panes", () => {
  assert.deepEqual(MARKET_METRIC_DEFINITIONS.map((item) => item.id), [
    "market:funding-rate",
    "market:open-interest",
    "market:liquidations",
  ]);

  const store = new MarketMetricSelectionStore({ storage: null });
  assert.deepEqual(
    store.getSnapshot().map(({ id, added, visible }) => ({ id, added, visible })),
    [
      { id: "market:funding-rate", added: false, visible: false },
      { id: "market:open-interest", added: false, visible: false },
      { id: "market:liquidations", added: false, visible: false },
    ],
  );
});

test("add, visibility toggle, and remove publish and persist canonical state", () => {
  const storage = new MemoryStorage();
  const store = new MarketMetricSelectionStore({ storage });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });

  store.add("market:funding-rate");
  assert.deepEqual(byId(store, "market:funding-rate"), {
    id: "market:funding-rate",
    channel: "funding_rate",
    added: true,
    visible: true,
  });

  store.toggleVisibility("market:funding-rate");
  assert.equal(byId(store, "market:funding-rate").visible, false);
  store.add("market:funding-rate");
  assert.equal(byId(store, "market:funding-rate").visible, false);
  store.remove("market:funding-rate");
  assert.deepEqual(byId(store, "market:funding-rate"), {
    id: "market:funding-rate",
    channel: "funding_rate",
    added: false,
    visible: false,
  });

  // Already removed is an idempotent no-op, including persistence/listeners.
  store.remove("market:funding-rate");
  store.toggleVisibility("market:open-interest");
  assert.equal(notifications, 3);
  unsubscribe();

  const persisted = storage.getItem(MARKET_METRIC_SELECTION_STORAGE_KEY);
  assert.ok(persisted);
  const restored = new MarketMetricSelectionStore({ storage });
  assert.deepEqual(restored.getSnapshot(), store.getSnapshot());
});

test("valid persisted added and hidden state restores independently", () => {
  const storage = new MemoryStorage();
  storage.setItem(MARKET_METRIC_SELECTION_STORAGE_KEY, JSON.stringify({
    version: 1,
    items: [
      { id: "market:funding-rate", added: true, visible: false },
      { id: "market:open-interest", added: true, visible: true },
    ],
  }));

  const store = new MarketMetricSelectionStore({ storage });
  assert.equal(byId(store, "market:funding-rate").added, true);
  assert.equal(byId(store, "market:funding-rate").visible, false);
  assert.equal(byId(store, "market:open-interest").added, true);
  assert.equal(byId(store, "market:open-interest").visible, true);
});

test("persistence parsing fails closed and strips unknown or invalid items", () => {
  for (const raw of [
    "{not-json",
    JSON.stringify([]),
    JSON.stringify({ version: 2, items: [] }),
    JSON.stringify({ version: 1, items: "not-an-array" }),
  ]) {
    assert.ok(parseMarketMetricSelection(raw).every((item) => (
      !item.added && !item.visible
    )));
  }

  const parsed = parseMarketMetricSelection(JSON.stringify({
    version: 1,
    items: [
      { id: "market:future-metric", added: true, visible: true },
      { id: "market:funding-rate", added: "yes", visible: true },
      { id: "market:open-interest", added: true, visible: false },
    ],
  }));

  assert.deepEqual(parsed.map(({ id, added, visible }) => ({ id, added, visible })), [
    { id: "market:funding-rate", added: false, visible: false },
    { id: "market:open-interest", added: true, visible: false },
    { id: "market:liquidations", added: false, visible: false },
  ]);
});

test("persisted visibility cannot remain true when the metric is not added", () => {
  const parsed = parseMarketMetricSelection(JSON.stringify({
    version: 1,
    items: [
      { id: "market:funding-rate", added: false, visible: true },
    ],
  }));
  const funding = parsed.find((item) => item.id === "market:funding-rate");
  assert.ok(funding);
  assert.equal(funding.visible, false);
});
