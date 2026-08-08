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
import { resolveOpenInterestPeriod } from "./metricPaneProjection.js";

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
  const openInterestPeriod = resolveOpenInterestPeriod(view.interval);
  const subscribe = useCallback(
    (listener: () => void) => view.stateMetricsEnabled
      ? advancedMarketDataStore.subscribeMetrics(view.identityKey, listener)
      : () => undefined,
    [view.identityKey, view.stateMetricsEnabled],
  );
  const getSnapshot = useCallback(
    () => view.stateMetricsEnabled
      ? advancedMarketDataStore.getMetricsSnapshotForPeriods(
        view.identityKey,
        view.interval,
        openInterestPeriod,
      )
      : EMPTY_ADVANCED_MARKET_METRICS,
    [openInterestPeriod, view.identityKey, view.interval, view.stateMetricsEnabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ADVANCED_MARKET_METRICS);
}
