import { useEffect, useMemo, useRef } from "react";
import { fetchLatestKlines } from "../../services/api.js";
import type { TransportKlineBar } from "../../services/apiPayloadParsers.js";
import { symbolKey } from "../../utils/symbolKey.js";
import { toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import {
  buildFullCachePreloadJobs,
  buildWatchlistFullSocketTargets,
  buildWatchlistFullCacheTargets,
} from "./watchlistFullCachePolicy.js";
import {
  markFullCacheError,
  mergeFullCacheRows,
  setFullCacheEntryStatus,
  WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
} from "./watchlistFullCacheStore.js";
import { createWatchlistFullCacheSocketManager } from "./watchlistFullCacheSocketManager.js";
import type {
  FullCacheTarget,
  FullCacheTargetOptions,
} from "./watchlistFullCacheTypes.js";

const PRELOAD_LIMIT = WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS;
const MAX_PRELOAD_JOBS = 16;
const MAX_PRELOAD_CONCURRENCY = 2;

export interface UseWatchlistFullCacheRuntimeOptions extends FullCacheTargetOptions {
  enabled?: boolean;
}

export interface WatchlistFullCacheRuntime {
  targets: FullCacheTarget[];
}

function normalizeHttpRows(rows: TransportKlineBar[]): KlineBar[] {
  return rows.flatMap((row) => {
    const time = toEpochSeconds(row.time);
    return time == null ? [] : [{ ...row, time }];
  });
}

export function useWatchlistFullCacheRuntime({
  watchlists = [],
  subscriptionTiers = {},
  exchangeCatalog = null,
  nativeIntervals = [],
  customIntervalRecords = [],
  currentSession = {},
  enabled = true,
}: UseWatchlistFullCacheRuntimeOptions = {}): WatchlistFullCacheRuntime {
  const socketManagerRef = useRef<ReturnType<typeof createWatchlistFullCacheSocketManager> | null>(
    null,
  );
  const {
    symbol: currentSymbol,
    exchange: currentExchange,
    marketType: currentMarketType,
    interval: currentInterval,
  } = currentSession;
  const currentSymbolKey = useMemo(
    () => symbolKey(currentSymbol, currentMarketType, currentExchange),
    [currentExchange, currentMarketType, currentSymbol],
  );

  const targets = useMemo(
    () => buildWatchlistFullCacheTargets({
      watchlists,
      subscriptionTiers,
      exchangeCatalog,
      nativeIntervals,
      customIntervalRecords,
      currentSession: {
        ...(currentExchange === undefined ? {} : { exchange: currentExchange }),
        ...(currentInterval === undefined ? {} : { interval: currentInterval }),
        ...(currentMarketType === undefined ? {} : { marketType: currentMarketType }),
        ...(currentSymbol === undefined ? {} : { symbol: currentSymbol }),
        symbolKey: currentSymbolKey,
      },
    }),
    [
      currentExchange,
      currentInterval,
      currentMarketType,
      currentSymbol,
      currentSymbolKey,
      customIntervalRecords,
      exchangeCatalog,
      nativeIntervals,
      subscriptionTiers,
      watchlists,
    ],
  );

  const socketTargets = useMemo(
    () => buildWatchlistFullSocketTargets({
      watchlists,
      subscriptionTiers,
      exchangeCatalog,
      nativeIntervals,
      customIntervalRecords,
      currentSession: {
        ...(currentExchange === undefined ? {} : { exchange: currentExchange }),
        interval: null,
        ...(currentMarketType === undefined ? {} : { marketType: currentMarketType }),
        symbol: null,
        symbolKey: null,
      },
    }),
    [
      currentExchange,
      currentMarketType,
      customIntervalRecords,
      exchangeCatalog,
      nativeIntervals,
      subscriptionTiers,
      watchlists,
    ],
  );

  useEffect(() => {
    const manager = createWatchlistFullCacheSocketManager();
    socketManagerRef.current = manager;
    return () => {
      manager.dispose();
      if (socketManagerRef.current === manager) socketManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    socketManagerRef.current?.syncTargets(socketTargets, enabled);
  }, [enabled, socketTargets]);

  useEffect(() => {
    if (!enabled || targets.length === 0) return undefined;
    const controller = new AbortController();
    const jobs = buildFullCachePreloadJobs(targets, {
      currentSymbolKey,
      maxJobs: MAX_PRELOAD_JOBS,
    });
    let index = 0;

    async function runWorker(): Promise<void> {
      while (!controller.signal.aborted && index < jobs.length) {
        const job = jobs[index];
        index += 1;
        if (!job) continue;
        setFullCacheEntryStatus(job.symbolKey, job.interval, "loading", { source: "latest" });
        try {
          const result = await fetchLatestKlines(
            job.symbol,
            job.interval,
            PRELOAD_LIMIT,
            job.marketType,
            job.exchange,
            "watchlist-full-cache",
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          mergeFullCacheRows(job.symbolKey, job.interval, normalizeHttpRows(result?.data || []), {
            status: "warm",
            source: typeof result?.source === "string" ? result.source : "latest",
          });
        } catch (error) {
          if (!controller.signal.aborted) markFullCacheError(job.symbolKey, job.interval, error);
        }
      }
    }

    const workerCount = Math.min(MAX_PRELOAD_CONCURRENCY, jobs.length);
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      void runWorker();
    }

    return () => controller.abort();
  }, [currentSymbolKey, enabled, targets]);

  return {
    targets,
  };
}
