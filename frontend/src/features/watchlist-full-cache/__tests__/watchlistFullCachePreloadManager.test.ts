import assert from "node:assert/strict";
import test from "node:test";

import {
  createWatchlistFullCachePreloadManager,
  type FullCachePreloadFetchResult,
} from "../watchlistFullCachePreloadManager.js";
import {
  getFullCacheEntry,
  mergeFullCacheRows,
  patchFullCacheRealtimeKline,
  resetWatchlistFullCache,
  setFullCacheEntryStatus,
} from "../watchlistFullCacheStore.js";
import type { FullCachePreloadJob } from "../watchlistFullCacheTypes.js";
import { epochSeconds, mustBeDefined } from "../../../test/testHelpers.js";
import { ForegroundPreloadGate } from "../../market-data/foregroundPreloadGate.js";

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
      return { all_rows_final: true, data: rows(2), source: "test" };
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

  mustBeDefined(pending.get("BTCUSDT"))({
    all_rows_final: true,
    data: rows(1),
    source: "partial-test",
  });
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
      return { all_rows_final: true, data: rows(1), source: "partial-test" };
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
        resolve({ all_rows_final: true, data: rows(1), source: "test" });
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

test("preload manager fails closed when history finality is not explicit", async () => {
  resetWatchlistFullCache();
  const job = preloadJob("BTCUSDT", "45m");
  const manager = createWatchlistFullCachePreloadManager({
    fetchJob: async () => ({ data: rows(2), source: "untrusted-test" }),
  });

  manager.syncJobs([job]);
  await nextTurn();

  const entry = mustBeDefined(getFullCacheEntry(job.symbolKey, job.interval));
  assert.equal(entry.status, "stale");
  assert.equal(entry.source, "latest-untrusted");
  assert.deepEqual(entry.rows, []);
  manager.dispose();
});

test("preload manager fences concurrent authoritative realtime rows from older HTTP", async () => {
  resetWatchlistFullCache();
  const job = preloadJob("BTCUSDT", "1m");
  const time = epochSeconds(1_000);
  const baseRow = mustBeDefined(rows(1)[0]);
  mergeFullCacheRows(job.symbolKey, job.interval, [
    { ...baseRow, time, close: 10, is_closed: true },
  ]);
  const pending = new Map<string, (result: FullCachePreloadFetchResult) => void>();
  const manager = createWatchlistFullCachePreloadManager({
    fetchJob: (candidate) => new Promise((resolve) => {
      pending.set(candidate.symbol, resolve);
    }),
  });

  manager.syncJobs([job]);
  patchFullCacheRealtimeKline(
    job.symbolKey,
    job.interval,
    { ...baseRow, time, close: 20, is_closed: true },
    { eventType: "bar.amended", source: "ws", nowMs: 200 },
  );
  mustBeDefined(pending.get(job.symbol))({
    all_rows_final: true,
    data: [{ ...baseRow, time, close: 10, is_closed: true }],
    source: "latest",
  });
  await nextTurn();

  const entry = mustBeDefined(getFullCacheEntry(job.symbolKey, job.interval));
  assert.equal(entry.rows[0]?.close, 20);
  assert.equal(entry.status, "live");
  manager.dispose();
});

test("disabling preload aborts active work and clears loading state", async () => {
  resetWatchlistFullCache();
  const job = preloadJob("BTCUSDT", "45m");
  let aborted = false;
  const manager = createWatchlistFullCachePreloadManager({
    fetchJob: (_job, _limit, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }),
  });

  manager.syncJobs([job]);
  manager.syncJobs([job], { enabled: false });
  await nextTurn();

  assert.equal(aborted, true);
  assert.equal(mustBeDefined(getFullCacheEntry(job.symbolKey, job.interval)).status, "idle");
  manager.dispose();
});

test("shared foreground gate aborts, preserves, and resumes a desired preload exactly once", async () => {
  resetWatchlistFullCache();
  const job = preloadJob("BTCUSDT", "45m");
  const gate = new ForegroundPreloadGate(0);
  let calls = 0;
  let firstAborted = false;
  const manager = createWatchlistFullCachePreloadManager({
    foregroundPreloadGate: gate,
    fetchJob: async (_job, _limit, signal) => {
      calls += 1;
      if (calls > 1) return { all_rows_final: true, data: rows(2), source: "resumed" };
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          firstAborted = true;
          reject(new DOMException("Preempted", "AbortError"));
        }, { once: true });
      });
    },
  });

  manager.syncJobs([job]);
  assert.equal(calls, 1);
  const foreground = gate.enterForeground("initial-history");
  await nextTurn();
  assert.equal(firstAborted, true);
  assert.equal(calls, 1, "foreground ownership keeps the preserved job paused");
  assert.equal(mustBeDefined(getFullCacheEntry(job.symbolKey, job.interval)).status, "idle");

  foreground.release();
  await nextTurn();
  assert.equal(calls, 2);
  assert.equal(mustBeDefined(getFullCacheEntry(job.symbolKey, job.interval)).status, "warm");
  await nextTurn();
  assert.equal(calls, 2, "one foreground preemption produces only one resumed attempt");

  manager.dispose();
  gate.dispose();
});

test("shared gate reduces a manager configured for two workers to one speculative request globally", async () => {
  resetWatchlistFullCache();
  const first = preloadJob("BTCUSDT", "1h");
  const second = preloadJob("ETHUSDT", "1h");
  const gate = new ForegroundPreloadGate(0);
  const calls: string[] = [];
  let releaseFirst!: (result: FullCachePreloadFetchResult) => void;
  const manager = createWatchlistFullCachePreloadManager({
    concurrency: 2,
    foregroundPreloadGate: gate,
    fetchJob: (job) => {
      calls.push(job.symbol);
      if (job === first) {
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve({ all_rows_final: true, data: rows(2), source: "second" });
    },
  });

  manager.syncJobs([first, second]);
  assert.deepEqual(calls, ["BTCUSDT"]);
  releaseFirst({ all_rows_final: true, data: rows(2), source: "first" });
  await nextTurn();
  assert.deepEqual(calls, ["BTCUSDT", "ETHUSDT"]);

  manager.dispose();
  gate.dispose();
});
