import { useCallback, useRef } from "react";

export function useSessionTransitionReset({
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
}) {
  const processedSessionTransitionRef = useRef(null);

  return useCallback((transition) => {
    if (!transition || transition.sessionKey !== sessionKey) return;
    if (processedSessionTransitionRef.current === transition.id) return;
    processedSessionTransitionRef.current = transition.id;

    if (transition.type === "symbol-change") {
      clearCache();
    }
    if (realtimePriceRef) realtimePriceRef.current = null;
    clearChartData(`${transition.type}-clear`, symbol, interval);
    resetGapRecovery();
    setLastPrice(null);
    setCrosshairData(null);
    setLoading(true);
    setError(null);
    setHasMoreLeft(true);
  }, [
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
  ]);
}
