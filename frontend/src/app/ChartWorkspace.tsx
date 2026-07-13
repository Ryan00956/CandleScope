import React from "react";
import SingleChartPanes from "../components/SingleChartPanes";
import { ChartErrorBoundary } from "./AppProviders";
import type { ComponentType, PropsWithChildren, RefAttributes } from "react";
import type { ChartSurfaceHandle } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { SingleChartPanesProps } from "../components/SingleChartPanes.js";
import type { DrawingToolbarProps } from "../components/DrawingToolbar.js";
import type { ExportPanelProps } from "../features/export/ExportPanel.js";
import type { WatchlistSidebarProps } from "../features/watchlist/WatchlistSidebar.js";

const ExportPanel = React.lazy(() => import("../features/export/ExportPanel"));
const DrawingToolbar = React.lazy(() => import("../features/drawings/DrawingToolbar"));
const WatchlistSidebar = React.lazy(() => import("../features/watchlist/WatchlistSidebar"));

export interface ChartWorkspaceChartModel {
  error?: string | null;
  onRetryLoad(): void;
  chartProps: SingleChartPanesProps & RefAttributes<ChartSurfaceHandle>;
}

export interface ChartWorkspaceProps {
  drawingToolbar: DrawingToolbarProps;
  exportPanel: ExportPanelProps;
  chart: ChartWorkspaceChartModel;
  watchlist: WatchlistSidebarProps;
  errorBoundary?: ComponentType<PropsWithChildren>;
}

function ChartWorkspace({
  drawingToolbar,
  exportPanel,
  chart,
  watchlist,
  errorBoundary = ChartErrorBoundary,
}: ChartWorkspaceProps) {
  const Boundary = errorBoundary;

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
            <SingleChartPanes {...chart.chartProps} />
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
        <WatchlistSidebar {...watchlist} />
      </React.Suspense>
    </div>
  );
}

export default React.memo(ChartWorkspace);
