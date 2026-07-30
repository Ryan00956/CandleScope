import { fetchLatestKlines } from "../../services/api.js";
import type { TransportKlineBar } from "../../services/apiPayloadParsers.js";
import { toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import {
  getFullCacheRealtimeVersion,
  getFullCacheEntry,
  isTrustedFullCachePreload,
  markFullCacheError,
  mergeFullCacheRows,
  setFullCacheEntryStatus,
  WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
} from "./watchlistFullCacheStore.js";
import type { FullCachePreloadJob } from "./watchlistFullCacheTypes.js";
import {
  canonicalizeIntervalValue,
  intervalsSemanticallyEquivalent,
} from "../../utils/intervals.js";
import type {
  ForegroundPreloadGate,
  PreloadLease,
} from "../market-data/foregroundPreloadGate.js";

export const WATCHLIST_FULL_CACHE_PRELOAD_LIMIT = WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS;
export const WATCHLIST_FULL_CACHE_PRELOAD_CONCURRENCY = 2;

export interface ActiveFullCacheSeries {
  symbolKey?: string | null;
  interval?: string | null;
}

export interface FullCachePreloadFetchResult {
  all_rows_final?: boolean;
  data?: TransportKlineBar[];
  source?: unknown;
}

export type FullCachePreloadFetcher = (
  job: FullCachePreloadJob,
  limit: number,
  signal: AbortSignal,
) => Promise<FullCachePreloadFetchResult>;

export interface WatchlistFullCachePreloadManagerOptions {
  concurrency?: number;
  fetchJob?: FullCachePreloadFetcher;
  foregroundPreloadGate?: ForegroundPreloadGate;
  limit?: number;
}

export interface WatchlistFullCachePreloadManager {
  dispose(): void;
  syncJobs(
    jobs: readonly FullCachePreloadJob[],
    options?: { activeSeries?: ActiveFullCacheSeries | null; enabled?: boolean },
  ): void;
}

interface ActivePreload {
  controller: AbortController;
  job: FullCachePreloadJob;
  lease?: PreloadLease;
}

function normalizeHttpRows(rows: TransportKlineBar[]): KlineBar[] {
  return rows.flatMap((row) => {
    const time = toEpochSeconds(row.time);
    return time == null ? [] : [{ ...row, time }];
  });
}

function defaultFetchJob(
  job: FullCachePreloadJob,
  limit: number,
  signal: AbortSignal,
): Promise<FullCachePreloadFetchResult> {
  return fetchLatestKlines(
    job.symbol,
    job.interval,
    limit,
    job.marketType,
    job.exchange,
    "watchlist-full-cache",
    { signal },
  );
}

export function fullCachePreloadJobKey(job: Pick<FullCachePreloadJob, "interval" | "symbolKey">): string {
  return `${job.symbolKey}\u0000${canonicalizeIntervalValue(job.interval) || job.interval}`;
}

export function isActiveFullCacheSeries(
  job: Pick<FullCachePreloadJob, "interval" | "symbolKey">,
  activeSeries: ActiveFullCacheSeries | null | undefined,
): boolean {
  return Boolean(
    activeSeries?.symbolKey
    && activeSeries.interval
    && job.symbolKey === activeSeries.symbolKey
    && intervalsSemanticallyEquivalent(job.interval, activeSeries.interval),
  );
}

export function shouldSkipSettledFullCachePreload(
  job: Pick<FullCachePreloadJob, "interval" | "symbolKey">,
  limit = WATCHLIST_FULL_CACHE_PRELOAD_LIMIT,
): boolean {
  const entry = getFullCacheEntry(job.symbolKey, job.interval);
  if (!entry) return false;
  if (entry.status === "loading") return true;
  return entry.rows.length >= limit && (entry.status === "warm" || entry.status === "live");
}

function restoreStatusAfterAbort(job: FullCachePreloadJob): void {
  const entry = getFullCacheEntry(job.symbolKey, job.interval);
  if (entry?.status !== "loading") return;
  setFullCacheEntryStatus(
    job.symbolKey,
    job.interval,
    entry.rows.length > 0 ? "partial" : "idle",
    { source: entry.source || "latest" },
  );
}

export function createWatchlistFullCachePreloadManager(
  options: WatchlistFullCachePreloadManagerOptions = {},
): WatchlistFullCachePreloadManager {
  const concurrency = Math.max(
    1,
    Math.floor(options.concurrency || WATCHLIST_FULL_CACHE_PRELOAD_CONCURRENCY),
  );
  const fetchJob = options.fetchJob || defaultFetchJob;
  const foregroundPreloadGate = options.foregroundPreloadGate;
  const limit = Math.max(1, Math.floor(options.limit || WATCHLIST_FULL_CACHE_PRELOAD_LIMIT));
  let desired = new Map<string, FullCachePreloadJob>();
  let queuedKeys: string[] = [];
  const active = new Map<string, ActivePreload>();
  const attemptedKeys = new Set<string>();
  let disposed = false;

  function pump(): void {
    if (disposed) return;
    while (active.size < concurrency && queuedKeys.length > 0) {
      const key = queuedKeys.shift();
      if (!key || active.has(key) || attemptedKeys.has(key)) continue;
      const job = desired.get(key);
      if (!job || shouldSkipSettledFullCachePreload(job, limit)) continue;

      const lease = foregroundPreloadGate?.tryAcquirePreload(
        `watchlist-full-cache:${key}`,
      );
      if (foregroundPreloadGate && !lease) {
        queuedKeys.unshift(key);
        return;
      }
      const controller = lease?.controller || new AbortController();
      const expectedRealtimeVersion = getFullCacheRealtimeVersion();
      attemptedKeys.add(key);
      active.set(key, {
        controller,
        job,
        ...(lease ? { lease } : {}),
      });
      setFullCacheEntryStatus(job.symbolKey, job.interval, "loading", { source: "latest" });

      void fetchJob(job, limit, controller.signal)
        .then((result) => {
          if (controller.signal.aborted || disposed) {
            restoreStatusAfterAbort(job);
            if (!disposed && desired.has(key)) attemptedKeys.delete(key);
            return;
          }
          if (!isTrustedFullCachePreload(result)) {
            const current = getFullCacheEntry(job.symbolKey, job.interval);
            if (current?.status !== "live") {
              setFullCacheEntryStatus(job.symbolKey, job.interval, "stale", {
                source: "latest-untrusted",
              });
            }
            return;
          }
          const current = getFullCacheEntry(job.symbolKey, job.interval);
          mergeFullCacheRows(job.symbolKey, job.interval, normalizeHttpRows(result?.data || []), {
            status: current?.status === "live" ? "live" : "warm",
            source: typeof result?.source === "string" ? result.source : "latest",
            expectedRealtimeVersion,
          });
        })
        .catch((error) => {
          if (controller.signal.aborted || disposed) {
            restoreStatusAfterAbort(job);
            if (!disposed && desired.has(key)) attemptedKeys.delete(key);
            return;
          }
          markFullCacheError(job.symbolKey, job.interval, error);
        })
        .finally(() => {
          if (active.get(key)?.controller === controller) active.delete(key);
          if (
            desired.has(key)
            && !attemptedKeys.has(key)
            && !queuedKeys.includes(key)
          ) queuedKeys.push(key);
          if (lease) foregroundPreloadGate?.release(lease);
          pump();
        });
    }
  }

  const unsubscribeForegroundGate = foregroundPreloadGate?.subscribe(pump) || (() => {});

  return {
    syncJobs(jobs, { activeSeries = null, enabled = true } = {}): void {
      if (disposed) return;
      const nextDesired = new Map<string, FullCachePreloadJob>();
      if (enabled) {
        for (const job of jobs) {
          if (isActiveFullCacheSeries(job, activeSeries)) continue;
          const key = fullCachePreloadJobKey(job);
          if (nextDesired.has(key)) continue;
          if (!active.has(key) && shouldSkipSettledFullCachePreload(job, limit)) continue;
          nextDesired.set(key, job);
        }
      }

      desired = nextDesired;
      for (const key of attemptedKeys) {
        if (!desired.has(key)) attemptedKeys.delete(key);
      }
      queuedKeys = queuedKeys.filter((key) => desired.has(key) && !attemptedKeys.has(key));
      for (const [key, running] of active) {
        if (!desired.has(key)) running.controller.abort();
      }

      const alreadyQueued = new Set(queuedKeys);
      for (const job of jobs) {
        const key = fullCachePreloadJobKey(job);
        if (
          !desired.has(key)
          || active.has(key)
          || attemptedKeys.has(key)
          || alreadyQueued.has(key)
        ) continue;
        queuedKeys.push(key);
        alreadyQueued.add(key);
      }
      pump();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      desired.clear();
      queuedKeys = [];
      attemptedKeys.clear();
      unsubscribeForegroundGate();
      for (const running of active.values()) {
        running.controller.abort();
        if (running.lease) foregroundPreloadGate?.release(running.lease);
      }
    },
  };
}
