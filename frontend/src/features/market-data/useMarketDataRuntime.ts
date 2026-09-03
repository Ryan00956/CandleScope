import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import {
  canResolveIntervalFromNativeValues,
  intervalsSemanticallyEquivalent,
} from "../../utils/intervals.js";
import type { MutableRefObject } from "react";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import { resolveInitialRows as resolveWatchlistInitialRows } from "../watchlist-full-cache/watchlistFullCacheResolver.js";
import { useKlineStreamRuntime } from "./useKlineStreamRuntime.js";
import type { KlineWebSocketStatus } from "./useKlineStreamRuntime.js";
import {
  ChartBackgroundPrefetchPriorityGate,
  hasChartForegroundWork,
  useChartBackgroundPrefetch,
} from "./useChartBackgroundPrefetch.js";
import type {
  ForegroundLease,
  ForegroundPreloadGate,
} from "./foregroundPreloadGate.js";
import { useChartDataRuntime } from "./useChartDataRuntime.js";
import { buildChartDisplayState } from "./marketDataView.js";
import type { MarketDisplayData } from "./marketDataView.js";
import { publishCrosshairData } from "./crosshairDisplayStore.js";
import { requestIndicatorRangeForWindowMeta } from "./indicatorRangeRuntime.js";
import {
  planInitialHistoryCountBack,
  planInitialViewportCountBack,
  useChartInitialLoad,
} from "./useChartInitialLoad.js";
import { useActiveChartHistoryHydration } from "./useActiveChartHistoryHydration.js";
import { useChartLoadMoreLeft } from "./useChartLoadMoreLeft.js";
import { useSessionTransitionReset } from "./useSessionTransitionReset.js";
import { useMarketDataEvents } from "./marketDataEvents.js";
import { defaultKlineApi } from "./feed/klineApi.js";
import {
  isKlineResultRepairPending,
  SeriesDataFeed,
} from "./feed/seriesDataFeed.js";
import type { VisibleTimeRangeLike } from "./feed/gapRepairPlanner.js";
import type {
  BackfillCompletedMessage,
  IndicatorRangeEvent,
  IndicatorWindowMeta,
} from "./klineContracts.js";
import type { KlineBar, MarketSeries } from "./marketDataTypes.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type { MarketDataRuntimeContract } from "./marketDataRuntimeContract.js";
import { getClientInstanceId } from "../../services/api.js";
import {
  isLegacyKlineSeriesIdentity,
  resolveKlineSeriesIdentity,
  type KlineSeriesIdentityInput,
} from "./klineSeriesIdentity.js";
import { useMarketDataWorkspaceResources } from "./marketDataWorkspaceContext.js";
import {
  planRightWindowPage,
  rightWindowPageReachedLatest,
  rightWindowPageRowsAreBounded,
} from "./rightWindowPagination.js";

let chartDemandScopeSequence = 0;
const chartDemandScopeRuntimeId = [
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 10),
].join("-");

function demandScopeDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function formatChartDemandScope(
  clientInstanceId: string,
  runtimeId: string,
  sequence: number,
  owner?: Readonly<{
    workspaceId?: string | undefined;
    windowId?: string | undefined;
    cellId?: string | undefined;
  }>,
): string {
  const base = `chart:${clientInstanceId}:${runtimeId}:${sequence}`;
  if (!owner?.workspaceId && !owner?.windowId && !owner?.cellId) return base;
  const expanded = [
    base,
    "workspace", owner.workspaceId || "_",
    "window", owner.windowId || "_",
    "cell", owner.cellId || "_",
  ].join(":");
  if (expanded.length <= 128) return expanded;
  const ownerIdentity = [owner.workspaceId || "_", owner.windowId || "_", owner.cellId || "_"].join("\u0000");
  return `${base}:owner:${demandScopeDigest(ownerIdentity)}`;
}

function createChartDemandScope(
  owner?: Readonly<{
    workspaceId?: string | undefined;
    windowId?: string | undefined;
    cellId?: string | undefined;
  }>,
): string {
  chartDemandScopeSequence += 1;
  // Fast Refresh can reload this module while the API transport module keeps
  // its client id. A per-module nonce prevents sequence 1 from reusing a
  // backend scope whose demand generation has already advanced.
  return formatChartDemandScope(
    getClientInstanceId(),
    chartDemandScopeRuntimeId,
    chartDemandScopeSequence,
    owner,
  );
}

export function shouldCommitRightWindowRestore({
  aborted = false,
  active = false,
  currentEpoch = -1,
  currentSessionKey = null,
  expectedEpoch = -1,
  expectedSessionKey = null,
}: {
  aborted?: boolean;
  active?: boolean;
  currentEpoch?: number;
  currentSessionKey?: string | null;
  expectedEpoch?: number;
  expectedSessionKey?: string | null;
} = {}): boolean {
  return !aborted
    && active
    && expectedSessionKey != null
    && currentSessionKey === expectedSessionKey
    && currentEpoch === expectedEpoch;
}

