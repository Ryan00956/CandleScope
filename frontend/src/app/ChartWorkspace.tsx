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
import { useTradeFlowPanes } from "../features/trade-flow/useTradeFlowPanes.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";

const ExportPanel = React.lazy(() => import("../features/export/ExportPanel"));
const DrawingToolbar = React.lazy(() => import("../features/drawings/DrawingToolbar"));
const RightMarketRail = React.lazy(() => import("./RightMarketRail"));

export interface ChartWorkspaceChartModel {
  error?: string | null;
  onRetryLoad(): void;
  advancedMarketData: AdvancedMarketRuntimeView;
  chartProps: SingleChartPanesProps & RefAttributes<ChartSurfaceHandle>;
}

export interface ChartWorkspaceProps {
  drawingToolbar: DrawingToolbarProps;
  exportPanel: ExportPanelProps;
  chart: ChartWorkspaceChartModel;
  watchlist: WatchlistSidebarProps;
  orderBook: OrderBookRuntime;
  tradeFlow: TradeFlowRuntime;
  errorBoundary?: ComponentType<PropsWithChildren>;
}

function ChartWorkspace({
  drawingToolbar,
  exportPanel,
  chart,
  watchlist,
  orderBook,
  tradeFlow,
  errorBoundary = ChartErrorBoundary,
}: ChartWorkspaceProps) {
  const Boundary = errorBoundary;
  const advancedPanes = useAdvancedMarketPanes(chart.advancedMarketData);
  const tradeFlowPanes = useTradeFlowPanes(tradeFlow, chart.chartProps.seriesStore);
  const chartProps = React.useMemo(() => ({
    ...chart.chartProps,
    externalMarkerSource: tradeFlow.view.markerSource,
    subPanes: [
      ...tradeFlowPanes,
      ...advancedPanes,
      ...(chart.chartProps.subPanes || []),
    ],
  }), [advancedPanes, chart.chartProps, tradeFlow.view.markerSource, tradeFlowPanes]);

  return (
    <div className="main-content-area">
      <div className="chart-with-toolbar">
        <React.Suspense fallback={<div className="drawing-toolbar drawing-toolbar-loading" aria-hidden="true" />}>
          <DrawingToolbar {...drawingToolbar} />
        </React.Suspense>

        {exportPanel.isOpen && (
          <React.Suspense fallback={null}>
            <ExportPanel {...exportPanel} />
          </React.Suspense>
        )}

        {chart.error ? (
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
        )}
      </div>

      <React.Suspense
        fallback={(
          <div
            className="watchlist-sidebar watchlist-sidebar-loading"
            aria-hidden="true"
            style={{ width: 320 }}
          />
        )}
      >
        <RightMarketRail watchlist={watchlist} orderBook={orderBook} tradeFlow={tradeFlow} />
      </React.Suspense>
    </div>
  );
}

export default React.memo(ChartWorkspace);
