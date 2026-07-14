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
    (listener: () => void) => view.enabled
      ? advancedMarketDataStore.subscribeSummary(view.identityKey, listener)
      : () => undefined,
    [view.enabled, view.identityKey],
  );
  const getSnapshot = useCallback(
    () => view.enabled
      ? advancedMarketDataStore.getSummarySnapshot(view.identityKey)
      : EMPTY_ADVANCED_MARKET_SUMMARY,
    [view.enabled, view.identityKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ADVANCED_MARKET_SUMMARY);
}

export function useAdvancedMarketMetrics(
  view: AdvancedMarketRuntimeView,
): AdvancedMarketMetricsSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => view.enabled
      ? advancedMarketDataStore.subscribeMetrics(view.identityKey, listener)
      : () => undefined,
    [view.enabled, view.identityKey],
  );
  const getSnapshot = useCallback(
    () => view.enabled
      ? advancedMarketDataStore.getMetricsSnapshot(view.identityKey)
      : EMPTY_ADVANCED_MARKET_METRICS,
    [view.enabled, view.identityKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ADVANCED_MARKET_METRICS);
}
