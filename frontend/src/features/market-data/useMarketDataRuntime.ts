import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { intervalsSemanticallyEquivalent } from "../../utils/intervals.js";
import type { MutableRefObject } from "react";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import { resolveInitialRows as resolveWatchlistInitialRows } from "../watchlist-full-cache/watchlistFullCacheResolver.js";
import { useKlineStreamRuntime } from "./useKlineStreamRuntime.js";
import type { KlineWebSocketStatus } from "./useKlineStreamRuntime.js";
import { useChartBackgroundPrefetch } from "./useChartBackgroundPrefetch.js";
import { useChartDataRuntime } from "./useChartDataRuntime.js";
import type { ChartDataCommitMeta } from "./useChartDataRuntime.js";
import { buildChartDisplayState } from "./marketDataView.js";
import type { MarketDisplayData } from "./marketDataView.js";
import { publishCrosshairData } from "./crosshairDisplayStore.js";
import { requestIndicatorRangeForWindowMeta } from "./indicatorRangeRuntime.js";
import { useChartInitialLoad } from "./useChartInitialLoad.js";
import { useChartLoadMoreLeft } from "./useChartLoadMoreLeft.js";
import type { LoadMoreLeft } from "./useChartLoadMoreLeft.js";
import { useSessionTransitionReset } from "./useSessionTransitionReset.js";
import { INDICATOR_RANGE_REQUEST_REASONS, useMarketDataEvents } from "./marketDataEvents.js";
import { defaultKlineApi } from "./feed/klineApi.js";
import { SeriesDataFeed } from "./feed/seriesDataFeed.js";
import type { VisibleTimeRangeLike } from "./feed/gapRepairPlanner.js";
import type {
  BackfillCompletedMessage,
  IndicatorRangeEvent,
} from "./klineContracts.js";
import type { KlineBar } from "./marketDataTypes.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";

export interface UseMarketDataRuntimeOptions {
  session: ChartSessionRuntime;
  realtimePriceRef: MutableRefObject<number | null>;
}

export interface MarketDataRuntime {
  view: {
    bars: KlineBar[];
    seriesStore: ReturnType<typeof useChartDataRuntime>["activeSeriesStore"];
    meta: ChartDataCommitMeta;
    loading: boolean;
    error: unknown | null;
    crosshairData: null;
    lastPrice: KlineBar | null;
    connectionStatus: string;
    dataSource: string | null;
    wsStatus: KlineWebSocketStatus;
    display: ReturnType<typeof buildChartDisplayState>;
  };
  actions: {
    retry(): void;
    loadMoreLeft: LoadMoreLeft;
    onCrosshairMove: typeof publishCrosshairData;
    onVisibleRangeChange(range: unknown): void;
    consumeIndicatorRangeRequest(requestId: number): void;
  };
  status: {
    hasMoreLeft: boolean;
    loadingMoreLeft: boolean;
    activeChartReady: boolean;
    canLoadMoreLeft: boolean;
    barCount: number;
    cacheDiagnostics: ReturnType<typeof useChartDataRuntime>["getCacheDiagnostics"];
    trimCacheEntries: ReturnType<typeof useChartDataRuntime>["trimCacheEntries"];
    indicatorRangeRequests: IndicatorRangeEvent[];
  };
}

export function useMarketDataRuntime({
  session,
  realtimePriceRef,
}: UseMarketDataRuntimeOptions): MarketDataRuntime {
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
  const { intervalRef } = session.refs;
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

  const [error, setError] = useState<unknown | null>(null);
  const [lastPrice, setLastPrice] = useState<KlineBar | null>(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<KlineWebSocketStatus>("idle");

  const activeChartReady = chartData.length > 0 && chartDataMeta.status === "ready";

  useEffect(() => {
    updateVisibleRangeDataMeta?.(chartDataMeta);
  }, [chartDataMeta, updateVisibleRangeDataMeta]);

  useEffect(() => {
    requestIndicatorRangeForWindowMeta(requestWindowDeltaIndicatorRange, chartDataMeta);
  }, [chartDataMeta, requestWindowDeltaIndicatorRange]);

  const updateLastPrice = useCallback((candidate: KlineBar, intv: IntervalString) => {
    setLastPrice((prev) => {
      if (!candidate || candidate.time == null) return prev;
      if (!intervalsSemanticallyEquivalent(intv, intervalRef.current)) return prev;
      const rtPrice = realtimePriceRef.current;
      if (rtPrice != null) {
        return { ...candidate, close: rtPrice };
      }
      return candidate;
    });
  }, [intervalRef, realtimePriceRef]);

  const updateRealtimePrice = useCallback((closePrice: number) => {
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
    (sym: SymbolCode, intv: IntervalString, mt: MarketType, ex: ExchangeId) => resolveWatchlistInitialRows({
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
    if ((chartDataMeta.trimmedLeft || 0) > 0) {
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

  const getSeriesCacheRows = useCallback((series: {
    exchange: ExchangeId;
    marketType: MarketType;
    symbol: SymbolCode;
    interval: IntervalString;
  }) => getCache(series.symbol, series.interval, {
    marketType: series.marketType,
    exchange: series.exchange,
  }) || [], [getCache]);

  const handleBackfillCompleted = useCallback((msg: BackfillCompletedMessage) => seriesDataFeed.handleBackfillCompleted(msg, {
    activeSeries: {
      exchange,
      marketType,
      symbol,
      interval: intervalRef.current,
    },
    loading: loadingRef.current,
    pendingInitial: pendingInitialHistoryRef.current,
    getPendingInitial: () => pendingInitialHistoryRef.current,
    clearPendingInitial: () => {
      pendingInitialHistoryRef.current = null;
    },
    getCacheRows: getSeriesCacheRows,
    setLastPrice,
    setError,
    setConnectionStatus,
    setLoading,
  }), [
    exchange,
    getSeriesCacheRows,
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
    intervalRef,
    seriesDataFeed,
    commitPatchedChartData,
    patchCacheTick,
    getCacheRows: getSeriesCacheRows,
    updateLastPrice,
    updateRealtimePrice,
    handleBackfillCompleted,
    setWsStatus,
  });

  useChartBackgroundPrefetch({
    symbol,
    exchange,
    marketType,
    activeInterval: interval,
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
    void loadData(symbol, interval, marketType, exchange);
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
    void loadData(symbol, interval, marketType, exchange);
  }, [exchange, interval, loadData, marketType, symbol]);

  const handleMarketVisibleRangeChange = useCallback((range: unknown) => {
    handleVisibleRangeChange(range, chartDataMeta);
    const series = { exchange, marketType, symbol, interval };
    const heldRows = getSeriesCacheRows(series);
    void seriesDataFeed.repairVisibleGaps(
      series,
      heldRows,
      range as VisibleTimeRangeLike,
      { source: "visible-window-gap-planner" },
    );
  }, [
    chartDataMeta,
    exchange,
    getSeriesCacheRows,
    handleVisibleRangeChange,
    interval,
    marketType,
    seriesDataFeed,
    symbol,
  ]);

  const display = useMemo(
    () => buildChartDisplayState({
      lastPrice: lastPrice as MarketDisplayData | null,
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
      onVisibleRangeChange: handleMarketVisibleRangeChange,
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
