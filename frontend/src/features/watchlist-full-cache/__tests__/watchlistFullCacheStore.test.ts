import assert from "node:assert/strict";
import test from "node:test";

import {
  getFullCacheEntry,
  getWarmRows,
  mergeFullCacheRows,
  patchFullCacheRealtimeKline,
  resetWatchlistFullCache,
} from "../watchlistFullCacheStore.js";
import {
  epochSeconds,
  mustBeDefined,
} from "../../../test/testHelpers.js";

test("watchlist full cache stores and reads rows by symbolKey and interval", () => {
  resetWatchlistFullCache();

  mergeFullCacheRows(
    "okx:spot:BTC-USDT",
    "1h",
    [
      { time: epochSeconds(1000), open: 1, high: 2, low: 1, close: 2, volume: 10 },
      { time: epochSeconds(1060), open: 2, high: 3, low: 2, close: 3, volume: 11 },
    ],
    { status: "warm", source: "latest" },
  );

  const entry = mustBeDefined(getFullCacheEntry("okx:spot:BTC-USDT", "1h"));
  assert.equal(entry.status, "warm");
  assert.deepEqual(entry.coverage, { firstTime: 1000, lastTime: 1060, bars: 2 });

  const warm = mustBeDefined(getWarmRows("okx:spot:BTC-USDT", "1h"));
  assert.equal(warm.rows.length, 2);
  assert.equal(warm.source, "latest");
});

test("watchlist full cache patches realtime klines without replacing other intervals", () => {
  resetWatchlistFullCache();

  mergeFullCacheRows("spot:BTCUSDT", "1m", [{ time: epochSeconds(1000), close: 1 }]);
  mergeFullCacheRows("spot:BTCUSDT", "1h", [{ time: epochSeconds(1000), close: 10 }]);

  patchFullCacheRealtimeKline("spot:BTCUSDT", "1m", { time: epochSeconds(1060), close: 2 });
  patchFullCacheRealtimeKline("spot:BTCUSDT", "1h", { time: epochSeconds(1000), close: 11 });

  assert.deepEqual(
    mustBeDefined(getWarmRows("spot:BTCUSDT", "1m")).rows.map((row) => row.close),
    [1, 2],
  );
  assert.deepEqual(
    mustBeDefined(getWarmRows("spot:BTCUSDT", "1h")).rows.map((row) => row.close),
    [11],
  );
});
