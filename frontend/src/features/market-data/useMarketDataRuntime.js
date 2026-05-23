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
import { useSessionTransitionReset } from "./useSessionTransitionReset";
import { INDICATOR_RANGE_REQUEST_REASONS, useMarketDataEvents } from "./marketDataEvents";
import { parseIntervalSeconds } from "../../utils/intervals";

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
    exchangeConfig,
  } = session.view;
  const {
    setDatasetVersion,
    getIntervalDays,
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
  const requestLoadMoreIndicatorRange = useMemo(
    () => createIndicatorRangeRequester(INDICATOR_RANGE_REQUEST_REASONS.LOAD_MORE_LEFT),
    [createIndicatorRangeRequester],
  );
  const requestBackfillIndicatorRange = useMemo(
    () => createIndicatorRangeRequester(INDICATOR_RANGE_REQUEST_REASONS.BACKFILL_COMPLETED),
    [createIndicatorRangeRequester],
  );
  const requestGapRecoveryIndicatorRange = useMemo(
    () => createIndicatorRangeRequester(INDICATOR_RANGE_REQUEST_REASONS.GAP_RECOVERY),
    [createIndicatorRangeRequester],
  );

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

  useEffect(() => {
    updateVisibleRangeDataMeta?.(chartDataMeta);
  }, [chartDataMeta, updateVisibleRangeDataMeta]);

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
    requestIndicatorRange: requestLoadMoreIndicatorRange,
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
    requestIndicatorRange: requestBackfillIndicatorRange,
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
    requestIndicatorRange: requestGapRecoveryIndicatorRange,
    updateLastPrice,
  });

  const resetForSessionTransition = useSessionTransitionReset({
    clearCache,
    clearChartData,
    interval,
    realtimePriceRef,
    resetGapRecovery,
    sessionKey,
    setCrosshairData,
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
      onVisibleRangeChange: (range) => handleVisibleRangeChange(range, chartDataMeta),
    },
    events: {
      onBackfillCompleted: handleBackfillCompleted,
      indicatorRangeRequests,
      consumeIndicatorRangeRequest,
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