export function canRequestMoreLeftDuringRuntime({
  hasMoreLeft = false,
  loading = false,
  loadingMoreLeft = false,
  marketDataReady = false,
  restoringLatestWindow = false,
}: {
  hasMoreLeft?: boolean;
  loading?: boolean;
  loadingMoreLeft?: boolean;
  marketDataReady?: boolean;
  restoringLatestWindow?: boolean;
} = {}): boolean {
  return marketDataReady
    && hasMoreLeft
    && !loadingMoreLeft
    && !loading
    && !restoringLatestWindow;
}

export function canRequestRightWindowRestoreDuringRuntime({
  loading = false,
  loadingMoreLeft = false,
  marketDataReady = false,
  paginationPhase = "idle",
}: {
  loading?: boolean;
  loadingMoreLeft?: boolean;
  marketDataReady?: boolean;
  paginationPhase?: "idle" | "loading" | "pending" | "stalled" | "exhausted";
} = {}): boolean {
  return marketDataReady
    && !loading
    && !loadingMoreLeft
    && paginationPhase !== "loading"
    && paginationPhase !== "pending";
}

export interface UseMarketDataRuntimeOptions {
  session: ChartSessionRuntime;
  realtimePriceRef: MutableRefObject<number | null>;
  enabled?: boolean;
  foregroundPreloadGate?: ForegroundPreloadGate;
  backgroundPrefetchEnabled?: boolean;
  intervalPrefetchEnabled?: boolean;
  schedulerCellId?: string;
  workspaceId?: string;
  windowId?: string;
  initialViewportCountBackCap?: number;
}

export type MarketDataRuntime = MarketDataRuntimeContract;

