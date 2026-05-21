import React from "react";
import MultiPaneChart from "../MultiPaneChart";

const ExportPanel = React.lazy(() => import("../ExportPanel"));
const DrawingToolbar = React.lazy(() => import("../../features/drawings/DrawingToolbar"));
const WatchlistSidebar = React.lazy(() => import("../WatchlistSidebar"));

class ChartErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 16,
          color: "#94a3b8", padding: 32,
        }}>
          <div style={{ fontSize: 48 }}>鈿狅笍</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>
            Chart rendering error
          </div>
          <div style={{ fontSize: 13, maxWidth: 400, textAlign: "center" }}>
            {this.state.error?.message || "Unknown error"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "8px 24px", background: "#3b82f6", color: "#fff",
              border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
            <MultiPaneChart {...chart.chartProps} />
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
