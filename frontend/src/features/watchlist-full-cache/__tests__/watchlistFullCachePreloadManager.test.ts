import assert from "node:assert/strict";
import test from "node:test";

import {
  createWatchlistFullCachePreloadManager,
  type FullCachePreloadFetchResult,
} from "../watchlistFullCachePreloadManager.js";
import {
  getFullCacheEntry,
  mergeFullCacheRows,
  resetWatchlistFullCache,
  setFullCacheEntryStatus,
} from "../watchlistFullCacheStore.js";
import type { FullCachePreloadJob } from "../watchlistFullCacheTypes.js";
import { epochSeconds, mustBeDefined } from "../../../test/testHelpers.js";

function preloadJob(symbol: string, interval: string): FullCachePreloadJob {
  const symbolKey = `binance:futures:${symbol}`;
  return {
    symbolKey,
    symbol,
    exchange: "binance",
    marketType: "futures",
    intervals: [interval],
    preloadIntervals: [interval],
    interval,
  };
}

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: epochSeconds(1_000 + index * 60),
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
  }));
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("preload manager excludes the active series and skips warm or externally loading entries", async () => {
  resetWatchlistFullCache();
  const active = preloadJob("BTCUSDT", "45m");
  const warm = preloadJob("ETHUSDT", "1h");
  const loading = preloadJob("SOLUSDT", "1h");
  const cold = preloadJob("BNBUSDT", "1h");
  mergeFullCacheRows(warm.symbolKey, warm.interval, rows(2), { status: "warm" });
  setFullCacheEntryStatus(loading.symbolKey, loading.interval, "loading");
  const calls: string[] = [];
  const manager = createWatchlistFullCachePreloadManager({
    concurrency: 1,
    limit: 2,
    fetchJob: async (job) => {
      calls.push(`${job.symbol}@${job.interval}`);
      return { data: rows(2), source: "test" };
    },
  });

  manager.syncJobs([active, warm, loading, cold], {
    activeSeries: { symbolKey: active.symbolKey, interval: active.interval },
  });
  await nextTurn();

  assert.deepEqual(calls, ["BNBUSDT@1h"]);
  assert.equal(mustBeDefined(getFullCacheEntry(cold.symbolKey, cold.interval)).status, "warm");
  manager.dispose();
});

test("incremental sync preserves active work and a partial success does not spin", async () => {
  resetWatchlistFullCache();
  const first = preloadJob("BTCUSDT", "1h");
  const second = preloadJob("ETHUSDT", "1h");
  const third = preloadJob("SOLUSDT", "1h");
  const calls: string[] = [];
  const pending = new Map<string, (result: FullCachePreloadFetchResult) => void>();
  const manager = createWatchlistFullCachePreloadManager({
    concurrency: 1,
    limit: 2,
    fetchJob: (job) => new Promise((resolve) => {
      calls.push(job.symbol);
      pending.set(job.symbol, resolve);
    }),
  });

  manager.syncJobs([first, second]);
  assert.deepEqual(calls, ["BTCUSDT"]);
  manager.syncJobs([first, second, third]);
  assert.deepEqual(calls, ["BTCUSDT"], "syncing a new target must not restart the active job");

  mustBeDefined(pending.get("BTCUSDT"))({ data: rows(1), source: "partial-test" });
  await nextTurn();
  assert.deepEqual(calls, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(
    calls.filter((symbol) => symbol === "BTCUSDT").length,
    1,
    "a short successful response is settled for this sync generation",
  );

  manager.dispose();
});

test("an unrelated resync does not retry a settled partial job", async () => {
  resetWatchlistFullCache();
  const partial = preloadJob("BTCUSDT", "47m");
  const calls: string[] = [];
  const manager = createWatchlistFullCachePreloadManager({
    concurrency: 1,
    limit: 2,
    fetchJob: async (job) => {
      calls.push(`${job.symbol}@${job.interval}`);
      return { data: rows(1), source: "partial-test" };
    },
  });

  manager.syncJobs([partial]);
  await nextTurn();
  manager.syncJobs([partial]);
  await nextTurn();

  assert.deepEqual(calls, ["BTCUSDT@47m"]);
  manager.dispose();
});

test("making an inflight job active aborts it without putting the old job back in the queue", async () => {
  resetWatchlistFullCache();
  const first = preloadJob("BTCUSDT", "45m");
  const second = preloadJob("ETHUSDT", "1h");
  const calls: string[] = [];
  let firstAborted = false;
  const manager = createWatchlistFullCachePreloadManager({
    concurrency: 1,
    fetchJob: (job, _limit, signal) => new Promise((resolve, reject) => {
      calls.push(job.symbol);
      if (job !== first) {
        resolve({ data: rows(1), source: "test" });
        return;
      }
      signal.addEventListener("abort", () => {
        firstAborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }),
  });

  manager.syncJobs([first, second]);
  manager.syncJobs([first, second], {
    activeSeries: { symbolKey: first.symbolKey, interval: first.interval },
  });
  await nextTurn();

  assert.equal(firstAborted, true);
  assert.deepEqual(calls, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(calls.filter((symbol) => symbol === "BTCUSDT").length, 1);
  manager.dispose();
});
