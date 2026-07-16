import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildAdvancedMarketPanes } from "./metricPaneProjection.js";
import { useAdvancedMarketMetrics } from "./useAdvancedMarketSnapshots.js";
import type { AdvancedMarketRuntimeView } from "./advancedMarketDataTypes.js";
import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { MarketMetricChannel } from "./marketMetricSelectionTypes.js";

export function hasCurrentAdvancedMarketSeries(
  view: Pick<AdvancedMarketRuntimeView, "seriesKey" | "seriesStore">,
): boolean {
  return view.seriesStore !== null
    && String(view.seriesStore.seriesKey || "") === view.seriesKey;
}

export function useAdvancedMarketPanes(
  view: AdvancedMarketRuntimeView,
): IndicatorSubPane[] {
  const metrics = useAdvancedMarketMetrics(view);
  const subscribeSeries = useCallback((listener: () => void) => {
    const store = view.seriesStore;
    if (!store) return () => undefined;
    const unsubscribe = store.subscribe(() => listener());
    return () => { unsubscribe(); };
  }, [view.seriesStore]);
  const getSeriesVersion = useCallback(
    () => Number(view.seriesStore?.version ?? 0),
    [view.seriesStore],
  );
  const seriesVersion = useSyncExternalStore(
    subscribeSeries,
    getSeriesVersion,
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
    if (!view.metricsEnabled || !seriesCurrent || !Number.isFinite(seriesVersion)) return [];
    return buildAdvancedMarketPanes(
      metrics,
      view.seriesStore?.snapshot() || [],
      activeChannels,
      view.interval,
      realtimeClockMs,
    ).filter((pane) => pane.lines.some((line) => line.data.length > 0));
  }, [activeChannels, metrics, realtimeClockMs, seriesCurrent, seriesVersion, view.interval, view.metricsEnabled, view.seriesStore]);
}
