import { memo, useMemo } from "react";
import IntervalSelector from "../components/IntervalSelector";
import ChartWorkspace from "./ChartWorkspace";
import LazyFeatureSurfaces from "./LazyFeatureSurfaces";
import StatusBar from "./StatusBar";
import TopBar from "./TopBar";
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
  tradeFlow,
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
      tradeFlow,
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
      tradeFlow,
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
    <div className="app-layout" ref={pageExportRef}>
      <TopBar {...model.topBar} />

      <IntervalSelector {...model.intervalSelector} />

      <ChartWorkspace {...chartWorkspace} />

      <LazyFeatureSurfaces surfaces={model.lazySurfaces} />

      <StatusBar status={model.statusBar} />
    </div>
  );
}

export default memo(AppShell);
