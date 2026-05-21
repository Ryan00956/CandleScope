import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCustomIntervals } from "../../hooks/useCustomIntervals";
import {
  buildSortedIntervals,
  getBaseWsIntervals,
  getExchangeConfig,
  getIntervalDays,
  getNativeIntervals,
  isNativeIntervalSupported,
  useExchangeCatalog,
} from "../../runtime/exchange/exchangeCatalogRuntime";
import { useIntervalNoticeRuntime } from "../../runtime/workflows/useIntervalNoticeRuntime";
import { loadInitialChartSession, updateUserPref } from "./chartSessionModel";
import {
  getExchangeMarketTypes,
  getFallbackIntervalAfterCustomClear,
  getFallbackIntervalAfterCustomRemove,
  resolveSupportedInterval,
} from "./intervalPolicy";
import { getVisibleRangeForInterval, saveVisibleRangeForInterval } from "./visibleRangeStorage";

export function useChartSession({ chartWidgetRef, realtimePriceRef, runtimeBridgeRef } = {}) {
  const [initialSession] = useState(loadInitialChartSession);
  const [symbol, setSymbol] = useState(initialSession.symbol);
  const [exchange, setExchange] = useState(initialSession.exchange);
  const [marketType, setMarketType] = useState(initialSession.marketType);
  const [interval, setInterval] = useState(initialSession.interval);
  const [datasetVersion, setDatasetVersion] = useState(0);

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
  const lastRemovedIntervalRef = useRef(null);

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
    () => getNativeIntervals(exchange, exchangeCatalog),
    [exchange, exchangeCatalog],
  );
  const intervalGroups = useMemo(
    () => buildSortedIntervals(savedCustomIntervals, exchange, exchangeCatalog),
    [exchange, exchangeCatalog, savedCustomIntervals],
  );
  const baseWsIntervals = useMemo(
    () => getBaseWsIntervals(exchange, exchangeCatalog),
    [exchange, exchangeCatalog],
  );
  const trackedIntervals = useMemo(
    () => Array.from(new Set([...baseWsIntervals, ...savedCustomIntervals, interval])),
    [baseWsIntervals, interval, savedCustomIntervals],
  );
  const trackedIntervalsRef = useRef(trackedIntervals);
  useEffect(() => {
    trackedIntervalsRef.current = trackedIntervals;
  }, [trackedIntervals]);

  const datasetKey = useMemo(
    () => `${exchange}-${marketType}-${symbol}-${interval}-${datasetVersion}`,
    [datasetVersion, exchange, interval, marketType, symbol],
  );
  const savedVisibleRange = useMemo(
    () => getVisibleRangeForInterval(symbol, interval, marketType, exchange),
    [exchange, interval, marketType, symbol],
  );

  const setDatasetVersionCompat = useCallback((nextVersion) => {
    setDatasetVersion((currentVersion) => (
      typeof nextVersion === "function" ? nextVersion(currentVersion) : nextVersion
    ));
  }, []);

  const refreshDataset = useCallback(() => {
    setDatasetVersion((version) => version + 1);
  }, []);

  const getExchangeIntervalDays = useCallback(
    (targetInterval, targetExchange = exchange) => getIntervalDays(targetInterval, targetExchange, exchangeCatalog),
    [exchange, exchangeCatalog],
  );

  const saveCurrentVisibleRange = useCallback(() => {
    if (!chartWidgetRef?.current?.getVisibleRange) return;
    const range = chartWidgetRef.current.getVisibleRange();
    if (!range) return;
    saveVisibleRangeForInterval(
      symbol,
      interval,
      range,
      marketType,
      exchange,
      runtimeBridgeRef?.current?.chartDataMeta,
    );
  }, [chartWidgetRef, exchange, interval, marketType, runtimeBridgeRef, symbol]);

  const handleVisibleRangeChange = useCallback((range) => {
    saveVisibleRangeForInterval(
      symbol,
      interval,
      range,
      marketType,
      exchange,
      runtimeBridgeRef?.current?.chartDataMeta,
    );
  }, [exchange, interval, marketType, runtimeBridgeRef, symbol]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentVisibleRange();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentVisibleRange]);

  const selectSymbol = useCallback((newSymbolOrObj) => {
    let nextSymbol;
    let nextMarketType;
    let nextExchange;
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
      interval,
      exchangeCatalog,
      savedCustomIntervals,
      nativeIntervals: getNativeIntervals(nextExchange, exchangeCatalog),
      isNativeIntervalSupported,
    });

    updateUserPref("lastSymbol", nextSymbol);
    updateUserPref("lastMarketType", nextMarketType);
    updateUserPref("lastExchange", nextExchange);
    updateUserPref("lastInterval", nextInterval);

    const bridge = runtimeBridgeRef?.current || {};
    bridge.clearCache?.();
    if (realtimePriceRef) realtimePriceRef.current = null;
    bridge.clearChartData?.("symbol-switch-clear", nextSymbol, nextInterval);
    bridge.setLastPrice?.(null);
    bridge.setCrosshairData?.(null);
    bridge.setLoading?.(true);
    bridge.setError?.(null);
    bridge.setHasMoreLeft?.(true);
    refreshDataset();

    setExchange(nextExchange);
    setMarketType(nextMarketType);
    setSymbol(nextSymbol);
    setInterval(nextInterval);
  }, [
    exchange,
    exchangeCatalog,
    interval,
    marketType,
    realtimePriceRef,
    refreshDataset,
    runtimeBridgeRef,
    savedCustomIntervals,
    symbol,
  ]);

  const selectInterval = useCallback((nextInterval) => {
    if (nextInterval === interval) return;
    saveCurrentVisibleRange();
    const bridge = runtimeBridgeRef?.current || {};
    bridge.setCrosshairData?.(null);
    if (realtimePriceRef) realtimePriceRef.current = null;
    bridge.setLastPrice?.(null);
    bridge.resetGapRecovery?.();
    setInterval(nextInterval);
    markIntervalUsed(nextInterval);
    updateUserPref("lastInterval", nextInterval);
  }, [interval, markIntervalUsed, realtimePriceRef, runtimeBridgeRef, saveCurrentVisibleRange]);

  const selectMarketType = useCallback((nextMarketType) => {
    if (!nextMarketType || nextMarketType === marketType) return;
    setMarketType(nextMarketType);
    updateUserPref("lastMarketType", nextMarketType);
  }, [marketType]);

  useEffect(() => {
    if (exchangeCatalogStatus === "loading") return undefined;
    if (exchangeMarketTypes.length === 0 || exchangeMarketTypes.includes(marketType)) return undefined;
    const nextMarketType = exchangeMarketTypes[0] || "spot";
    const timer = setTimeout(() => {
      setMarketType(nextMarketType);
      updateUserPref("lastMarketType", nextMarketType);
    }, 0);
    return () => clearTimeout(timer);
  }, [exchangeCatalogStatus, exchangeMarketTypes, marketType]);

  useEffect(() => {
    if (exchangeCatalogStatus === "loading") return undefined;
    if (savedCustomIntervals.includes(interval)) return undefined;
    if (isNativeIntervalSupported(exchange, interval, exchangeCatalog)) return undefined;
    const nextInterval = resolveSupportedInterval({
      exchange,
      interval,
      exchangeCatalog,
      savedCustomIntervals,
      nativeIntervals,
      isNativeIntervalSupported,
    });
    const timer = setTimeout(() => {
      setInterval(nextInterval);
      updateUserPref("lastInterval", nextInterval);
    }, 0);
    return () => clearTimeout(timer);
  }, [exchange, exchangeCatalog, exchangeCatalogStatus, interval, nativeIntervals, savedCustomIntervals]);

  const createCustomInterval = useCallback((nextInterval) => {
    if (isNativeIntervalSupported(exchange, nextInterval, exchangeCatalog)) {
      selectInterval(nextInterval);
      return { ok: true, added: false };
    }
    const result = addCustomInterval(nextInterval, { markUsed: true });
    if (!result.ok) return { ok: false, message: "周期格式无效" };
    selectInterval(result.value);
    showIntervalNotice({ type: "success", text: `${result.value} 已添加并切换` });
    return { ok: true, added: result.added };
  }, [addCustomInterval, exchange, exchangeCatalog, selectInterval, showIntervalNotice]);

  const removeCustomIntervalAction = useCallback((removedInterval) => {
    const removed = removeCustomInterval(removedInterval);
    if (!removed) return;
    lastRemovedIntervalRef.current = removed;
    if (interval === removedInterval) {
      selectInterval(getFallbackIntervalAfterCustomRemove({
        removedInterval,
        customIntervalRecords,
        nativeIntervals,
        exchange,
        isNativeIntervalSupported: (targetExchange, targetInterval) => (
          isNativeIntervalSupported(targetExchange, targetInterval, exchangeCatalog)
        ),
      }));
    }
    showIntervalNotice({
      type: "warning",
      text: `${removedInterval} 已删除`,
      actionLabel: "撤销",
      duration: 6500,
    });
  }, [customIntervalRecords, exchange, exchangeCatalog, interval, nativeIntervals, removeCustomInterval, selectInterval, showIntervalNotice]);

  const restoreCustomIntervalAction = useCallback(() => {
    const restored = restoreCustomInterval(lastRemovedIntervalRef.current);
    if (!restored) return;
    lastRemovedIntervalRef.current = null;
    showIntervalNotice({ type: "success", text: `${restored.value} 已恢复` });
  }, [restoreCustomInterval, showIntervalNotice]);

  const clearCustomIntervalsAction = useCallback(() => {
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
      datasetKey,
      datasetVersion,
      exchangeCatalog,
      exchangeConfig,
      exchangeMarketTypes,
      nativeIntervals,
      intervalGroups,
      baseWsIntervals,
      trackedIntervals,
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
      getIntervalDays: getExchangeIntervalDays,
      saveCurrentVisibleRange,
      handleVisibleRangeChange,
      createCustomInterval,
      removeCustomInterval: removeCustomIntervalAction,
      restoreCustomInterval: restoreCustomIntervalAction,
      clearCustomIntervals: clearCustomIntervalsAction,
      togglePinCustomInterval,
    },
    status: {
      exchangeCatalogStatus,
      exchangeLimitations,
    },
    refs: {
      intervalRef,
      trackedIntervalsRef,
    },
  };
}