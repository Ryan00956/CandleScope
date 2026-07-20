import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCustomIntervals } from "./customIntervalStore.js";
import {
  buildSortedIntervals,
  getBaseWsIntervals,
  getExchangeConfig,
  getNativeIntervals,
  isNativeIntervalSupported,
  useExchangeCatalog,
} from "./exchangeCatalogRuntime.js";
import {
  canResolveIntervalFromNativeValues,
  canonicalizeIntervalValue,
  intervalsSemanticallyEquivalent,
} from "../../utils/intervals.js";
import { useIntervalNoticeRuntime } from "./intervalNoticeRuntime.js";
import { loadInitialChartSession, updateUserPref } from "./chartSessionModel.js";
import {
  getExchangeMarketTypes,
  getFallbackIntervalAfterCustomClear,
  getFallbackIntervalAfterCustomRemove,
  isExchangeIntervalCapabilityAvailable,
  resolveSupportedInterval,
} from "./intervalPolicy.js";
import {
  buildChartSessionKey,
  CHART_SESSION_TRANSITION_TYPES,
  createChartSessionTransition,
} from "./chartSessionTransition.js";
import { buildChartDatasetKey } from "./chartDatasetKey.js";
import { buildRealtimeTrackedIntervals } from "./trackedIntervalsPolicy.js";
import { getVisibleRangeForInterval, saveVisibleRangeForInterval } from "./visibleRangeStorage.js";
import type {
  ChartSession,
  ChartSessionRuntime,
  ChartSessionTransition,
  ChartSessionTransitionType,
  CreateCustomIntervalResult,
  CustomIntervalRecord,
  ExchangeId,
  IntervalString,
  MarketType,
  SelectSymbolInput,
  SymbolCode,
  UseChartSessionOptions,
} from "./chartSessionTypes.js";

function unavailableIntervalMessage(
  exchange: ExchangeId,
  marketType: MarketType,
  interval: IntervalString,
): string {
  return `当前 ${exchange}/${marketType} 没有可精确拼接 ${interval} 的历史 K 线基准周期`;
}

