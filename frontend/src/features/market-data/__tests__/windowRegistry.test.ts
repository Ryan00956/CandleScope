import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeriesWindowKey,
  createDetachedSeriesWindowStore,
  SeriesWindowRegistry,
} from "../window/windowRegistry.js";
import { mustBeDefined } from "../../../test/testHelpers.js";
import { toEpochSeconds } from "../marketDataTypes.js";

test("buildSeriesWindowKey normalizes exchange and market type", () => {
  assert.equal(
    buildSeriesWindowKey({
      exchange: "BINANCE",
      marketType: "SPOT",
      symbol: "BTCUSDT",
      interval: "1m",
    }),
    "binance-spot-BTCUSDT-1m",
  );
});

test("window registry key canonicalizes fixed-duration aliases", () => {
  const base = { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" };
  assert.equal(
    buildSeriesWindowKey({ ...base, interval: "60m" }),
    buildSeriesWindowKey({ ...base, interval: "1h" }),
  );
});

test("window registry key normalizes symbol case and isolates every market dimension", () => {
  const base = { exchange: "binance", marketType: "spot", symbol: "btcusdt", interval: "1m" };
  const canonical = buildSeriesWindowKey(base);

  assert.equal(canonical, buildSeriesWindowKey({ ...base, symbol: "BTCUSDT" }));
  assert.notEqual(canonical, buildSeriesWindowKey({ ...base, exchange: "okx" }));
  assert.notEqual(canonical, buildSeriesWindowKey({ ...base, marketType: "futures" }));
  assert.notEqual(canonical, buildSeriesWindowKey({ ...base, symbol: "ETHUSDT" }));
  assert.notEqual(canonical, buildSeriesWindowKey({ ...base, interval: "3m" }));
});

test("registry creates, returns, and evicts stores", () => {
  const registry = new SeriesWindowRegistry({ maxBars: 3 });
  const key = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "1m" });
  const store = registry.getOrCreate(key, {
    meta: { symbol: "BTCUSDT", interval: "1m" },
  });

  store.replace([{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }]);
  assert.equal(registry.get(key), store);
  assert.equal(registry.has(key), true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [2, 3, 4]);
  assert.equal(registry.meta(key).symbol, "BTCUSDT");
  const firstMetaRevision = Number(registry.meta(key).metaRevision);
  registry.touchMeta(key, { source: "cache-hit" });
  assert.equal(registry.meta(key).metaRevision, firstMetaRevision + 1);

  const evicted = mustBeDefined(registry.evict(key));
  assert.equal(evicted.key, key);
  assert.equal(evicted.bars, 3);
  assert.equal(registry.get(key), null);
});

test("registry propagates the live right-truncation fence to its stores", () => {
  const registry = new SeriesWindowRegistry({
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  const key = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "1m" });
  const store = registry.getOrCreate(key, { intervalSeconds: 1 });
  store.replace([{ time: 4 }, { time: 5 }, { time: 6 }]);
  store.applyRange([{ time: 1 }, { time: 2 }, { time: 3 }]);

  const delta = store.applyTick({ time: 100 });

  assert.equal(delta.type, "noop");
  assert.equal(delta.ignoredRightTruncatedRows, 1);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
});

test("registry entries include store metadata", () => {
  const registry = new SeriesWindowRegistry();
  const key = buildSeriesWindowKey({ symbol: "ETHUSDT", interval: "5m" });
  registry.getOrCreate(key, {
    meta: { symbol: "ETHUSDT", interval: "5m", source: "test" },
  }).replace([{ time: 10 }]);

  assert.deepEqual(registry.entries().map((entry) => ({
    key: entry.key,
    bars: entry.store.barCount,
    symbol: entry.meta.symbol,
    source: entry.meta.source,
  })), [{
    key,
    bars: 1,
    symbol: "ETHUSDT",
    source: "test",
  }]);
});

