import { useCallback, useSyncExternalStore } from "react";
import {
  advancedMarketDataStore,
  EMPTY_ADVANCED_MARKET_METRICS,
  EMPTY_ADVANCED_MARKET_SUMMARY,
} from "./advancedMarketDataStore.js";
import type {
  AdvancedMarketMetricsSnapshot,
  AdvancedMarketRuntimeView,
  AdvancedMarketSummarySnapshot,
} from "./advancedMarketDataTypes.js";

export function useAdvancedMarketSummary(
  view: AdvancedMarketRuntimeView,
): AdvancedMarketSummarySnapshot {
  const subscribe = useCallback(
    (listener: () => void) => view.summaryEnabled
      ? advancedMarketDataStore.subscribeSummary(view.identityKey, listener)
      : () => undefined,
    [view.identityKey, view.summaryEnabled],
  );
  const getSnapshot = useCallback(
    () => view.summaryEnabled
      ? advancedMarketDataStore.getSummarySnapshot(view.identityKey)
      : EMPTY_ADVANCED_MARKET_SUMMARY,
    [view.identityKey, view.summaryEnabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ADVANCED_MARKET_SUMMARY);
}

export function useAdvancedMarketMetrics(
  view: AdvancedMarketRuntimeView,
): AdvancedMarketMetricsSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => view.metricsEnabled
      ? advancedMarketDataStore.subscribeMetrics(view.identityKey, listener)
      : () => undefined,
    [view.identityKey, view.metricsEnabled],
  );
  const getSnapshot = useCallback(
    () => view.metricsEnabled
      ? advancedMarketDataStore.getMetricsSnapshot(view.identityKey)
      : EMPTY_ADVANCED_MARKET_METRICS,
    [view.identityKey, view.metricsEnabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ADVANCED_MARKET_METRICS);
}
