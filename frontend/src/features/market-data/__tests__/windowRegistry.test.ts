import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeriesWindowKey,
  SeriesWindowRegistry,
} from "../window/windowRegistry.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

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