test("activating a warm store preserves its data revision and every sibling store", () => {
  const registry = new SeriesWindowRegistry();
  const btc1mKey = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "1m" });
  const btc3mKey = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "3m" });
  const eth1mKey = buildSeriesWindowKey({ symbol: "ETHUSDT", interval: "1m" });
  const btc1m = registry.getOrCreate(btc1mKey);
  const btc3m = registry.getOrCreate(btc3mKey);
  const eth1m = registry.getOrCreate(eth1mKey);
  btc1m.replace([{ time: 60 }, { time: 120 }]);
  btc3m.replace([{ time: 180 }]);
  eth1m.replace([{ time: 240 }]);
  const snapshot = btc1m.snapshot();
  const version = btc1m.version;
  const axisRevision = btc1m.axisRevision;
  let emitted = 0;
  btc1m.subscribe(() => { emitted += 1; });

  const activation = mustBeDefined(registry.activate(btc1mKey));

  assert.equal(activation.store, btc1m);
  assert.equal(activation.rows, snapshot);
  assert.equal(btc1m.version, version);
  assert.equal(btc1m.axisRevision, axisRevision);
  assert.equal(emitted, 0);
  assert.equal(registry.get(btc3mKey), btc3m);
  assert.equal(registry.get(eth1mKey), eth1m);
  assert.deepEqual(btc3m.snapshot(), [{ time: 180 }]);
  assert.deepEqual(eth1m.snapshot(), [{ time: 240 }]);
});

test("activation misses do not create empty stores", () => {
  const registry = new SeriesWindowRegistry();
  const missingKey = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "1m" });

  assert.equal(registry.activate(missingKey), null);
  assert.equal(registry.entries().length, 0);

  registry.getOrCreate(missingKey);
  assert.equal(registry.activate(missingKey), null);
  assert.equal(registry.entries().length, 1);
});

test("a detached display store clears the target frame without mutating warm registry entries", () => {
  const registry = new SeriesWindowRegistry();
  const btcKey = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "1m" });
  const ethKey = buildSeriesWindowKey({ symbol: "ETHUSDT", interval: "1m" });
  const btcStore = registry.getOrCreate(btcKey);
  btcStore.replace([{ time: 60 }, { time: 120 }]);
  const snapshot = btcStore.snapshot();
  const version = btcStore.version;
  const axisRevision = btcStore.axisRevision;

  const detached = createDetachedSeriesWindowStore(ethKey, { intervalSeconds: 60 });

  assert.equal(detached.seriesKey, ethKey);
  assert.equal(detached.isEmpty(), true);
  assert.equal(detached.version, 0);
  assert.equal(registry.get(ethKey), null);
  assert.equal(registry.get(btcKey), btcStore);
  assert.equal(btcStore.snapshot(), snapshot);
  assert.equal(btcStore.version, version);
  assert.equal(btcStore.axisRevision, axisRevision);
});

test("desktop shared snapshots hydrate a new registry before gap repair and republish authoritative ranges", () => {
  const key = buildSeriesWindowKey({ symbol: "BTCUSDT", interval: "1m" });
  const published: Array<{ key: string; rows: readonly unknown[] }> = [];
  const row = (time: number) => ({
    time: mustBeDefined(toEpochSeconds(time)),
    open: 1,
    high: 2,
    low: 0,
    close: 1,
    volume: 3,
  });
  const registry = new SeriesWindowRegistry({
    sharedSnapshot: {
      read: (requested) => requested === key ? [row(60), row(120)] : [],
      publish: (publishedKey, rows) => published.push({ key: publishedKey, rows }),
    },
  });

  const store = registry.getOrCreate(key);
  assert.deepEqual(store.snapshot().map((value) => value.time), [60, 120]);
  assert.deepEqual(registry.sharedSnapshotDiagnostics(), {
    hydrations: 1,
    hydratedBars: 2,
    publishes: 0,
    publishErrors: 0,
  });

  store.applyRange([row(180)], { source: "gap-repair" });
  assert.equal(published.length, 1);
  assert.equal(published[0]?.key, key);
  assert.deepEqual(published[0]?.rows.map((value) => (value as { time: number }).time), [60, 120, 180]);
});
