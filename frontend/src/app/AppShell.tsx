import { memo, useMemo } from "react";
import IntervalSelector from "../components/IntervalSelector";
import ChartWorkspace from "./ChartWorkspace";
import LazyFeatureSurfaces from "./LazyFeatureSurfaces";
import StatusBar from "./StatusBar";
import TopBar from "./TopBar";
import MarketPageFrame from "./MarketPageFrame";
import { buildAppShellViewModel } from "./appShellViewModel";
import type { AppShellProps } from "./appShellContracts.js";
import PluginPlatformSurfaces, { PluginUiErrorBoundary } from "../features/plugins/PluginPlatformSurfaces.js";
import PluginPlatformToolbar from "../features/plugins/PluginPlatformToolbar.js";
import PluginPlatformStatus from "../features/plugins/PluginPlatformStatus.js";
import PluginLiveControl from "../features/plugins/PluginLiveControl.js";

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
  replayEntry,
  onOpenReplayLauncher,
  plugins,
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
      replayEntry,
      onOpenReplayLauncher,
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
      replayEntry,
      onOpenReplayLauncher,
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

  const featureSurfaces = useMemo(() => ({
    ...model.lazySurfaces,
    settingsModal: {
      ...model.lazySurfaces.settingsModal,
      plugins,
    },
  }), [model.lazySurfaces, plugins]);

  return (
    <MarketPageFrame
      rootRef={pageExportRef}
      topBar={<TopBar {...model.topBar} extensionControls={<PluginUiErrorBoundary><PluginPlatformToolbar runtime={plugins} /></PluginUiErrorBoundary>} />}
      intervalSelector={<IntervalSelector {...model.intervalSelector} />}
      workspace={(
        <ChartWorkspace
          {...chartWorkspace}
          pluginMarkerSource={plugins.view.markerSource}
          pluginChartLayerSource={plugins.view.chartLayerSource}
        />
      )}
      featureSurfaces={(
        <>
          <LazyFeatureSurfaces surfaces={featureSurfaces} />
          <PluginUiErrorBoundary>
            <PluginLiveControl runtime={plugins} />
          </PluginUiErrorBoundary>
          <PluginPlatformSurfaces runtime={plugins} />
        </>
      )}
      statusBar={<StatusBar status={model.statusBar} extensions={<PluginUiErrorBoundary><PluginPlatformStatus runtime={plugins} /></PluginUiErrorBoundary>} />}
    />
  );
}

export default memo(AppShell);
