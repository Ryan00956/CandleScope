import assert from "node:assert/strict";
import test from "node:test";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { createLocalAnalysisMarkerSource } from "./localAnalysisMarkerSource.js";
import { LocalAnalysisEventStore } from "./localAnalysisStore.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("analysis markers render only when their immutable bar is loaded", () => {
  const seriesStore = new SeriesWindowStore({ intervalSeconds: 60 });
  seriesStore.replace([{ time: 100, open: 1, high: 2, low: 1, close: 2 }]);
  let id = 0;
  const eventStore = new LocalAnalysisEventStore({
    datasetId: "dataset-1",
    dataEpoch: "sha256:abc",
  }, { storage: new MemoryStorage(), idFactory: () => `event-${++id}` });
  eventStore.create({
    time: 100,
    price: 2,
    kind: "entry",
    label: "开仓候选",
    note: "",
    color: "#22c55e",
  });
  eventStore.create({
    time: 300,
    price: 4,
    kind: "note",
    label: "旧备注",
    note: "",
    color: "#f59e0b",
  });
  const source = createLocalAnalysisMarkerSource({ eventStore, seriesStore });

  const initial = source.getSnapshot();
  assert.equal(initial.markers.length, 1);
  assert.deepEqual(initial.markers[0], {
    id: "local-analysis:event-1",
    time: 100,
    color: "#22c55e",
    text: "开仓候选",
    size: 1.15,
    position: "belowBar",
    shape: "arrowUp",
  });
  assert.strictEqual(source.getSnapshot(), initial);

  seriesStore.applyRange([{ time: 300, open: 3, high: 4, low: 3, close: 4 }]);
  const withHistory = source.getSnapshot();
  assert.equal(withHistory.markers.length, 2);
  assert.ok(withHistory.revision > initial.revision);
  assert.equal(withHistory.markers[1]?.shape, "circle");
});

test("marker subscribers observe both event edits and loaded-axis changes", () => {
  const seriesStore = new SeriesWindowStore({ intervalSeconds: 60 });
  seriesStore.replace([{ time: 100, open: 1, high: 1, low: 1, close: 1 }]);
  const eventStore = new LocalAnalysisEventStore({
    datasetId: "dataset-1",
    dataEpoch: "sha256:abc",
  }, { storage: new MemoryStorage(), idFactory: () => "event-1" });
  const source = createLocalAnalysisMarkerSource({ eventStore, seriesStore });
  let notifications = 0;
  const unsubscribe = source.subscribe(() => { notifications += 1; });

  eventStore.create({
    time: 100,
    price: 1,
    kind: "signal",
    label: "信号",
    note: "",
    color: "#8b5cf6",
  });
  seriesStore.applyRange([{ time: 160, open: 1, high: 1, low: 1, close: 1 }]);
  assert.equal(notifications, 2);
  unsubscribe();
});

test("source-period events project onto their containing derived candle", () => {
  const seriesStore = new SeriesWindowStore({ intervalSeconds: 1800 });
  seriesStore.replace([{ time: 0, open: 1, high: 2, low: 1, close: 2 }]);
  const eventStore = new LocalAnalysisEventStore({
    datasetId: "dataset-1",
    dataEpoch: "sha256:abc",
  }, { storage: new MemoryStorage(), idFactory: () => "event-derived" });
  eventStore.create({
    time: 900,
    price: 2,
    kind: "note",
    label: "15m source event",
    note: "",
    color: "#f59e0b",
  });
  const source = createLocalAnalysisMarkerSource({
    eventStore,
    seriesStore,
    interval: "30m",
  });

  assert.equal(source.getSnapshot().markers[0]?.time, 0);
});
