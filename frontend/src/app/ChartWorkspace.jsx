import React from "react";
import SingleChartPanes from "../components/SingleChartPanes";
import { ChartErrorBoundary } from "./AppProviders";

const ExportPanel = React.lazy(() => import("../features/export/ExportPanel"));
const DrawingToolbar = React.lazy(() => import("../features/drawings/DrawingToolbar"));
const WatchlistSidebar = React.lazy(() => import("../features/watchlist/WatchlistSidebar"));

export default function ChartWorkspace({
  drawingToolbar,
  exportPanel,
  chart,
  watchlist,
  errorBoundary = ChartErrorBoundary,
}) {
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
