import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
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
  return t("interval.cannotComposeSession", { exchange, marketType, interval });
}

export function useChartSession({
  chartSurfaceActions,
  initialSession: configuredInitialSession = null,
  controlledSession = null,
  onSessionChange = null,
  visibleRangeScope = null,
}: UseChartSessionOptions = {}): ChartSessionRuntime {
  const [initialSession] = useState(() => {
    const fallback = loadInitialChartSession();
    const configuredInterval = canonicalizeIntervalValue(configuredInitialSession?.interval);
    return {
      exchange: configuredInitialSession?.exchange || fallback.exchange,
      marketType: configuredInitialSession?.marketType || fallback.marketType,
      symbol: configuredInitialSession?.symbol || fallback.symbol,
      interval: configuredInterval || fallback.interval,
    };
  });
  const [symbol, setSymbol] = useState(initialSession.symbol);
  const [exchange, setExchange] = useState(initialSession.exchange);
  const [marketType, setMarketType] = useState(initialSession.marketType);
  const [interval, setInterval] = useState(initialSession.interval);
  const [lastTransition, setLastTransition] = useState<ChartSessionTransition | null>(null);
  const transitionIdRef = useRef(0);
  const controlledInterval = canonicalizeIntervalValue(controlledSession?.interval);
  const controlledSessionKey = controlledSession && controlledInterval
    ? buildChartSessionKey({ ...controlledSession, interval: controlledInterval })
    : null;
  const lastControlledSessionKeyRef = useRef(controlledSessionKey);

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
    () => getVisibleRangeForInterval(
      symbol,
      interval,
      marketType,
      exchange,
      visibleRangeScope,
    ),
    [exchange, interval, marketType, symbol, visibleRangeScope],
  );
  const sessionKey = useMemo(
    () => buildChartSessionKey({ exchange, marketType, symbol, interval }),
    [exchange, interval, marketType, symbol],
  );
  const visibleRangeDataMetaRef = useRef<unknown>(null);

  useEffect(() => {
    onSessionChange?.({ exchange, marketType, symbol, interval });
  }, [exchange, interval, marketType, onSessionChange, symbol]);

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

  useEffect(() => {
    if (!controlledSession || !controlledInterval || !controlledSessionKey) return;
    // A local toolbar action renders before its onSessionChange echo reaches
    // the workspace document. Only react to a genuinely new external key, or
    // the stale controlled value would immediately undo the user's action.
    if (lastControlledSessionKeyRef.current === controlledSessionKey) return;
    lastControlledSessionKeyRef.current = controlledSessionKey;
    const nextSession = { ...controlledSession, interval: controlledInterval };
    if (nextSession.exchange === exchange
      && nextSession.marketType === marketType
      && nextSession.symbol === symbol
      && intervalsSemanticallyEquivalent(nextSession.interval, interval)) return;
    const identityChanged = nextSession.exchange !== exchange
      || nextSession.marketType !== marketType
      || nextSession.symbol !== symbol;
    publishTransition(
      identityChanged
        ? CHART_SESSION_TRANSITION_TYPES.SYMBOL_CHANGE
        : CHART_SESSION_TRANSITION_TYPES.INTERVAL_CHANGE,
      nextSession,
    );
    setExchange(nextSession.exchange);
    setMarketType(nextSession.marketType);
    setSymbol(nextSession.symbol);
    setInterval(nextSession.interval);
  }, [
    controlledSession,
    controlledInterval,
    controlledSessionKey,
    exchange,
    interval,
    marketType,
    publishTransition,
    symbol,
  ]);

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
      visibleRangeScope,
    );
  }, [chartSurfaceActions, exchange, interval, marketType, symbol, visibleRangeScope]);

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
      visibleRangeScope,
    );
  }, [exchange, interval, marketType, symbol, visibleRangeScope]);

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
      showIntervalNotice({ type: "info", text: t("interval.capabilityLoading") });
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
      return { ok: false, message: t("interval.capabilityLoading") };
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
    if (!result.ok) return { ok: false, message: t("interval.invalidPeriod") };
    selectInterval(result.value);
    showIntervalNotice({ type: "success", text: t("interval.addedAndSwitched", { value: result.value }) });
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
      text: t("interval.deleted", { value: removedInterval }),
      actionLabel: t("interval.undo"),
      duration: 6500,
    });
  }, [customIntervalRecords, exchange, exchangeCatalog, interval, marketType, nativeIntervals, removeCustomInterval, selectInterval, showIntervalNotice]);

  const restoreCustomIntervalAction = useCallback((): void => {
    const restored = restoreCustomInterval(lastRemovedIntervalRef.current);
    if (!restored) return;
    lastRemovedIntervalRef.current = null;
    showIntervalNotice({ type: "success", text: t("interval.restored", { value: restored.value }) });
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
      text: t("interval.clearedNotice", { count: removed.length }),
      actionLabel: t("interval.undoLast"),
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
