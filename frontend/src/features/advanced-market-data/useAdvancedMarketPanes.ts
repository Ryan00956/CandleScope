import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createAdvancedMarketLiquidationPaneProjectionMemo,
  createAdvancedMarketStatePaneProjectionMemo,
} from "./advancedMarketPaneProjectionMemo.js";
import { useAdvancedMarketMetrics } from "./useAdvancedMarketSnapshots.js";
import type { AdvancedMarketRuntimeView } from "./advancedMarketDataTypes.js";
import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import {
  EMPTY_LIQUIDATION_SNAPSHOT,
  liquidationStore,
} from "../liquidations/liquidationStore.js";

const EMPTY_ADVANCED_MARKET_PANES: readonly IndicatorSubPane[] = Object.freeze([]);
const EMPTY_ADVANCED_MARKET_BARS: readonly KlineBar[] = Object.freeze([]);

export function hasCurrentAdvancedMarketSeries(
  view: Pick<AdvancedMarketRuntimeView, "seriesKey" | "seriesStore">,
): boolean {
  return view.seriesStore !== null
    && String(view.seriesStore.seriesKey || "") === view.seriesKey;
}

export function shouldRunFundingRealtimeClock(
  fundingActive: boolean,
  fundingRealtimeCount: number,
  hasFundingPreview: boolean,
): boolean {
  return fundingActive && (hasFundingPreview || fundingRealtimeCount > 0);
}

export function useAdvancedMarketPanes(
  view: AdvancedMarketRuntimeView,
): readonly IndicatorSubPane[] {
  const metrics = useAdvancedMarketMetrics(view);
  const subscribeLiquidations = useCallback((listener: () => void) => (
    view.liquidations.enabled && view.liquidations.visible
      ? liquidationStore.subscribe(view.liquidations.identityKey, listener)
      : () => undefined
  ), [view.liquidations.enabled, view.liquidations.identityKey, view.liquidations.visible]);
  const getLiquidationSnapshot = useCallback(() => (
    view.liquidations.enabled && view.liquidations.visible
      ? liquidationStore.getSnapshot(view.liquidations.identityKey)
      : EMPTY_LIQUIDATION_SNAPSHOT
  ), [view.liquidations.enabled, view.liquidations.identityKey, view.liquidations.visible]);
  const liquidationSnapshot = useSyncExternalStore(
    subscribeLiquidations,
    getLiquidationSnapshot,
    () => EMPTY_LIQUIDATION_SNAPSHOT,
  );
  const subscribeSeries = useCallback((listener: () => void) => {
    const store = view.seriesStore;
    if (!view.metricsEnabled || !store) return () => undefined;
    const unsubscribe = store.subscribe(() => listener());
    return () => { unsubscribe(); };
  }, [view.metricsEnabled, view.seriesStore]);
  const getSeriesAxisRevision = useCallback(
    () => view.metricsEnabled
      ? Number(view.seriesStore?.axisRevision ?? 0)
      : 0,
    [view.metricsEnabled, view.seriesStore],
  );
  const seriesAxisRevision = useSyncExternalStore(
    subscribeSeries,
    getSeriesAxisRevision,
    () => 0,
  );
  const studyActive = (channel: "funding_rate" | "open_interest" | "liquidation") => (
    view.marketStudies.some((study) => (
      study.channel === channel && study.added && study.visible && study.supported
    ))
  );
  const fundingActive = studyActive("funding_rate");
  const openInterestActive = studyActive("open_interest");
  const liquidationActive = studyActive("liquidation");
  const fundingHasRealtime = metrics.fundingPreview !== null
    || metrics.fundingRealtimeHistory.length > 0;
  const fundingClockActive = shouldRunFundingRealtimeClock(
    fundingActive,
    metrics.fundingRealtimeHistory.length,
    metrics.fundingPreview !== null,
  );
  const fundingRealtimeReceivedAtMs = Math.max(
    metrics.fundingPreview?.received_at_ms ?? 0,
    metrics.fundingRealtimeHistory.at(-1)?.received_at_ms ?? 0,
  );
  const [realtimeClockMs, setRealtimeClockMs] = useState(() => Date.now());
  const [statePaneProjectionMemo] = useState(() => (
    createAdvancedMarketStatePaneProjectionMemo()
  ));
  const [liquidationPaneProjectionMemo] = useState(() => (
    createAdvancedMarketLiquidationPaneProjectionMemo()
  ));
  useEffect(() => {
    if (!fundingClockActive) return undefined;
    const timer = window.setInterval(() => { setRealtimeClockMs(Date.now()); }, 5_000);
    return () => { window.clearInterval(timer); };
  }, [fundingClockActive]);
  const seriesCurrent = hasCurrentAdvancedMarketSeries(view);
  const projectionReady = view.metricsEnabled
    && seriesCurrent
    && Number.isFinite(seriesAxisRevision);
  const seriesBars = useMemo(() => (
    projectionReady && Number.isFinite(seriesAxisRevision)
      ? view.seriesStore?.snapshot() ?? EMPTY_ADVANCED_MARKET_BARS
      : EMPTY_ADVANCED_MARKET_BARS
  ), [projectionReady, seriesAxisRevision, view.seriesStore]);
  const statePanes = useMemo(() => statePaneProjectionMemo.project({
    bars: seriesBars,
    barsAxisRevision: seriesAxisRevision,
    enabled: projectionReady,
    fundingActive,
    fundingHistory: metrics.fundingHistory,
    fundingPreview: metrics.fundingPreview,
    fundingRealtimeHistory: metrics.fundingRealtimeHistory,
    interval: view.interval,
    nowMs: fundingHasRealtime
      ? Math.max(realtimeClockMs, fundingRealtimeReceivedAtMs)
      : realtimeClockMs,
    openInterestActive,
    openInterestHistory: metrics.openInterestHistory,
  }), [
    fundingActive,
    fundingHasRealtime,
    fundingRealtimeReceivedAtMs,
    metrics.fundingHistory,
    metrics.fundingPreview,
    metrics.fundingRealtimeHistory,
    metrics.openInterestHistory,
    openInterestActive,
    projectionReady,
    realtimeClockMs,
    seriesBars,
    seriesAxisRevision,
    statePaneProjectionMemo,
    view.interval,
  ]);
  const { fundingPane, openInterestPane } = statePanes;
  const liquidationPane = useMemo(() => liquidationPaneProjectionMemo.project({
    bars: seriesBars,
    barsAxisRevision: seriesAxisRevision,
    enabled: projectionReady,
    interval: view.interval,
    liquidationActive,
    snapshot: liquidationSnapshot,
    view: view.liquidations,
  }), [
    liquidationActive,
    liquidationPaneProjectionMemo,
    liquidationSnapshot,
    projectionReady,
    seriesBars,
    seriesAxisRevision,
    view.interval,
    view.liquidations,
  ]);

  return useMemo(() => {
    if (!projectionReady) return EMPTY_ADVANCED_MARKET_PANES;
    const panes: IndicatorSubPane[] = [];
    if (fundingPane?.lines.some((line) => line.data.length > 0)) panes.push(fundingPane);
    if (openInterestPane?.lines.some((line) => line.data.length > 0)) {
      panes.push(openInterestPane);
    }
    if (liquidationPane) panes.push(liquidationPane);
    return panes;
  }, [fundingPane, liquidationPane, openInterestPane, projectionReady]);
}
