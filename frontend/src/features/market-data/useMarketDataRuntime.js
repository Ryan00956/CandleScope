import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKlineStreamRuntime } from "./useKlineStreamRuntime";
import { useChartBackgroundPrefetch } from "./useChartBackgroundPrefetch";
import { useChartDataRuntime } from "./useChartDataRuntime";
import { buildChartDisplayState } from "./marketDataView";
import { publishCrosshairData } from "./crosshairDisplayStore";
import { requestIndicatorRangeForWindowMeta } from "./indicatorRangeRuntime";
import { useChartInitialLoad } from "./useChartInitialLoad";
import { useChartLoadMoreLeft } from "./useChartLoadMoreLeft";
import { useSessionTransitionReset } from "./useSessionTransitionReset";
import { INDICATOR_RANGE_REQUEST_REASONS, useMarketDataEvents } from "./marketDataEvents";
import { defaultKlineApi } from "./feed/klineApi";
import { SeriesDataFeed } from "./feed/seriesDataFeed";
import { resolveInitialRows as resolveWatchlistInitialRows } from "../watchlist-full-cache/watchlistFullCacheResolver";

export function useMarketDataRuntime({
  session,
  realtimePriceRef,
}) {
  const {
    symbol,
    exchange,
    marketType,
    interval,
    sessionKey,
    trackedIntervals,
    prefetchIntervals,
    exchangeConfig,
  } = session.view;
  const {
    handleVisibleRangeChange,
    updateVisibleRangeDataMeta,
  } = session.actions;
  const {
    intervalRef,
    trackedIntervalsRef,
  } = session.refs;
  const lastSessionTransition = session.events?.lastTransition ?? null;
  const {
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    createIndicatorRangeRequester,
  } = useMarketDataEvents({ interval, sessionKey });
  const requestWindowDeltaIndicatorRange = useMemo(
    () => createIndicatorRangeRequester(INDICATOR_RANGE_REQUEST_REASONS.WINDOW_DELTA),
    [createIndicatorRangeRequester],
  );

  const {
    chartData,
    chartDataMeta,
    activeSeriesStore,
    pendingInitialHistoryRef,
    getFromCache,
    getCache,
    hasCache,
    clearCache,
    getCacheDiagnostics,
    trimCacheEntries,
    mergeCacheData,
    patchCacheTick,
    replaceChartData,
    clearChartData,
    markChartDataTransition,
    commitMergedChartData,
    commitPatchedChartData,
  } = useChartDataRuntime({ exchange, marketType, symbol, interval });

  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const [error, setError] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState(null);
  const [wsStatus, setWsStatus] = useState("idle");

  const activeChartReady = chartData.length > 0 && chartDataMeta.status === "ready";

  useEffect(() => {
    updateVisibleRangeDataMeta?.(chartDataMeta);
  }, [chartDataMeta, updateVisibleRangeDataMeta]);

  useEffect(() => {
    requestIndicatorRangeForWindowMeta(requestWindowDeltaIndicatorRange, chartDataMeta);
  }, [chartDataMeta, requestWindowDeltaIndicatorRange]);

  const updateLastPrice = useCallback((candidate, intv) => {
    setLastPrice((prev) => {
      if (!candidate || candidate.time == null) return prev;
      if (intv !== intervalRef.current) return prev;
      const rtPrice = realtimePriceRef.current;
      if (rtPrice != null) {
        return { ...candidate, close: rtPrice };
      }
      return candidate;
    });
  }, [intervalRef, realtimePriceRef]);

  const updateRealtimePrice = useCallback((closePrice) => {
    realtimePriceRef.current = closePrice;
    setLastPrice((prev) => {
      if (!prev) return prev;
      if (prev.close === closePrice) return prev;
      return { ...prev, close: closePrice };
    });
  }, [realtimePriceRef]);

  const seriesDataFeed = useMemo(() => new SeriesDataFeed(), []);
  useEffect(() => {
    seriesDataFeed.configure({
      api: defaultKlineApi,
      getActiveSeries: () => ({
        exchange,
        marketType,
        symbol,
        interval,
      }),
      mergeCacheData,
      commitMergedChartData,
      commitPatchedChartData,
      patchCacheTick,
    });
  }, [
    commitMergedChartData,
    commitPatchedChartData,
    exchange,
    interval,
    marketType,
    mergeCacheData,
    patchCacheTick,
    seriesDataFeed,
    symbol,
  ]);

  const resolveInitialRows = useCallback(
    (sym, intv, mt, ex) => resolveWatchlistInitialRows({
      symbol: sym,
      interval: intv,
      marketType: mt,
      exchange: ex,
      getMemoryRows: (cacheSymbol, cacheInterval) => getCache(cacheSymbol, cacheInterval, {
        marketType: mt,
        exchange: ex,
      }),
    }),
    [getCache],
  );

  const {
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    handleNeedMoreLeft,
  } = useChartLoadMoreLeft({
    symbol,
    exchange,
    marketType,
    interval,
    chartData,
    loading,
    dataSource,
    seriesDataFeed,
    commitMergedChartData,
  });

  useEffect(() => {
    if (chartDataMeta?.trimmedLeft > 0) {
      setHasMoreLeft(true);
    }
  }, [chartDataMeta?.trimmedLeft, setHasMoreLeft]);

  const loadData = useChartInitialLoad({
    exchange,
    marketType,
    getFromCache,
    resolveInitialRows,
    seriesDataFeed,
    replaceChartData,
    clearChartData,
    markChartDataTransition,
    commitMergedChartData,
    commitPatchedChartData,
    pendingInitialHistoryRef,
    updateLastPrice,
    setConnectionStatus,
    setLoading,
    setError,
    setLoadingMoreLeft,
    setHasMoreLeft,
    setCrosshairData: publishCrosshairData,
    setDataSource,
  });

  const handleBackfillCompleted = useCallback((msg) => seriesDataFeed.handleBackfillCompleted(msg, {
    activeSeries: {
      exchange,
      marketType,
      symbol,
      interval: intervalRef.current,
    },
    loading: loadingRef.current,
    pendingInitial: pendingInitialHistoryRef.current,
    clearPendingInitial: () => {
      pendingInitialHistoryRef.current = null;
    },
    getCacheRows: (series) => getCache(series.symbol, series.interval, {
      marketType: series.marketType,
      exchange: series.exchange,
    }),
    setLastPrice,
    setError,
    setConnectionStatus,
    setLoading,
  }), [
    exchange,
    getCache,
    intervalRef,
    loadingRef,
    marketType,
    pendingInitialHistoryRef,
    seriesDataFeed,
    setConnectionStatus,
    setError,
    setLastPrice,
    setLoading,
    symbol,
  ]);

  useKlineStreamRuntime({
    symbol,
    exchange,
    marketType,
    trackedIntervals,
    trackedIntervalsRef,
    intervalRef,
    seriesDataFeed,
    commitPatchedChartData,
    patchCacheTick,
    updateLastPrice,
    updateRealtimePrice,
    handleBackfillCompleted,
    setWsStatus,
  });

  useChartBackgroundPrefetch({
    symbol,
    exchange,
    marketType,
    trackedIntervals: prefetchIntervals,
    hasCache,
    seriesDataFeed,
    enabled: activeChartReady,
  });

  const resetForSessionTransition = useSessionTransitionReset({
    clearCache,
    interval,
    markChartDataTransition,
    realtimePriceRef,
    sessionKey,
    setCrosshairData: publishCrosshairData,
    setError,
    setHasMoreLeft,
    setLastPrice,
    setLoading,
    symbol,
  });

  useEffect(() => {
    resetForSessionTransition(lastSessionTransition);
    loadData(symbol, interval, marketType, exchange);
  }, [
    exchange,
    interval,
    lastSessionTransition,
    loadData,
    marketType,
    resetForSessionTransition,
    symbol,
  ]);

  const retry = useCallback(() => {
    loadData(symbol, interval, marketType, exchange);
  }, [exchange, interval, loadData, marketType, symbol]);

  const display = useMemo(
    () => buildChartDisplayState({
      lastPrice,
      wsStatus,
      exchange,
      exchangeConfig,
      marketType,
    }),
    [exchange, exchangeConfig, lastPrice, marketType, wsStatus],
  );

  return {
    view: {
      bars: chartData,
      seriesStore: activeSeriesStore,
      meta: chartDataMeta,
      loading,
      error,
      crosshairData: null,
      lastPrice,
      connectionStatus,
      dataSource,
      wsStatus,
      display,
    },
    actions: {
      retry,
      loadMoreLeft: handleNeedMoreLeft,
      onCrosshairMove: publishCrosshairData,
      onVisibleRangeChange: (range) => handleVisibleRangeChange(range, chartDataMeta),
      consumeIndicatorRangeRequest,
    },
    status: {
      hasMoreLeft,
      loadingMoreLeft,
      activeChartReady,
      canLoadMoreLeft: hasMoreLeft && !loadingMoreLeft && !loading,
      barCount: chartData.length,
      cacheDiagnostics: getCacheDiagnostics,
      trimCacheEntries,
      indicatorRangeRequests,
    },
  };
}
