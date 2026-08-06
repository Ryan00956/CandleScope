import React from "react";
import { ChartErrorBoundary } from "./AppProviders";
import type { ComponentType, PropsWithChildren, RefAttributes } from "react";
import type { ChartSurfaceHandle } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { SingleChartPanesProps } from "../components/SingleChartPanes.js";
import type { DrawingToolbarProps } from "../components/DrawingToolbar.js";
import type { ExportPanelProps } from "../features/export/ExportPanel.js";
import type { WatchlistSidebarProps } from "../features/watchlist/WatchlistSidebar.js";
import type { OrderBookRuntime } from "../features/order-book/orderBookTypes.js";
import type { AdvancedMarketRuntimeView } from "../features/advanced-market-data/advancedMarketDataTypes.js";
import MarketChartWorkspace from "./MarketChartWorkspace.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";
import type { ExternalMarkerSource } from "../chart-adapter/externalMarkerSource.js";
import type { PluginChartLayerSource } from "../features/plugins/pluginChartLayerSource.js";
import { preloadDrawingEngineHost } from "../features/drawings/drawingEngineLoader.js";
import { drawingToolWhenInteractionReady } from "./drawingInteractionReadiness.js";
import ChartCellCanvas from "./ChartCellCanvas.js";

const ExportPanel = React.lazy(() => import("../features/export/ExportPanel"));
const DrawingToolbar = React.lazy(() => {
  preloadDrawingEngineHost();
  return import("../features/drawings/DrawingToolbar");
});
const RightMarketRail = React.lazy(() => import("./RightMarketRail"));

export interface ChartWorkspaceChartModel {
  error?: string | null;
  onRetryLoad(): void;
  advancedMarketData: AdvancedMarketRuntimeView;
  chartProps: SingleChartPanesProps & RefAttributes<ChartSurfaceHandle>;
}

export interface ChartWorkspaceRailLayout {
  openViewIds: readonly string[];
  onToggleView: (viewId: string) => void;
  viewHeights: Readonly<Record<string, number>>;
  onViewHeightChange: (viewId: string, height: number) => void;
}

export interface ChartWorkspaceProps {
  drawingToolbar: DrawingToolbarProps;
  exportPanel: ExportPanelProps;
  chart: ChartWorkspaceChartModel;
  watchlist: WatchlistSidebarProps;
  orderBook: OrderBookRuntime;
  tradeFlow: TradeFlowRuntime;
  marketRail: ChartWorkspaceRailLayout;
  pluginMarkerSource?: ExternalMarkerSource | null;
  pluginChartLayerSource?: PluginChartLayerSource | null;
  errorBoundary?: ComponentType<PropsWithChildren>;
}

function ChartWorkspace({
  drawingToolbar,
  exportPanel,
  chart,
  watchlist,
  orderBook,
  tradeFlow,
  marketRail,
  pluginMarkerSource = null,
  pluginChartLayerSource = null,
  errorBoundary = ChartErrorBoundary,
}: ChartWorkspaceProps) {
  const Boundary = errorBoundary;
  const [drawingInteractionReady, setDrawingInteractionReady] = React.useState(false);
  const drawingToolbarProps = React.useMemo(() => ({
    ...drawingToolbar,
    activeTool: drawingToolWhenInteractionReady(
      drawingToolbar.activeTool,
      drawingInteractionReady,
    ),
    drawingInteractionReady,
  }), [drawingInteractionReady, drawingToolbar]);
  const chartNode = (
    <ChartCellCanvas
      chart={chart}
      tradeFlow={tradeFlow}
      pluginMarkerSource={pluginMarkerSource}
      pluginChartLayerSource={pluginChartLayerSource}
      errorBoundary={Boundary}
      drawingInteractionReady={drawingInteractionReady}
      onDrawingInteractionReadyChange={setDrawingInteractionReady}
    />
  );

  return (
    <MarketChartWorkspace
      toolbar={(
        <React.Suspense fallback={<div className="drawing-toolbar drawing-toolbar-loading" aria-hidden="true" />}>
          <DrawingToolbar {...drawingToolbarProps} />
        </React.Suspense>
      )}
      exportOverlay={exportPanel.isOpen ? (
        <React.Suspense fallback={null}>
          <ExportPanel {...exportPanel} />
        </React.Suspense>
      ) : null}
      chart={chartNode}
      rightRail={(
        <React.Suspense
          fallback={(
            <div
              className="right-market-rail market-rail-loading"
              aria-hidden="true"
            />
          )}
        >
          <RightMarketRail
            watchlist={watchlist}
            orderBook={orderBook}
            tradeFlow={tradeFlow}
            openViewIds={marketRail.openViewIds}
            onToggleView={marketRail.onToggleView}
            viewHeights={marketRail.viewHeights}
            onViewHeightChange={marketRail.onViewHeightChange}
          />
        </React.Suspense>
      )}
    />
  );
}

export default React.memo(ChartWorkspace);
