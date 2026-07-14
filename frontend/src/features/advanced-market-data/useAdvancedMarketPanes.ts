import { useMemo } from "react";
import { buildAdvancedMarketPanes } from "./metricPaneProjection.js";
import { useAdvancedMarketMetrics } from "./useAdvancedMarketSnapshots.js";
import type { AdvancedMarketRuntimeView } from "./advancedMarketDataTypes.js";
import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";

export function useAdvancedMarketPanes(
  view: AdvancedMarketRuntimeView,
): IndicatorSubPane[] {
  const metrics = useAdvancedMarketMetrics(view);
  const seriesVersion = Number(view.seriesStore?.version ?? 0);
  return useMemo(() => {
    if (!view.enabled || !Number.isFinite(seriesVersion)) return [];
    return buildAdvancedMarketPanes(metrics, view.seriesStore?.snapshot() || []);
  }, [metrics, seriesVersion, view.enabled, view.seriesStore]);
}
