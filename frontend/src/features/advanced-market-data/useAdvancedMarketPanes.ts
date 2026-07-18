import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildAdvancedMarketPanes } from "./metricPaneProjection.js";
import { useAdvancedMarketMetrics } from "./useAdvancedMarketSnapshots.js";
import type { AdvancedMarketRuntimeView } from "./advancedMarketDataTypes.js";
import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { MarketMetricChannel } from "./marketMetricSelectionTypes.js";

const EMPTY_ADVANCED_MARKET_PANES: readonly IndicatorSubPane[] = Object.freeze([]);

export function hasCurrentAdvancedMarketSeries(
  view: Pick<AdvancedMarketRuntimeView, "seriesKey" | "seriesStore">,
): boolean {
  return view.seriesStore !== null
    && String(view.seriesStore.seriesKey || "") === view.seriesKey;
}

export function useAdvancedMarketPanes(
  view: AdvancedMarketRuntimeView,
): readonly IndicatorSubPane[] {
  const metrics = useAdvancedMarketMetrics(view);
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
  const activeChannels = useMemo<MarketMetricChannel[]>(() => (
    view.marketStudies
      .filter((study) => study.added && study.visible && study.supported)
      .map((study) => study.channel)
  ), [view.marketStudies]);
  const fundingActive = activeChannels.includes("funding_rate");
  const [realtimeClockMs, setRealtimeClockMs] = useState(() => Date.now());
  useEffect(() => {
    if (!fundingActive) return undefined;
    const timer = window.setInterval(() => { setRealtimeClockMs(Date.now()); }, 5_000);
    return () => { window.clearInterval(timer); };
  }, [fundingActive]);
  const seriesCurrent = hasCurrentAdvancedMarketSeries(view);
  return useMemo(() => {
    if (!view.metricsEnabled
      || !seriesCurrent
      || !Number.isFinite(seriesAxisRevision)) {
      return EMPTY_ADVANCED_MARKET_PANES;
    }
    return buildAdvancedMarketPanes(
      metrics,
      view.seriesStore?.snapshot() || [],
      activeChannels,
      view.interval,
      realtimeClockMs,
    ).filter((pane) => pane.lines.some((line) => line.data.length > 0));
  }, [activeChannels, metrics, realtimeClockMs, seriesAxisRevision, seriesCurrent, view.interval, view.metricsEnabled, view.seriesStore]);
}
