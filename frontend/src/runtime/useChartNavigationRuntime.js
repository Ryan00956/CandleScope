import { useCallback, useEffect } from "react";
import { saveVisibleRangeForInterval } from "./viewportController";

export function useChartNavigationRuntime({
  symbol,
  exchange,
  marketType,
  interval,
  exchangeCatalog,
  savedCustomIntervals,
  chartDataMeta,
  chartWidgetRef,
  realtimePriceRef,
  clearCache,
  clearChartData,
  resetGapRecovery,
  isNativeIntervalSupported,
  updateUserPref,
  setSymbol,
  setExchange,
  setMarketType,
  setInterval,
  setLastPrice,
  setCrosshairData,
  setLoading,
  setError,
  setHasMoreLeft,
  setDatasetKey,
  markIntervalUsed,
}) {
  const saveCurrentVisibleRange = useCallback(() => {
    if (chartWidgetRef.current?.getVisibleRange) {
      const range = chartWidgetRef.current.getVisibleRange();
      if (range) {
        saveVisibleRangeForInterval(symbol, interval, range, marketType, exchange, chartDataMeta);
      }
    }
  }, [chartDataMeta, chartWidgetRef, exchange, interval, marketType, symbol]);

  const handleVisibleRangeChange = useCallback((range) => {
    saveVisibleRangeForInterval(symbol, interval, range, marketType, exchange, chartDataMeta);
  }, [chartDataMeta, exchange, interval, marketType, symbol]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentVisibleRange();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentVisibleRange]);

  const handleSymbolChange = useCallback((newSymbolOrObj) => {
    let newSymbol;
    let newMarketType;
    let newExchange;
    if (typeof newSymbolOrObj === "object" && newSymbolOrObj !== null) {
      newSymbol = newSymbolOrObj.symbol;
      newMarketType = newSymbolOrObj.marketType || "spot";
      newExchange = newSymbolOrObj.exchange || "binance";
    } else {
      newSymbol = newSymbolOrObj;
      newMarketType = marketType;
      newExchange = exchange;
    }
    if (newSymbol === symbol && newMarketType === marketType && newExchange === exchange) return;

    const nextInterval = (
      savedCustomIntervals.includes(interval) || isNativeIntervalSupported(newExchange, interval, exchangeCatalog)
    ) ? interval : "1h";

    updateUserPref("lastSymbol", newSymbol);
    updateUserPref("lastMarketType", newMarketType);
    updateUserPref("lastExchange", newExchange);
    updateUserPref("lastInterval", nextInterval);

    clearCache();
    realtimePriceRef.current = null;

    clearChartData("symbol-switch-clear", newSymbol, nextInterval);
    setLastPrice(null);
    setCrosshairData(null);
    setLoading(true);
    setError(null);
    setHasMoreLeft(true);
    setDatasetKey((version) => version + 1);

    setExchange(newExchange);
    setMarketType(newMarketType);
    setSymbol(newSymbol);
    setInterval(nextInterval);
  }, [
    clearCache,
    clearChartData,
    exchange,
    exchangeCatalog,
    interval,
    isNativeIntervalSupported,
    marketType,
    realtimePriceRef,
    savedCustomIntervals,
    setCrosshairData,
    setDatasetKey,
    setError,
    setExchange,
    setHasMoreLeft,
    setInterval,
    setLastPrice,
    setLoading,
    setMarketType,
    setSymbol,
    symbol,
    updateUserPref,
  ]);

  const handleIntervalChange = useCallback((newInterval) => {
    if (newInterval === interval) return;
    saveCurrentVisibleRange();
    setCrosshairData(null);
    realtimePriceRef.current = null;
    setLastPrice(null);
    resetGapRecovery();
    setInterval(newInterval);
    markIntervalUsed(newInterval);
    updateUserPref("lastInterval", newInterval);
  }, [
    interval,
    markIntervalUsed,
    realtimePriceRef,
    resetGapRecovery,
    saveCurrentVisibleRange,
    setCrosshairData,
    setInterval,
    setLastPrice,
    updateUserPref,
  ]);

  return {
    handleSymbolChange,
    handleIntervalChange,
    handleVisibleRangeChange,
    saveCurrentVisibleRange,
  };
}
