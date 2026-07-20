import assert from "node:assert/strict";
import test from "node:test";

import { klineDependencyKey } from "../../cache-gc/cacheRegistry.js";
import { isSameSeries } from "../rangeRuntime.js";

test("cache dependencies and series comparisons share semantic interval identity", () => {
  const base = { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" };
  assert.equal(
    klineDependencyKey({ ...base, interval: "60m" }),
    klineDependencyKey({ ...base, interval: "1h" }),
  );
  assert.equal(
    isSameSeries({ ...base, interval: "24h" }, { ...base, interval: "1d" }),
    true,
  );
  assert.equal(
    isSameSeries({ ...base, interval: "7d" }, { ...base, interval: "1w" }),
    false,
  );
});
