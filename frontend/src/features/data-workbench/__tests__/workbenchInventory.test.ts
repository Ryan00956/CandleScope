import assert from "node:assert/strict";
import test from "node:test";
import {
  compareIntervals,
  groupGapsByInstrument,
  groupSeriesByInstrument,
  instrumentGroupKey,
} from "../workbenchInventory.js";
import type {
  StorageGapSample,
  StorageInventorySeries,
} from "../../../services/storageInventoryApi.js";

function series(
  overrides: Partial<StorageInventorySeries> & Pick<StorageInventorySeries, "symbol" | "interval">,
): StorageInventorySeries {
  return {
    exchange: "binance",
    marketType: "spot",
    totalCount: 10,
    earliestOpenMs: 100,
    latestOpenMs: 200,
    ...overrides,
  };
}

test("groups the same instrument's intervals and keeps spot separate from futures", () => {
  const groups = groupSeriesByInstrument([
    series({ symbol: "ETHUSDT", interval: "1h", totalCount: 3, earliestOpenMs: 50, latestOpenMs: 80 }),
    series({ symbol: "BTCUSDT", interval: "5m", totalCount: 20, earliestOpenMs: 120, latestOpenMs: 400 }),
    series({ symbol: "BTCUSDT", interval: "1m", totalCount: 50, earliestOpenMs: 90, latestOpenMs: 300 }),
    series({ symbol: "BTCUSDT", interval: "1m", marketType: "futures", totalCount: 7, earliestOpenMs: 10, latestOpenMs: 11 }),
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0]?.symbol, "BTCUSDT");
  assert.equal(groups[0]?.marketType, "futures");
  assert.deepEqual(groups[1]?.series.map((item) => item.interval), ["1m", "5m"]);
  assert.equal(groups[1]?.totalCount, 70);
  assert.equal(groups[1]?.earliestOpenMs, 90);
  assert.equal(groups[1]?.latestOpenMs, 400);
  assert.equal(groups[2]?.symbol, "ETHUSDT");
});

test("sorts mixed interval units by duration", () => {
  assert.ok(compareIntervals("1m", "5m") < 0);
  assert.ok(compareIntervals("1h", "1d") < 0);
  assert.ok(compareIntervals("15m", "1h") < 0);
});

test("groups gap samples by instrument and sums missing bars", () => {
  const groups = groupGapsByInstrument([
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1d", status: "partial", missingBars: 500, firstSeenAtMs: null, lastCheckedAtMs: null },
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1m", status: "failed", missingBars: 5, firstSeenAtMs: null, lastCheckedAtMs: null },
    { exchange: "okx", marketType: "spot", symbol: "BTCUSDT", interval: "1m", status: "partial", missingBars: 2, firstSeenAtMs: null, lastCheckedAtMs: null },
  ] satisfies StorageGapSample[]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.key, instrumentGroupKey("binance", "spot", "BTCUSDT"));
  assert.equal(groups[0]?.missingBars, 505);
  assert.deepEqual(groups[0]?.gaps.map((item) => item.interval), ["1m", "1d"]);
  assert.equal(groups[1]?.exchange, "okx");
});
