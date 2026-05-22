import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackfillCompletionRuntime } from "./useBackfillCompletionRuntime";
import { useKlineStreamRuntime } from "./useKlineStreamRuntime";
import { useChartBackgroundPrefetch } from "./useChartBackgroundPrefetch";
import { useChartDataRuntime } from "./useChartDataRuntime";
import { buildRenderableChartData } from "./chartDataRuntime";
import { buildChartDisplayState } from "./marketDataView";
import { useChartGapRecovery } from "./useChartGapRecovery";
import { useChartInitialLoad } from "./useChartInitialLoad";
import { useChartLoadMoreLeft } from "./useChartLoadMoreLeft";
import { parseIntervalSeconds } from "../../utils/intervals";

export function useMarketDataRuntime({
  session,
  realtimePriceRef,
  runtimeBridgeRef,
  requestIndicatorRange,
}) {
  const {
    symbol,
    exchange,
    marketType,
    interval,
    trackedIntervals,
    exchangeConfig,
  } = session.view;
  const {
    setDatasetVersion,
    getIntervalDays,
    handleVisibleRangeChange,
  } = session.actions;
  const {
    intervalRef,
    trackedIntervalsRef,
  } = session.refs;

  const {
    chartData,
    chartDataMeta,
    pendingInitialHistoryRef,
    cacheKey,
    getFromCache,
    getCache,
    setCache,
    hasCache,
    clearCache,
    mergeCacheData,
    patchCacheTick,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
  } = useChartDataRuntime({ exchange, marketType, symbol, interval });

  const renderChartData = useMemo(
    () => buildRenderableChartData(chartData, parseIntervalSeconds(interval)),
    [chartData, interval],
  );

  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const [error, setError] = useState(null);
  const [crosshairData, setCrosshairData] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState(null);
  const [wsStatus, setWsStatus] = useState("idle");

  const activeChartReady = chartData.length > 0 && chartDataMeta.status === "ready";

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

  const {
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    pendingLoadMoreLeftRef,
    handleNeedMoreLeft,
  } = useChartLoadMoreLeft({
    symbol,
    exchange,
    marketType,
    interval,
    chartData,
    loading,
    dataSource,
    cacheKey,
    commitMergedChartData,
    requestIndicatorRange,
  });

  const loadData = useChartInitialLoad({
    exchange,
    marketType,
    getIntervalDays,
    getFromCache,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
    pendingInitialHistoryRef,
    updateLastPrice,
    setConnectionStatus,
    setDatasetKey: setDatasetVersion,
    setLoading,
    setError,
    setLoadingMoreLeft,
    setHasMoreLeft,
    setCrosshairData,
    setDataSource,
  });

  useEffect(() => {
    loadData(symbol, interval, marketType, exchange);
  }, [symbol, interval, marketType, exchange, loadData]);

  const handleBackfillCompleted = useBackfillCompletionRuntime({
    symbol,
    exchange,
    marketType,
    intervalRef,
    loadingRef,
    pendingInitialHistoryRef,
    pendingLoadMoreLeftRef,
    cacheKey,
    getIntervalDays,
    mergeCacheData,
    commitMergedChartData,
    requestIndicatorRange,
    setLastPrice,
    setError,
    setConnectionStatus,
    setLoading,
    setDatasetKey: setDatasetVersion,
  });

  useKlineStreamRuntime({
    symbol,
    exchange,
    marketType,
    trackedIntervals,
    trackedIntervalsRef,
    intervalRef,
    getIntervalDays,
    commitMergedChartData,
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
    trackedIntervals,
    hasCache,
    setCache,
    enabled: activeChartReady,
  });

  const { resetGapRecovery } = useChartGapRecovery({
    loading,
    dataReady: activeChartReady,
    dataSource,
    symbol,
    exchange,
    marketType,
    intervalRef,
    trackedIntervalsRef,
    getIntervalDays,
    getCache,
    mergeCacheData,
    commitMergedChartData,
    requestIndicatorRange,
    updateLastPrice,
  });

  useEffect(() => {
    if (!runtimeBridgeRef) return;
    runtimeBridgeRef.current = {
      chartDataMeta,
      clearCache,
      clearChartData,
      resetGapRecovery,
      setLastPrice,
      setCrosshairData,
      setLoading,
      setError,
      setHasMoreLeft,
    };
  }, [
    chartDataMeta,
    clearCache,
    clearChartData,
    resetGapRecovery,
    runtimeBridgeRef,
    setHasMoreLeft,
  ]);

  const retry = useCallback(() => {
    loadData(symbol, interval, marketType, exchange);
  }, [exchange, interval, loadData, marketType, symbol]);

  const display = useMemo(
    () => buildChartDisplayState({
      crosshairData,
      lastPrice,
      wsStatus,
      exchange,
      exchangeConfig,
      marketType,
    }),
    [crosshairData, exchange, exchangeConfig, lastPrice, marketType, wsStatus],
  );

  return {
    view: {
      bars: chartData,
      renderBars: renderChartData,
      meta: chartDataMeta,
      loading,
      error,
      crosshairData,
      lastPrice,
      connectionStatus,
      dataSource,
      wsStatus,
      display,
    },
    actions: {
      retry,
      loadMoreLeft: handleNeedMoreLeft,
      onCrosshairMove: setCrosshairData,
      onVisibleRangeChange: handleVisibleRangeChange,
    },
    events: {
      onBackfillCompleted: handleBackfillCompleted,
    },
    status: {
      hasMoreLeft,
      loadingMoreLeft,
      activeChartReady,
      canLoadMoreLeft: hasMoreLeft && !loadingMoreLeft && !loading,
      barCount: chartData.length,
    },
  };
}