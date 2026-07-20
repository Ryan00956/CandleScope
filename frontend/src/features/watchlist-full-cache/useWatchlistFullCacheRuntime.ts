import { useEffect, useMemo, useRef } from "react";
import { symbolKey } from "../../utils/symbolKey.js";
import {
  buildFullCachePreloadJobs,
  buildWatchlistFullSocketTargets,
  buildWatchlistFullCacheTargets,
} from "./watchlistFullCachePolicy.js";
import { createWatchlistFullCachePreloadManager } from "./watchlistFullCachePreloadManager.js";
import { createWatchlistFullCacheSocketManager } from "./watchlistFullCacheSocketManager.js";
import type {
  FullCacheTarget,
  FullCacheTargetOptions,
} from "./watchlistFullCacheTypes.js";

const MAX_PRELOAD_JOBS = 16;

export interface UseWatchlistFullCacheRuntimeOptions extends FullCacheTargetOptions {
  enabled?: boolean;
}

export interface WatchlistFullCacheRuntime {
  targets: FullCacheTarget[];
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
  const preloadManagerRef = useRef<ReturnType<typeof createWatchlistFullCachePreloadManager> | null>(
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
    const manager = createWatchlistFullCachePreloadManager();
    preloadManagerRef.current = manager;
    return () => {
      manager.dispose();
      if (preloadManagerRef.current === manager) preloadManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    socketManagerRef.current?.syncTargets(socketTargets, enabled);
  }, [enabled, socketTargets]);

  const preloadJobs = useMemo(
    () => buildFullCachePreloadJobs(targets, {
      currentSymbolKey,
      excludeSeries: {
        symbolKey: currentSymbolKey,
        ...(currentInterval === undefined ? {} : { interval: currentInterval }),
      },
      maxJobs: MAX_PRELOAD_JOBS,
    }),
    [currentInterval, currentSymbolKey, targets],
  );

  useEffect(() => {
    preloadManagerRef.current?.syncJobs(preloadJobs, {
      enabled,
      activeSeries: {
        symbolKey: currentSymbolKey,
        ...(currentInterval === undefined ? {} : { interval: currentInterval }),
      },
    });
  }, [currentInterval, currentSymbolKey, enabled, preloadJobs]);

  return {
    targets,
  };
}