export function useChartSession({
  chartSurfaceActions,
}: UseChartSessionOptions = {}): ChartSessionRuntime {
  const [initialSession] = useState(loadInitialChartSession);
  const [symbol, setSymbol] = useState(initialSession.symbol);
  const [exchange, setExchange] = useState(initialSession.exchange);
  const [marketType, setMarketType] = useState(initialSession.marketType);
  const [interval, setInterval] = useState(initialSession.interval);
  const [lastTransition, setLastTransition] = useState<ChartSessionTransition | null>(null);
  const transitionIdRef = useRef(0);

  const { exchangeCatalog, exchangeCatalogStatus } = useExchangeCatalog();
  const {
    customIntervalRecords,
    savedCustomIntervals,
    addCustomInterval,
    markIntervalUsed,
    removeCustomInterval,
    restoreCustomInterval,
    togglePinCustomInterval,
    clearCustomIntervals,
  } = useCustomIntervals();
  const { intervalNotice, showIntervalNotice } = useIntervalNoticeRuntime();
  const lastRemovedIntervalRef = useRef<CustomIntervalRecord | null>(null);

  const intervalRef = useRef(interval);
  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  const exchangeConfig = useMemo(
    () => getExchangeConfig(exchange, exchangeCatalog),
    [exchange, exchangeCatalog],
  );
  const exchangeMarketTypes = useMemo(
    () => getExchangeMarketTypes(exchangeConfig),
    [exchangeConfig],
  );
  const exchangeLimitations = exchangeConfig.knownLimitations || [];
  const nativeIntervals = useMemo(
    () => getNativeIntervals(exchange, exchangeCatalog, marketType, "history"),
    [exchange, exchangeCatalog, marketType],
  );
  const nativeIntervalValues = useMemo(
    () => nativeIntervals.map((item) => item.value),
    [nativeIntervals],
  );
  const exchangeCapabilityAvailable = isExchangeIntervalCapabilityAvailable(
    exchangeCatalogStatus,
    exchangeCatalog,
    exchange,
    nativeIntervals,
  );
  const historyIntervalAvailable = useMemo(
    () => exchangeCapabilityAvailable
      && canResolveIntervalFromNativeValues(interval, nativeIntervalValues),
    [exchangeCapabilityAvailable, interval, nativeIntervalValues],
  );
  const intervalGroups = useMemo(
    () => buildSortedIntervals(savedCustomIntervals, exchange, exchangeCatalog, marketType),
    [exchange, exchangeCatalog, marketType, savedCustomIntervals],
  );
  const baseWsIntervals = useMemo(
    () => getBaseWsIntervals(exchange, exchangeCatalog, marketType),
    [exchange, exchangeCatalog, marketType],
  );
  const realtimeIntervalAvailable = useMemo(
    () => exchangeCapabilityAvailable
      && canResolveIntervalFromNativeValues(interval, baseWsIntervals),
    [baseWsIntervals, exchangeCapabilityAvailable, interval],
  );
  const marketDataReady = exchangeCatalogStatus !== "loading" && historyIntervalAvailable;
  const webSocketReady = marketDataReady && realtimeIntervalAvailable;
  const trackedIntervals = useMemo(
    () => webSocketReady
      ? buildRealtimeTrackedIntervals(interval, baseWsIntervals)
      : [],
    [baseWsIntervals, interval, webSocketReady],
  );
  const prefetchIntervals = useMemo(
    () => Array.from(new Set([
      ...nativeIntervals.map((item) => item.value),
      ...savedCustomIntervals.filter((candidate) => (
        canResolveIntervalFromNativeValues(candidate, nativeIntervalValues)
      )),
      ...(canResolveIntervalFromNativeValues(interval, nativeIntervalValues) ? [interval] : []),
    ])),
    [interval, nativeIntervalValues, nativeIntervals, savedCustomIntervals],
  );
  const trackedIntervalsRef = useRef(trackedIntervals);
  useEffect(() => {
    trackedIntervalsRef.current = trackedIntervals;
  }, [trackedIntervals]);

  const datasetKey = useMemo(
    () => buildChartDatasetKey({ exchange, marketType, symbol, interval }),
    [exchange, interval, marketType, symbol],
  );
  const savedVisibleRange = useMemo(
    () => getVisibleRangeForInterval(symbol, interval, marketType, exchange),
    [exchange, interval, marketType, symbol],
  );
  const sessionKey = useMemo(
    () => buildChartSessionKey({ exchange, marketType, symbol, interval }),
    [exchange, interval, marketType, symbol],
  );
  const visibleRangeDataMetaRef = useRef<unknown>(null);

  const publishTransition = useCallback((
    type: ChartSessionTransitionType,
    nextSession: Partial<ChartSession>,
  ): void => {
    const from = { exchange, marketType, symbol, interval };
    const to = {
      exchange: nextSession.exchange ?? exchange,
      marketType: nextSession.marketType ?? marketType,
      symbol: nextSession.symbol ?? symbol,
      interval: nextSession.interval ?? interval,
    };
    transitionIdRef.current += 1;
    setLastTransition(createChartSessionTransition({
      id: transitionIdRef.current,
      type,
      from,
      to,
    }));
  }, [exchange, interval, marketType, symbol]);

  const setDatasetVersionCompat = useCallback((): void => {}, []);

  const refreshDataset = useCallback((): void => {}, []);

  const saveCurrentVisibleRange = useCallback((
    dataMeta: unknown = visibleRangeDataMetaRef.current,
  ): void => {
    const range = chartSurfaceActions?.getVisibleRange?.();
    if (!range) return;
    saveVisibleRangeForInterval(
      symbol,
      interval,
      range,
      marketType,
      exchange,
      dataMeta,
    );
  }, [chartSurfaceActions, exchange, interval, marketType, symbol]);

  const handleVisibleRangeChange = useCallback((range: unknown, dataMeta: unknown = null): void => {
    if (dataMeta) {
      visibleRangeDataMetaRef.current = dataMeta;
    }
    saveVisibleRangeForInterval(
      symbol,
      interval,
      range,
      marketType,
      exchange,
      dataMeta ?? visibleRangeDataMetaRef.current,
    );
  }, [exchange, interval, marketType, symbol]);

  const updateVisibleRangeDataMeta = useCallback((dataMeta: unknown): void => {
    visibleRangeDataMetaRef.current = dataMeta ?? null;
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentVisibleRange();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentVisibleRange]);

  const selectSymbol = useCallback((newSymbolOrObj: SymbolCode | SelectSymbolInput): void => {
    let nextSymbol: SymbolCode;
    let nextMarketType: MarketType;
    let nextExchange: ExchangeId;
    if (typeof newSymbolOrObj === "object" && newSymbolOrObj !== null) {
      nextSymbol = newSymbolOrObj.symbol;
      nextMarketType = newSymbolOrObj.marketType || "spot";
      nextExchange = newSymbolOrObj.exchange || "binance";
    } else {
      nextSymbol = newSymbolOrObj;
      nextMarketType = marketType;
      nextExchange = exchange;
    }
    if (nextSymbol === symbol && nextMarketType === marketType && nextExchange === exchange) return;

    const nextInterval = resolveSupportedInterval({
      exchange: nextExchange,
      marketType: nextMarketType,
      interval,
      exchangeCatalog,
      savedCustomIntervals,
      nativeIntervals: getNativeIntervals(nextExchange, exchangeCatalog, nextMarketType, "history"),
      isNativeIntervalSupported,
    });

    updateUserPref("lastSymbol", nextSymbol);
    updateUserPref("lastMarketType", nextMarketType);
    updateUserPref("lastExchange", nextExchange);
    updateUserPref("lastInterval", nextInterval);

    publishTransition(CHART_SESSION_TRANSITION_TYPES.SYMBOL_CHANGE, {
      exchange: nextExchange,
      marketType: nextMarketType,
      symbol: nextSymbol,
      interval: nextInterval,
    });

    setExchange(nextExchange);
    setMarketType(nextMarketType);
    setSymbol(nextSymbol);
    setInterval(nextInterval);
  }, [
    exchange,
    exchangeCatalog,
    interval,
    marketType,
    publishTransition,
    savedCustomIntervals,
    symbol,
  ]);

  const selectInterval = useCallback((nextInterval: IntervalString): void => {
    const canonicalInterval = canonicalizeIntervalValue(nextInterval);
    if (!canonicalInterval || intervalsSemanticallyEquivalent(canonicalInterval, interval)) return;
    if (exchangeCatalogStatus === "loading") {
      showIntervalNotice({ type: "info", text: "交易所周期能力正在加载，请稍候" });
      return;
    }
    if (!canResolveIntervalFromNativeValues(canonicalInterval, nativeIntervalValues)) {
      showIntervalNotice({
        type: "error",
        text: unavailableIntervalMessage(exchange, marketType, canonicalInterval),
      });
      return;
    }
    saveCurrentVisibleRange();
    publishTransition(CHART_SESSION_TRANSITION_TYPES.INTERVAL_CHANGE, { interval: canonicalInterval });
    setInterval(canonicalInterval);
    markIntervalUsed(canonicalInterval);
    updateUserPref("lastInterval", canonicalInterval);
  }, [exchange, exchangeCatalogStatus, interval, markIntervalUsed, marketType, nativeIntervalValues, publishTransition, saveCurrentVisibleRange, showIntervalNotice]);

  const selectMarketType = useCallback((nextMarketType: MarketType): void => {
    if (!nextMarketType || nextMarketType === marketType) return;
    const nextNativeIntervals = getNativeIntervals(
      exchange,
      exchangeCatalog,
      nextMarketType,
      "history",
    );
    const nextInterval = resolveSupportedInterval({
      exchange,
      marketType: nextMarketType,
      interval,
      exchangeCatalog,
      savedCustomIntervals,
      nativeIntervals: nextNativeIntervals,
      isNativeIntervalSupported,
    });
    publishTransition(CHART_SESSION_TRANSITION_TYPES.MARKET_TYPE_CHANGE, {
      marketType: nextMarketType,
      interval: nextInterval,
    });
    setMarketType(nextMarketType);
    setInterval(nextInterval);
    updateUserPref("lastMarketType", nextMarketType);
    updateUserPref("lastInterval", nextInterval);
  }, [exchange, exchangeCatalog, interval, marketType, publishTransition, savedCustomIntervals]);

  useEffect(() => {
    if (exchangeCatalogStatus === "loading") return undefined;
    if (exchangeMarketTypes.length === 0 || exchangeMarketTypes.includes(marketType)) return undefined;
    const nextMarketType = exchangeMarketTypes[0] || "spot";
    const nextNativeIntervals = getNativeIntervals(
      exchange,
      exchangeCatalog,
      nextMarketType,
      "history",
    );
    const nextInterval = resolveSupportedInterval({
      exchange,
      marketType: nextMarketType,
      interval,
      exchangeCatalog,
      savedCustomIntervals,
      nativeIntervals: nextNativeIntervals,
      isNativeIntervalSupported,
    });
    const timer = setTimeout(() => {
      publishTransition(CHART_SESSION_TRANSITION_TYPES.CAPABILITY_CORRECTION, {
        marketType: nextMarketType,
        interval: nextInterval,
      });
      setMarketType(nextMarketType);
      setInterval(nextInterval);
      updateUserPref("lastMarketType", nextMarketType);
      updateUserPref("lastInterval", nextInterval);
    }, 0);
    return () => clearTimeout(timer);
  }, [exchange, exchangeCatalog, exchangeCatalogStatus, exchangeMarketTypes, interval, marketType, publishTransition, savedCustomIntervals]);

  useEffect(() => {
    if (exchangeCatalogStatus === "loading") return undefined;
    if (isNativeIntervalSupported(exchange, interval, exchangeCatalog, marketType, "history")) return undefined;
    const savedCustom = savedCustomIntervals.some((candidate) => (
      intervalsSemanticallyEquivalent(candidate, interval)
    ));
    if (
      savedCustom
      && canResolveIntervalFromNativeValues(interval, nativeIntervalValues)
    ) return undefined;
    const nextInterval = resolveSupportedInterval({
      exchange,
      marketType,
      interval,
      exchangeCatalog,
      savedCustomIntervals,
      nativeIntervals,
      isNativeIntervalSupported,
    });
    if (intervalsSemanticallyEquivalent(nextInterval, interval)) return undefined;
    const timer = setTimeout(() => {
      publishTransition(CHART_SESSION_TRANSITION_TYPES.CAPABILITY_CORRECTION, {
        interval: nextInterval,
      });
      setInterval(nextInterval);
      updateUserPref("lastInterval", nextInterval);
    }, 0);
    return () => clearTimeout(timer);
  }, [exchange, exchangeCatalog, exchangeCatalogStatus, interval, marketType, nativeIntervalValues, nativeIntervals, publishTransition, savedCustomIntervals]);

  const createCustomInterval = useCallback((
    nextInterval: IntervalString,
  ): CreateCustomIntervalResult => {
    if (exchangeCatalogStatus === "loading") {
      return { ok: false, message: "交易所周期能力正在加载，请稍候" };
    }
    if (isNativeIntervalSupported(exchange, nextInterval, exchangeCatalog, marketType, "history")) {
      selectInterval(nextInterval);
      return { ok: true, added: false };
    }
    if (!canResolveIntervalFromNativeValues(nextInterval, nativeIntervalValues)) {
      return {
        ok: false,
        message: unavailableIntervalMessage(exchange, marketType, nextInterval),
      };
    }
    const result = addCustomInterval(nextInterval, { markUsed: true });
    if (!result.ok) return { ok: false, message: "周期格式无效" };
    selectInterval(result.value);
    showIntervalNotice({ type: "success", text: `${result.value} 已添加并切换` });
    return { ok: true, added: result.added };
  }, [addCustomInterval, exchange, exchangeCatalog, exchangeCatalogStatus, marketType, nativeIntervalValues, selectInterval, showIntervalNotice]);

  const removeCustomIntervalAction = useCallback((removedInterval: IntervalString): void => {
    const removed = removeCustomInterval(removedInterval);
    if (!removed) return;
    lastRemovedIntervalRef.current = removed;
    if (interval === removedInterval) {
      selectInterval(getFallbackIntervalAfterCustomRemove({
        removedInterval,
        customIntervalRecords,
        nativeIntervals,
        exchange,
        marketType,
        exchangeCatalog,
        isNativeIntervalSupported,
      }));
    }
    showIntervalNotice({
      type: "warning",
      text: `${removedInterval} 已删除`,
      actionLabel: "撤销",
      duration: 6500,
    });
  }, [customIntervalRecords, exchange, exchangeCatalog, interval, marketType, nativeIntervals, removeCustomInterval, selectInterval, showIntervalNotice]);

  const restoreCustomIntervalAction = useCallback((): void => {
    const restored = restoreCustomInterval(lastRemovedIntervalRef.current);
    if (!restored) return;
    lastRemovedIntervalRef.current = null;
    showIntervalNotice({ type: "success", text: `${restored.value} 已恢复` });
  }, [restoreCustomInterval, showIntervalNotice]);

  const clearCustomIntervalsAction = useCallback((): void => {
    const removed = clearCustomIntervals();
    if (removed.length === 0) return;
    const currentWasRemoved = removed.some((record) => record.value === interval);
    lastRemovedIntervalRef.current = removed[removed.length - 1] || null;
    if (currentWasRemoved) {
      selectInterval(getFallbackIntervalAfterCustomClear({ interval, nativeIntervals }));
    }
    showIntervalNotice({
      type: "warning",
      text: `已清空 ${removed.length} 个自定义周期，最近一项可撤销`,
      actionLabel: "撤销最近一项",
      duration: 6500,
    });
  }, [clearCustomIntervals, interval, nativeIntervals, selectInterval, showIntervalNotice]);

  return {
    view: {
      symbol,
      exchange,
      marketType,
      interval,
      sessionKey,
      datasetKey,
      datasetVersion: 0,
      exchangeCatalog,
      exchangeConfig,
      exchangeMarketTypes,
      nativeIntervals,
      intervalGroups,
      baseWsIntervals,
      trackedIntervals,
      prefetchIntervals,
      customIntervalRecords,
      savedCustomIntervals,
      intervalNotice,
      savedVisibleRange,
    },
    actions: {
      selectSymbol,
      selectInterval,
      selectMarketType,
      refreshDataset,
      setDatasetVersion: setDatasetVersionCompat,
      saveCurrentVisibleRange,
      handleVisibleRangeChange,
      updateVisibleRangeDataMeta,
      createCustomInterval,
      removeCustomInterval: removeCustomIntervalAction,
      restoreCustomInterval: restoreCustomIntervalAction,
      clearCustomIntervals: clearCustomIntervalsAction,
      togglePinCustomInterval,
    },
    status: {
      exchangeCatalogStatus,
      exchangeLimitations,
      exchangeCapabilityAvailable,
      historyIntervalAvailable,
      realtimeIntervalAvailable,
      marketDataReady,
      webSocketReady,
    },
    events: {
      transitionToken: lastTransition?.id ?? 0,
      lastTransition,
    },
    refs: {
      intervalRef,
      trackedIntervalsRef,
    },
  };
}
