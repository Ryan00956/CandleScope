import { memo, useMemo } from "react";
import IntervalSelector from "../components/IntervalSelector";
import ChartWorkspace from "./ChartWorkspace";
import LazyFeatureSurfaces from "./LazyFeatureSurfaces";
import StatusBar from "./StatusBar";
import TopBar from "./TopBar";
import MarketPageFrame from "./MarketPageFrame";
import { buildAppShellViewModel } from "./appShellViewModel";
import type { AppShellProps } from "./appShellContracts.js";

function AppShell({
  pageExportRef,
  chartSurfaceRef,
  session,
  marketData,
  advancedMarketData,
  drawings,
  indicators,
  settings,
  priceScale,
  watchlist,
  orderBook,
  exportFlow,
  alerts,
}: AppShellProps) {
  const model = useMemo(
    () => buildAppShellViewModel({
      session,
      marketData,
      advancedMarketData,
      drawings,
      indicators,
      settings,
      priceScale,
      watchlist,
      orderBook,
      exportFlow,
      alerts,
    }),
    [
      session,
      marketData,
      advancedMarketData,
      drawings,
      indicators,
      settings,
      priceScale,
      watchlist,
      orderBook,
      exportFlow,
      alerts,
    ],
  );

  const chartWorkspace = useMemo(() => ({
    ...model.chartWorkspace,
    chart: {
      ...model.chartWorkspace.chart,
      chartProps: {
        ...model.chartWorkspace.chart.chartProps,
        ref: chartSurfaceRef,
      },
    },
  }), [model.chartWorkspace, chartSurfaceRef]);

  return (
    <MarketPageFrame
      rootRef={pageExportRef}
      topBar={<TopBar {...model.topBar} />}
      intervalSelector={<IntervalSelector {...model.intervalSelector} />}
      workspace={<ChartWorkspace {...chartWorkspace} />}
      featureSurfaces={<LazyFeatureSurfaces surfaces={model.lazySurfaces} />}
      statusBar={<StatusBar status={model.statusBar} />}
    />
  );
}

export default memo(AppShell);
