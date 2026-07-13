import { useCallback, useRef } from "react";
import type {
  SessionTransitionReset,
  UseSessionTransitionResetOptions,
} from "./marketDataTypes.js";

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
}: UseSessionTransitionResetOptions): SessionTransitionReset {
  const processedSessionTransitionRef = useRef<number | null>(null);

  return useCallback((transition: Parameters<SessionTransitionReset>[0]): void => {
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
