import type { RefAttributes } from "react";
import type { ChartSurfaceHandle } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { SingleChartPanesProps } from "../../components/SingleChartPanes.js";
import type { MarketChartSourceRuntime } from "./marketChartSourceRuntime.js";

export type MarketChartSurfaceChartProps = SingleChartPanesProps & RefAttributes<ChartSurfaceHandle>;

export function bindMarketChartSurfaceProps(input: {
  source: MarketChartSourceRuntime;
  chartProps: MarketChartSurfaceChartProps;
  supplementalPanes?: NonNullable<SingleChartPanesProps["subPanes"]>;
  paused?: boolean;
}): MarketChartSurfaceChartProps {
  const { source, chartProps } = input;
  const restoreLatestWindow = source.marketData.actions.restoreLatestWindow;
  return {
    ...chartProps,
    symbol: source.session.symbol,
    interval: source.session.interval,
    datasetKey: source.datasetKey,
    seriesStore: source.marketData.view.seriesStore,
    loading: source.marketData.view.loading,
    dataMeta: source.marketData.view.meta,
    onNeedMoreLeft: source.marketData.actions.loadMoreLeft,
    ...(restoreLatestWindow ? { onNeedMoreRight: restoreLatestWindow } : {}),
    canLoadMoreLeft: source.marketData.status.canLoadMoreLeft,
    canRestoreLatestWindow: source.marketData.status.canRestoreLatestWindow,
    onCrosshairMove: chartProps.onCrosshairMove ?? source.marketData.actions.onCrosshairMove,
    onVisibleRangeChange: chartProps.onVisibleRangeChange
      ?? source.marketData.actions.onVisibleRangeChange,
    subPanes: [
      ...(input.supplementalPanes ?? []),
      ...(chartProps.subPanes ?? []),
    ],
    suspended: Boolean(input.paused)
      || source.lifecycle === "PAUSED"
      || source.lifecycle === "DISPOSED",
  };
}