export function useMarketDataRuntime({
  session,
  realtimePriceRef,
  enabled: runtimeEnabled = true,
  foregroundPreloadGate,
  backgroundPrefetchEnabled = true,
  intervalPrefetchEnabled = backgroundPrefetchEnabled,
  schedulerCellId,
  workspaceId,
  windowId,
  initialViewportCountBackCap,
}: UseMarketDataRuntimeOptions): MarketDataRuntime {
  const workspaceResources = useMarketDataWorkspaceResources();
  const {
    symbol,
    exchange,
    marketType,
    interval,
    sessionKey,
    trackedIntervals,
    prefetchIntervals,
    exchangeConfig,
    nativeIntervals,
    providerId,
    venue,
    assetClass,
    seriesVariant,
    priceAdjustment,
    sessionVariant,
    volumeSemantics,
  } = session.view;
  const seriesIdentity = useMemo<KlineSeriesIdentityInput>(() => (
    resolveKlineSeriesIdentity(exchange, {
      ...(providerId === undefined ? {} : { providerId }),
      ...(venue === undefined ? {} : { venue }),
      ...(assetClass === undefined ? {} : { assetClass }),
      ...(seriesVariant === undefined ? {} : { seriesVariant }),
      ...(priceAdjustment === undefined ? {} : { priceAdjustment }),
      ...(sessionVariant === undefined ? {} : { sessionVariant }),
      ...(volumeSemantics === undefined ? {} : { volumeSemantics }),
    })
  ), [
    assetClass,
    exchange,
    priceAdjustment,
    providerId,
    seriesVariant,
    sessionVariant,
    venue,
    volumeSemantics,
  ]);
  const activeSeries = useMemo<MarketSeries>(() => ({
    exchange,
    marketType,
    symbol,
    interval,
    ...seriesIdentity,
  }), [exchange, interval, marketType, seriesIdentity, symbol]);
  const legacySeries = isLegacyKlineSeriesIdentity(exchange, seriesIdentity);
  const {
    handleVisibleRangeChange,
    updateVisibleRangeDataMeta,
  } = session.actions;
  const { intervalRef } = session.refs;
  const {
    exchangeCatalogStatus,
    historyIntervalAvailable,
    marketDataReady: sessionMarketDataReady,
    webSocketReady: sessionWebSocketReady,
  } = session.status;
  const marketDataReady = runtimeEnabled && sessionMarketDataReady;
  const webSocketReady = runtimeEnabled && sessionWebSocketReady;
  const lastSessionTransition = session.events?.lastTransition ?? null;
  const {
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    publishIndicatorRangeRequest,
  } = useMarketDataEvents({ interval, sessionKey });
  const defaultForegroundPreloadGateRef = useRef<ChartBackgroundPrefetchPriorityGate | null>(null);
  if (defaultForegroundPreloadGateRef.current == null) {
    defaultForegroundPreloadGateRef.current = new ChartBackgroundPrefetchPriorityGate();
  }
  const backgroundPrefetchPriority = foregroundPreloadGate
    || defaultForegroundPreloadGateRef.current;
  const inactivePrefetchGateRef = useRef<ChartBackgroundPrefetchPriorityGate | null>(null);
  if (inactivePrefetchGateRef.current == null) {
    inactivePrefetchGateRef.current = new ChartBackgroundPrefetchPriorityGate();
  }
  const chartBackgroundPrefetchPriority = backgroundPrefetchEnabled
    ? backgroundPrefetchPriority
    : inactivePrefetchGateRef.current;
  const publishIndicatorWindowRange = useCallback((meta: IndicatorWindowMeta) => {
    requestIndicatorRangeForWindowMeta((start, end, reason, metadata) => {
      if (!reason) return false;
      const published = publishIndicatorRangeRequest(start, end, reason, metadata);
      if (published) backgroundPrefetchPriority.yieldToForeground();
      return published;
    }, meta);
  }, [backgroundPrefetchPriority, publishIndicatorRangeRequest]);

  const {
    chartData,
    chartDataMeta,
    activeSeriesStore,
    pendingInitialHistoryRef,
    getFromCache,
    getCache,
    hasCache,
    getCacheDiagnostics,
    trimCacheEntries,
    mergeCacheData,
    patchCacheTick,
    activateCachedChartData,
    detachActiveChartData,
    replaceChartData,
    markChartDataTransition,
    commitMergedChartData,
    commitForwardChartData,
    commitPatchedChartData,
  } = useChartDataRuntime({
    exchange,
    marketType,
    symbol,
    interval,
    ...seriesIdentity,
    onIndicatorWindowMeta: publishIndicatorWindowRange,
    ...(workspaceResources ? { windowRegistry: workspaceResources.windowRegistry } : {}),
  });

  const [loading, setLoading] = useState(true);
  const [initialHistoryPending, setInitialHistoryPending] = useState(false);
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const [error, setError] = useState<unknown | null>(null);
  const [lastPrice, setLastPrice] = useState<KlineBar | null>(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<KlineWebSocketStatus>("idle");
  useEffect(() => {
    if (runtimeEnabled) return;
    setLoading(false);
    setInitialHistoryPending(false);
    setError(null);
    setConnectionStatus("idle");
    setWsStatus("idle");
  }, [runtimeEnabled]);
  const lastEnabledSeriesRef = useRef<MarketSeries | null>(null);
  const activeSessionKeyRef = useRef(sessionKey);
  activeSessionKeyRef.current = sessionKey;
  const rightWindowRestoreRequestIdRef = useRef(0);
  const rightWindowRestoreAbortRef = useRef<AbortController | null>(null);
  const rightWindowRestoreInFlightRef = useRef<{
    requestId: number;
    sessionKey: string;
    promise: Promise<boolean>;
  } | null>(null);
  const [restoringLatestWindow, setRestoringLatestWindowState] = useState(false);
  const restoringLatestWindowRef = useRef(false);
  const setRestoringLatestWindow = useCallback((value: boolean) => {
    restoringLatestWindowRef.current = value;
    setRestoringLatestWindowState(value);
  }, []);
  const rightWindowPageRequestIdRef = useRef(0);
  const rightWindowPageAbortRef = useRef<AbortController | null>(null);
  const rightWindowPageInFlightRef = useRef<{
    requestId: number;
    sessionKey: string;
    promise: Promise<boolean>;
  } | null>(null);
  const [loadingMoreRight, setLoadingMoreRightState] = useState(false);
  const loadingMoreRightRef = useRef(false);
  const setLoadingMoreRight = useCallback((value: boolean) => {
    loadingMoreRightRef.current = value;
    setLoadingMoreRightState(value);
  }, []);
  const requestDemandRef = useRef<{
    scope: string;
    generation: number;
    sessionKey: string | null;
    ready: boolean;
  } | null>(null);
  if (requestDemandRef.current == null) {
    requestDemandRef.current = {
      scope: createChartDemandScope({
        workspaceId,
        windowId,
        cellId: schedulerCellId,
      }),
      generation: 0,
      sessionKey: null,
      ready: false,
    };
  }
  useEffect(() => {
    rightWindowRestoreAbortRef.current?.abort();
    rightWindowRestoreAbortRef.current = null;
    rightWindowRestoreInFlightRef.current = null;
    rightWindowPageAbortRef.current?.abort();
    rightWindowPageAbortRef.current = null;
    rightWindowPageInFlightRef.current = null;
    setRestoringLatestWindow(false);
    setLoadingMoreRight(false);
    return () => {
      rightWindowRestoreAbortRef.current?.abort();
      rightWindowRestoreAbortRef.current = null;
      rightWindowRestoreInFlightRef.current = null;
      rightWindowPageAbortRef.current?.abort();
      rightWindowPageAbortRef.current = null;
      rightWindowPageInFlightRef.current = null;
      restoringLatestWindowRef.current = false;
      loadingMoreRightRef.current = false;
    };
  }, [sessionKey, setLoadingMoreRight, setRestoringLatestWindow]);
  const nativeIntervalValues = useMemo(
    () => nativeIntervals.map((item) => item.value),
    [nativeIntervals],
  );
  const chartSeriesRequestGateRef = useRef({
    exchange,
    marketType,
    symbol,
    marketDataReady,
    webSocketReady,
    nativeIntervalValues,
  });

  useLayoutEffect(() => {
    chartSeriesRequestGateRef.current = {
      exchange,
      marketType,
      symbol,
      marketDataReady,
      webSocketReady,
      nativeIntervalValues,
    };
  }, [exchange, marketDataReady, marketType, nativeIntervalValues, symbol, webSocketReady]);

  const activeChartReady = marketDataReady
    && chartData.length > 0
    && chartDataMeta.status === "ready";

  useEffect(() => {
    updateVisibleRangeDataMeta?.(chartDataMeta);
  }, [chartDataMeta, updateVisibleRangeDataMeta]);

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
  const canRequestChartSeries = useCallback((candidate: {
    exchange?: ExchangeId;
    marketType?: MarketType;
    symbol?: SymbolCode;
    interval?: IntervalString;
  }): boolean => {
    const gate = chartSeriesRequestGateRef.current;
    if (!gate.marketDataReady) return false;
    if (candidate.exchange != null && candidate.exchange !== gate.exchange) return false;
    if (candidate.marketType != null && candidate.marketType !== gate.marketType) return false;
    if (candidate.symbol != null && candidate.symbol !== gate.symbol) return false;
    if (candidate.interval == null) return gate.webSocketReady;
    return canResolveIntervalFromNativeValues(
      candidate.interval,
      gate.nativeIntervalValues,
    );
  }, []);
  // The stream and initial-history runtimes mount in layout effects. Configure
  // their shared feed in the earlier layout-effect slot as well, so the
  // multi-chart scheduler cannot subscribe before the API/stream adapters are
  // attached after a fresh mount or cell remount.
  useLayoutEffect(() => {
    seriesDataFeed.configure({
      api: workspaceResources?.klineApi || defaultKlineApi,
      chartWorkScheduler: workspaceResources?.workScheduler || null,
      chartWorkSchedulerCellId: schedulerCellId || null,
      foregroundPreloadGate: backgroundPrefetchPriority,
      canRequestSeries: canRequestChartSeries,
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
      ...(workspaceResources
        ? { streamFactory: workspaceResources.streamCoordinator.subscribe }
        : {}),
    });
  }, [
    backgroundPrefetchPriority,
    commitMergedChartData,
    commitPatchedChartData,
    canRequestChartSeries,
    exchange,
    interval,
    marketType,
    mergeCacheData,
    patchCacheTick,
    seriesDataFeed,
    symbol,
    workspaceResources,
    schedulerCellId,
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
    hasActivePaginationOwnership,
    paginationState,
    resetPagination,
  } = useChartLoadMoreLeft({
    enabled: marketDataReady,
    symbol,
    exchange,
    marketType,
    interval,
    seriesIdentity,
    nativeIntervalValues,
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
    enabled: marketDataReady,
    exchange,
    marketType,
    seriesIdentity,
    nativeIntervalValues,
    ...(initialViewportCountBackCap === undefined ? {} : { initialViewportCountBackCap }),
    getFromCache,
    resolveInitialRows,
    seriesDataFeed,
    activateCachedChartData,
    detachActiveChartData,
    replaceChartData,
    markChartDataTransition,
    commitMergedChartData,
    commitPatchedChartData,
    pendingInitialHistoryRef,
    setInitialHistoryPending,
    updateLastPrice,
    setConnectionStatus,
    setLoading,
    setError,
    setLoadingMoreLeft,
    setHasMoreLeft,
    setCrosshairData: publishCrosshairData,
    setDataSource,
  });

  const activeHistoryTargetCountBack = planInitialHistoryCountBack(
    interval,
    nativeIntervalValues,
  );
  const plannedActiveHistoryViewportCountBack = planInitialViewportCountBack(
    interval,
    nativeIntervalValues,
  );
  const activeHistoryViewportCountBack = initialViewportCountBackCap == null
    ? plannedActiveHistoryViewportCountBack
    : Math.min(
        plannedActiveHistoryViewportCountBack,
        Math.max(1, Math.floor(initialViewportCountBackCap)),
      );
  useActiveChartHistoryHydration({
    // Deepen the active interval after first paint even in a dense workspace;
    // this is active-chart hydration, not speculative cross-interval warming.
    enabled: backgroundPrefetchEnabled
      && activeChartReady
      && marketDataReady
      && !loading
      && !initialHistoryPending,
    series: activeSeries,
    sessionKey,
    viewportCountBack: activeHistoryViewportCountBack,
    targetCountBack: activeHistoryTargetCountBack,
    historyComplete: chartDataMeta.historyComplete === true,
    historyRepairPending: chartDataMeta.historyRepairPending === true,
    validatedCountBack: chartDataMeta.historyValidatedCountBack ?? null,
    seriesDataFeed,
    priorityGate: chartBackgroundPrefetchPriority,
    commitMergedChartData,
  });

  const loadMoreRight = useCallback((): Promise<boolean> => {
    backgroundPrefetchPriority.yieldToForeground();
    if (!marketDataReady || activeSessionKeyRef.current !== sessionKey) {
      return Promise.resolve(false);
    }
    const currentRequest = rightWindowPageInFlightRef.current;
    if (currentRequest?.sessionKey === sessionKey) return currentRequest.promise;
    if (
      rightWindowRestoreInFlightRef.current != null
      || loadingMoreRightRef.current
      || hasActivePaginationOwnership()
      || !canRequestRightWindowRestoreDuringRuntime({
        loading,
        loadingMoreLeft,
        marketDataReady,
        paginationPhase: paginationState.phase,
      })
      || !activeSeriesStore?.rightTruncated
    ) return Promise.resolve(false);

    const lastLoaded = activeSeriesStore.last();
    const plan = planRightWindowPage(interval, lastLoaded?.time);
    const demand = requestDemandRef.current;
    if (!plan || !demand?.ready || demand.sessionKey !== sessionKey) {
      return Promise.resolve(false);
    }

    resetPagination();
    const series = activeSeries;
    const epoch = seriesDataFeed.beginEpoch(series);
    const controller = new AbortController();
    rightWindowPageAbortRef.current?.abort();
    rightWindowPageAbortRef.current = controller;
    const requestId = rightWindowPageRequestIdRef.current + 1;
    rightWindowPageRequestIdRef.current = requestId;
    const expectedDemandScope = demand.scope;
    const expectedDemandGeneration = demand.generation;
    const owner = {
      requestId,
      sessionKey,
      promise: Promise.resolve(false),
    };
    rightWindowPageInFlightRef.current = owner;
    setLoadingMoreRight(true);

    const ownsRequest = () => {
      const currentDemand = requestDemandRef.current;
      return rightWindowPageInFlightRef.current === owner
        && currentDemand?.ready === true
        && currentDemand.sessionKey === sessionKey
        && currentDemand.scope === expectedDemandScope
        && currentDemand.generation === expectedDemandGeneration
        && shouldCommitRightWindowRestore({
          aborted: controller.signal.aborted,
          active: seriesDataFeed.shouldCommitActive(series),
          currentEpoch: seriesDataFeed.currentEpoch(series),
          currentSessionKey: activeSessionKeyRef.current,
          expectedEpoch: epoch,
          expectedSessionKey: sessionKey,
        });
    };

    const promise = (async () => {
      try {
        const result = await seriesDataFeed.getRange(series, {
          start: plan.start,
          end: plan.end,
          repair: "wait",
          waitMs: 1_500,
          strict: true,
          source: "right-window-page",
          signal: controller.signal,
          commit: "none",
          maxPages: 1,
        });
        const reachedLatest = rightWindowPageReachedLatest(result, plan);
        const rows = result.data || [];
        const settledEmptyTail = reachedLatest
          && rows.length === 0
          && result.complete === true;
        if (
          !ownsRequest()
          || result.stale
          || result.active === false
          || isKlineResultRepairPending(result)
          || result.verified_contiguous !== true
          || !rightWindowPageRowsAreBounded(rows, plan)
          || (!settledEmptyTail && (rows.length === 0 || result.all_rows_final !== true))
        ) return false;

        const committed = commitForwardChartData(symbol, interval, rows, {
          reachedLatest,
          source: reachedLatest ? "right-window-page-current" : "right-window-page",
        });
        if (!committed) return false;
        setHasMoreLeft(true);
        setDataSource(result.source || "right-window-page");
        setConnectionStatus("connected");
        setError(null);
        return true;
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Next K-line history page failed; retaining the current historical window", error);
        }
        return false;
      } finally {
        if (rightWindowPageInFlightRef.current === owner) {
          rightWindowPageInFlightRef.current = null;
          setLoadingMoreRight(false);
        }
        if (rightWindowPageAbortRef.current === controller) {
          rightWindowPageAbortRef.current = null;
        }
      }
    })();
    owner.promise = promise;
    return promise;
  }, [
    activeSeries,
    activeSeriesStore,
    backgroundPrefetchPriority,
    commitForwardChartData,
    hasActivePaginationOwnership,
    interval,
    loading,
    loadingMoreLeft,
    marketDataReady,
    paginationState.phase,
    resetPagination,
    seriesDataFeed,
    sessionKey,
    setHasMoreLeft,
    setLoadingMoreRight,
    symbol,
  ]);

  const restoreLatestWindow = useCallback((): Promise<boolean> => {
    backgroundPrefetchPriority.yieldToForeground();
    if (!marketDataReady || activeSessionKeyRef.current !== sessionKey) {
      return Promise.resolve(false);
    }
    const currentRequest = rightWindowRestoreInFlightRef.current;
    if (currentRequest?.sessionKey === sessionKey) return currentRequest.promise;
    rightWindowPageAbortRef.current?.abort();
    rightWindowPageAbortRef.current = null;
    rightWindowPageInFlightRef.current = null;
    setLoadingMoreRight(false);
    if (hasActivePaginationOwnership() || !canRequestRightWindowRestoreDuringRuntime({
      loading,
      loadingMoreLeft,
      marketDataReady,
      paginationPhase: paginationState.phase,
    })) return Promise.resolve(false);

    const countBack = planInitialHistoryCountBack(interval, nativeIntervalValues);
    const demand = requestDemandRef.current;
    if (
      countBack <= 0
      || !demand?.ready
      || demand.sessionKey !== sessionKey
    ) return Promise.resolve(false);

    resetPagination();
    const series = activeSeries;
    const epoch = seriesDataFeed.beginEpoch(series);
    const controller = new AbortController();
    rightWindowRestoreAbortRef.current?.abort();
    rightWindowRestoreAbortRef.current = controller;
    const requestId = rightWindowRestoreRequestIdRef.current + 1;
    rightWindowRestoreRequestIdRef.current = requestId;
    const expectedDemandScope = demand.scope;
    const expectedDemandGeneration = demand.generation;
    const owner = {
      requestId,
      sessionKey,
      promise: Promise.resolve(false),
    };
    rightWindowRestoreInFlightRef.current = owner;
    setRestoringLatestWindow(true);

    const ownsRequest = () => {
      const currentDemand = requestDemandRef.current;
      return rightWindowRestoreInFlightRef.current === owner
        && currentDemand?.ready === true
        && currentDemand.sessionKey === sessionKey
        && currentDemand.scope === expectedDemandScope
        && currentDemand.generation === expectedDemandGeneration
        && shouldCommitRightWindowRestore({
          aborted: controller.signal.aborted,
          active: seriesDataFeed.shouldCommitActive(series),
          currentEpoch: seriesDataFeed.currentEpoch(series),
          currentSessionKey: activeSessionKeyRef.current,
          expectedEpoch: epoch,
          expectedSessionKey: sessionKey,
        });
    };

    const promise = (async () => {
      try {
        const result = await seriesDataFeed.getBars(series, {
          countBack,
          source: "right-window-restore",
          signal: controller.signal,
          commit: "none",
        });
        if (
          !ownsRequest()
          || result.stale
          || result.active === false
          || isKlineResultRepairPending(result)
          || !result.data?.length
        ) return false;

        replaceChartData(symbol, interval, result.data, {
          source: "right-window-restore",
        });
        const latest = result.data.at(-1);
        if (latest) updateLastPrice(latest, interval);
        setHasMoreLeft(result.has_more !== false);
        setDataSource(result.source || "right-window-restore");
        setConnectionStatus("connected");
        setError(null);
        return true;
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Latest K-line window restore failed; retaining the historical window", error);
        }
        return false;
      } finally {
        if (rightWindowRestoreInFlightRef.current === owner) {
          rightWindowRestoreInFlightRef.current = null;
          setRestoringLatestWindow(false);
        }
        if (rightWindowRestoreAbortRef.current === controller) {
          rightWindowRestoreAbortRef.current = null;
        }
      }
    })();
    owner.promise = promise;
    return promise;
  }, [
    activeSeries,
    backgroundPrefetchPriority,
    interval,
    hasActivePaginationOwnership,
    loading,
    loadingMoreLeft,
    marketDataReady,
    nativeIntervalValues,
    paginationState.phase,
    replaceChartData,
    resetPagination,
    seriesDataFeed,
    sessionKey,
    setHasMoreLeft,
    setLoadingMoreRight,
    setRestoringLatestWindow,
    symbol,
    updateLastPrice,
  ]);

  const getSeriesCacheRows = useCallback((series: MarketSeries) => getCache(series.symbol, series.interval, {
    marketType: series.marketType,
    exchange: series.exchange,
  }) || [], [getCache]);

  const handleBackfillCompleted = useCallback((msg: BackfillCompletedMessage) => seriesDataFeed.handleBackfillCompleted(msg, {
    activeSeries: {
      ...activeSeries,
      interval: intervalRef.current,
    },
    loading: loadingRef.current,
    pendingInitial: pendingInitialHistoryRef.current,
    getPendingInitial: () => pendingInitialHistoryRef.current,
    clearPendingInitial: () => {
      const hadPendingInitial = pendingInitialHistoryRef.current != null;
      pendingInitialHistoryRef.current = null;
      if (hadPendingInitial) setInitialHistoryPending(false);
    },
    getCacheRows: getSeriesCacheRows,
    setLastPrice,
    setError,
    setConnectionStatus,
    setLoading,
  }), [
    activeSeries,
    getSeriesCacheRows,
    intervalRef,
    loadingRef,
    pendingInitialHistoryRef,
    seriesDataFeed,
    setConnectionStatus,
    setError,
    setLastPrice,
    setLoading,
  ]);

  useKlineStreamRuntime({
    enabled: webSocketReady,
    webSocketEnabled: webSocketReady,
    symbol,
    exchange,
    marketType,
    nativeIntervalValues,
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
    ...(schedulerCellId ? { schedulerCellId } : {}),
    workScheduler: workspaceResources?.workScheduler || null,
  });

  const foregroundIndicatorRequestCount = indicatorRangeRequests.length;
  const foregroundBusyLeaseRef = useRef<{
    gate: ForegroundPreloadGate;
    lease: ForegroundLease;
    sessionKey: string;
  } | null>(null);
  const isForegroundBusyForPrefetch = useCallback(() => {
    const activeSeries = {
      ...seriesIdentity,
      exchange,
      marketType,
      symbol,
      interval: intervalRef.current,
    };
    return hasChartForegroundWork({
      activePagination: hasActivePaginationOwnership(),
      indicatorRequests: foregroundIndicatorRequestCount,
      loading: loadingRef.current,
      pendingInitial: initialHistoryPending,
      pendingRepairs: seriesDataFeed.pendingRepairCount(activeSeries),
      restoringLatestWindow: restoringLatestWindowRef.current || loadingMoreRightRef.current,
    });
  }, [
    exchange,
    foregroundIndicatorRequestCount,
    hasActivePaginationOwnership,
    initialHistoryPending,
    intervalRef,
    marketType,
    seriesDataFeed,
    seriesIdentity,
    symbol,
  ]);
  const foregroundBusyOwnerActive = hasChartForegroundWork({
    activePagination: paginationState.phase === "loading" || paginationState.phase === "pending",
    indicatorRequests: foregroundIndicatorRequestCount,
    loading,
    loadingMoreLeft,
    pendingInitial: initialHistoryPending,
    pendingRepairs: seriesDataFeed.pendingRepairCount({
      ...activeSeries,
    }),
    restoringLatestWindow: restoringLatestWindow || loadingMoreRight,
  });
  useLayoutEffect(() => {
    const current = foregroundBusyLeaseRef.current;
    if (
      current
      && (
        current.gate !== backgroundPrefetchPriority
        || current.sessionKey !== sessionKey
        || !foregroundBusyOwnerActive
      )
    ) {
      current.lease.release();
      foregroundBusyLeaseRef.current = null;
    }
    if (foregroundBusyOwnerActive && foregroundBusyLeaseRef.current == null) {
      foregroundBusyLeaseRef.current = {
        gate: backgroundPrefetchPriority,
        lease: backgroundPrefetchPriority.acquireBusy(`chart-runtime:${sessionKey}`),
        sessionKey,
      };
    }
  }, [backgroundPrefetchPriority, foregroundBusyOwnerActive, sessionKey]);
  useLayoutEffect(() => () => {
    const current = foregroundBusyLeaseRef.current;
    if (current?.gate !== backgroundPrefetchPriority) return;
    current.lease.release();
    foregroundBusyLeaseRef.current = null;
  }, [backgroundPrefetchPriority]);

  useChartBackgroundPrefetch({
    symbol,
    exchange,
    marketType,
    activeInterval: interval,
    trackedIntervals: prefetchIntervals,
    nativeIntervals: nativeIntervalValues,
    hasCache,
    seriesDataFeed,
    priorityGate: backgroundPrefetchPriority,
    isForegroundBusy: isForegroundBusyForPrefetch,
    schedulerOwner: `chart-background-prefetch:${schedulerCellId || sessionKey}`,
    // Background interval warming must yield while the active chart is still
    // loading history, extending left, or waiting for indicator coverage.
    // Cross-interval warming is optional and disabled by the dense-workspace
    // policy. Keeping this separate prevents four active cells from walking
    // the complete interval catalog while 64 charts are converging.
    enabled: intervalPrefetchEnabled
      && legacySeries
      && activeChartReady
      && marketDataReady
      && !loading
      && !loadingMoreLeft
      && !loadingMoreRight
      && !initialHistoryPending
      && indicatorRangeRequests.length === 0,
  });

  const resetForSessionTransition = useSessionTransitionReset({
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

  useLayoutEffect(() => {
    backgroundPrefetchPriority.yieldToForeground();
    resetForSessionTransition(lastSessionTransition);
    const requestDemand = requestDemandRef.current!;
    if (marketDataReady) {
      if (!requestDemand.ready || requestDemand.sessionKey !== sessionKey) {
        requestDemand.generation += 1;
      }
      requestDemand.ready = true;
      requestDemand.sessionKey = sessionKey;
      const previousSeries = lastEnabledSeriesRef.current;
      if (
        previousSeries
        && seriesDataFeed.seriesKey(previousSeries) !== seriesDataFeed.seriesKey(activeSeries)
      ) {
        seriesDataFeed.cancelSeriesRequests(previousSeries);
      }
      seriesDataFeed.setRequestDemand(activeSeries, {
        scope: requestDemand.scope,
        generation: requestDemand.generation,
      });
      lastEnabledSeriesRef.current = activeSeries;
    } else if (lastEnabledSeriesRef.current) {
      seriesDataFeed.cancelSeriesRequests(lastEnabledSeriesRef.current);
      lastEnabledSeriesRef.current = null;
      requestDemand.ready = false;
    }
    if (exchangeCatalogStatus === "loading") {
      pendingInitialHistoryRef.current = null;
      detachActiveChartData(symbol, interval, "exchange-catalog-loading");
      const timer = setTimeout(() => {
        setInitialHistoryPending(false);
        setConnectionStatus("loading");
        setDataSource(null);
        setError(null);
        setLoading(true);
        setLoadingMoreLeft(false);
        setHasMoreLeft(false);
        setWsStatus("idle");
      }, 0);
      return () => clearTimeout(timer);
    }
    if (!historyIntervalAvailable) {
      pendingInitialHistoryRef.current = null;
      detachActiveChartData(symbol, interval, "history-capability-unavailable");
      const timer = setTimeout(() => {
        setInitialHistoryPending(false);
        setConnectionStatus("disconnected");
        setDataSource(null);
        setError(new Error(t("interval.cannotComposeSession", { exchange, marketType, interval })));
        setLoading(false);
        setLoadingMoreLeft(false);
        setHasMoreLeft(false);
        setWsStatus("idle");
      }, 0);
      return () => clearTimeout(timer);
    }
    void loadData(symbol, interval, marketType, exchange);
    return undefined;
  }, [
    activeSeries,
    backgroundPrefetchPriority,
    detachActiveChartData,
    exchange,
    exchangeCatalogStatus,
    historyIntervalAvailable,
    interval,
    lastSessionTransition,
    loadData,
    marketDataReady,
    marketType,
    pendingInitialHistoryRef,
    resetForSessionTransition,
    seriesDataFeed,
    sessionKey,
    setHasMoreLeft,
    setLoadingMoreLeft,
    symbol,
  ]);

  const retry = useCallback(() => {
    if (!marketDataReady) return;
    backgroundPrefetchPriority.yieldToForeground();
    rightWindowRestoreAbortRef.current?.abort();
    rightWindowRestoreAbortRef.current = null;
    rightWindowRestoreInFlightRef.current = null;
    rightWindowPageAbortRef.current?.abort();
    rightWindowPageAbortRef.current = null;
    rightWindowPageInFlightRef.current = null;
    setRestoringLatestWindow(false);
    setLoadingMoreRight(false);
    resetPagination();
    void loadData(symbol, interval, marketType, exchange);
  }, [
    backgroundPrefetchPriority,
    exchange,
    interval,
    loadData,
    marketDataReady,
    marketType,
    resetPagination,
    setLoadingMoreRight,
    setRestoringLatestWindow,
    symbol,
  ]);

  const handleMarketVisibleRangeChange = useCallback((range: unknown) => {
    backgroundPrefetchPriority.yieldToForeground();
    handleVisibleRangeChange(range, chartDataMeta);
    if (!marketDataReady) return;
    const series = activeSeries;
    const heldRows = getSeriesCacheRows(series);
    void seriesDataFeed.repairVisibleGaps(
      series,
      heldRows,
      range as VisibleTimeRangeLike,
      { source: "visible-window-gap-planner" },
    );
  }, [
    activeSeries,
    backgroundPrefetchPriority,
    chartDataMeta,
    getSeriesCacheRows,
    handleVisibleRangeChange,
    marketDataReady,
    seriesDataFeed,
  ]);
  const loadMoreLeftWithPriority = useCallback((
    oldestLoadedTime?: Parameters<typeof handleNeedMoreLeft>[0],
  ) => {
    backgroundPrefetchPriority.yieldToForeground();
    return handleNeedMoreLeft(oldestLoadedTime);
  }, [backgroundPrefetchPriority, handleNeedMoreLeft]);

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
  const requestDemand = requestDemandRef.current?.ready
    && requestDemandRef.current.sessionKey === sessionKey
    ? {
        scope: requestDemandRef.current.scope,
        generation: requestDemandRef.current.generation,
      }
    : null;

  return {
    view: {
      seriesIdentity,
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
      loadMoreLeft: loadMoreLeftWithPriority,
      loadMoreRight,
      restoreLatestWindow,
      onCrosshairMove: publishCrosshairData,
      onVisibleRangeChange: handleMarketVisibleRangeChange,
      consumeIndicatorRangeRequest,
    },
    status: {
      hasMoreLeft,
      loadingMoreLeft,
      loadingMoreRight,
      initialHistoryPending,
      activeChartReady,
      canLoadMoreLeft: canRequestMoreLeftDuringRuntime({
        hasMoreLeft,
        loading,
        loadingMoreLeft,
        marketDataReady,
        restoringLatestWindow: restoringLatestWindow || loadingMoreRight,
      }),
      canLoadMoreRight: !hasActivePaginationOwnership()
        && activeSeriesStore?.rightTruncated === true
        && canRequestRightWindowRestoreDuringRuntime({
          loading,
          loadingMoreLeft,
          marketDataReady,
          paginationPhase: paginationState.phase,
        })
        && !restoringLatestWindow
        && !loadingMoreRight,
      canRestoreLatestWindow: !hasActivePaginationOwnership()
        && canRequestRightWindowRestoreDuringRuntime({
        loading,
        loadingMoreLeft,
        marketDataReady,
        paginationPhase: paginationState.phase,
      }) && !restoringLatestWindow && !loadingMoreRight,
      barCount: chartData.length,
      cacheDiagnostics: getCacheDiagnostics,
      trimCacheEntries,
      indicatorRangeRequests,
      requestDemand,
    },
  };
}
