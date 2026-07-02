import { useCallback, useRef } from "react";

export function useSessionTransitionReset({
  clearCache,
  interval,
  markChartDataTransition,
  realtimePriceRef,
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
    markChartDataTransition(symbol, interval, `${transition.type}-optimistic`);
    setLastPrice(null);
    setCrosshairData(null);
    setLoading(true);
    setError(null);
    setHasMoreLeft(true);
  }, [
    clearCache,
    interval,
    markChartDataTransition,
    realtimePriceRef,
    sessionKey,
    setCrosshairData,
    setError,
    setHasMoreLeft,
    setLastPrice,
    setLoading,
    symbol,
  ]);
}
