import React from "react";
import SingleChartPanes from "../components/SingleChartPanes";
import { ChartErrorBoundary } from "./AppProviders";
import type { ComponentType, PropsWithChildren, RefAttributes } from "react";
import type { ChartSurfaceHandle } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { SingleChartPanesProps } from "../components/SingleChartPanes.js";
import type { DrawingToolbarProps } from "../components/DrawingToolbar.js";
import type { ExportPanelProps } from "../features/export/ExportPanel.js";
import type { WatchlistSidebarProps } from "../features/watchlist/WatchlistSidebar.js";
import type { OrderBookRuntime } from "../features/order-book/orderBookTypes.js";
import type { AdvancedMarketRuntimeView } from "../features/advanced-market-data/advancedMarketDataTypes.js";
import { useAdvancedMarketPanes } from "../features/advanced-market-data/useAdvancedMarketPanes.js";
import MarketChartWorkspace from "./MarketChartWorkspace.js";
import { useTradeFlowPanes } from "../features/trade-flow/useTradeFlowPanes.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";
import { combineExternalMarkerSources } from "../chart-adapter/externalMarkerSource.js";
import type { ExternalMarkerSource } from "../chart-adapter/externalMarkerSource.js";
import type { PluginChartLayerSource } from "../features/plugins/pluginChartLayerSource.js";
import { preloadDrawingEngineHost } from "../features/drawings/drawingEngineLoader.js";
import { drawingToolWhenInteractionReady } from "./drawingInteractionReadiness.js";

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
  const advancedPanes = useAdvancedMarketPanes(chart.advancedMarketData);
  const tradeFlowPanes = useTradeFlowPanes(tradeFlow, chart.chartProps.seriesStore);
  const markerSource = React.useMemo(
    () => combineExternalMarkerSources([tradeFlow.view.markerSource, pluginMarkerSource]),
    [pluginMarkerSource, tradeFlow.view.markerSource],
  );
  const upstreamDrawingInteractionReadyChange =
    chart.chartProps.onDrawingInteractionReadyChange;
  const handleDrawingInteractionReadyChange = React.useCallback((ready: boolean) => {
    setDrawingInteractionReady(ready);
    upstreamDrawingInteractionReadyChange?.(ready);
  }, [upstreamDrawingInteractionReadyChange]);
  const drawingToolbarProps = React.useMemo(() => ({
    ...drawingToolbar,
    activeTool: drawingToolWhenInteractionReady(
      drawingToolbar.activeTool,
      drawingInteractionReady,
    ),
    drawingInteractionReady,
  }), [drawingInteractionReady, drawingToolbar]);
  const chartProps = React.useMemo(() => ({
    ...chart.chartProps,
    drawingTool: drawingToolWhenInteractionReady(
      chart.chartProps.drawingTool,
      drawingInteractionReady,
    ),
    onDrawingInteractionReadyChange: handleDrawingInteractionReadyChange,
    externalMarkerSource: markerSource,
    pluginChartLayerSource,
    subPanes: [
      ...tradeFlowPanes,
      ...advancedPanes,
      ...(chart.chartProps.subPanes || []),
    ],
  }), [
    advancedPanes,
    chart.chartProps,
    drawingInteractionReady,
    handleDrawingInteractionReadyChange,
    markerSource,
    pluginChartLayerSource,
    tradeFlowPanes,
  ]);

  const chartNode = chart.error ? (
          <div className="chart-area">
            <div className="error-overlay">
              <div className="error-icon">!</div>
              <div className="error-message">
                <strong>Data load failed</strong>
                <br />
                {chart.error}
                <br />
                <small style={{ color: "var(--text-muted)", marginTop: 8, display: "block" }}>
                  Ensure backend is running: `uvicorn app.main:app --reload`
                </small>
              </div>
              <button className="retry-btn" onClick={chart.onRetryLoad} id="retry-btn">
                Retry
              </button>
            </div>
          </div>
  ) : (
          <Boundary>
            <SingleChartPanes {...chartProps} />
          </Boundary>
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
