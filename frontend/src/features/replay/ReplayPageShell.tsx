import type { RefObject } from "react";
import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketWorkspaceFrame from "../../app/MarketWorkspaceFrame.js";
import type { ChartSurfaceHandle } from "../../chart-adapter/useChartSurfaceRuntime.js";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";

export interface ReplayPageShellProps {
  runtime: ReplayRuntime;
  chartSurfaceRef: RefObject<ChartSurfaceHandle | null>;
}

function ReplayStatePanel({ runtime }: { runtime: ReplayRuntime }) {
  if (runtime.phase === "CONFIGURING") {
    return (
      <div className="chart-area" data-replay-state="configuring">
        <div className="error-overlay">
          <div className="error-message">
            <strong>K 线回放</strong>
            <br />
            Replay capability is available. Session configuration arrives in Phase 7.
          </div>
        </div>
      </div>
    );
  }
  if (runtime.phase === "ERROR" || runtime.phase === "ENTRY_ERROR") {
    return (
      <div className="chart-area" data-replay-state="error" data-replay-error={runtime.error?.code ?? "REPLAY_RUNTIME_ERROR"}>
        <div className="error-overlay">
          <div className="error-icon">!</div>
          <div className="error-message">
            <strong>Replay unavailable</strong>
            <br />
            {runtime.error?.code ?? "REPLAY_RUNTIME_ERROR"}: {runtime.error?.message ?? "Unknown replay error"}
            <br />
            <small style={{ color: "var(--text-muted)", marginTop: 8, display: "block" }}>
              Live and mock fallback are disabled on this page.
            </small>
          </div>
          {runtime.phase === "ERROR" && (
            <button className="retry-btn" type="button" onClick={runtime.actions.retry}>
              Retry replay
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="chart-area" data-replay-state="loading">
      <div className="error-overlay">
        <div className="error-message">
          <strong>K 线回放</strong>
          <br />
          {runtime.phase === "LOADING_CAPABILITIES" && "Checking replay capability…"}
          {runtime.phase === "VALIDATING_SESSION" && "Validating server session…"}
          {runtime.phase === "CONNECTING_SESSION" && "Waiting for atomic replay snapshot…"}
          {runtime.phase === "IDLE" && "Preparing replay runtime…"}
        </div>
      </div>
    </div>
  );
}

export default function ReplayPageShell({ runtime, chartSurfaceRef }: ReplayPageShellProps) {
  const { marketData } = runtime;
  const config = runtime.store.sessionConfig;
  const active = runtime.phase === "ACTIVE" && config !== null && runtime.store.hasAuthoritativeSnapshot;
  const chart = active ? (
    <SingleChartPanes
      ref={chartSurfaceRef}
      seriesStore={marketData.view.seriesStore}
      symbol={config.symbol}
      drawingKeyBase={`replay:${runtime.store.sessionId ?? "unknown"}`}
      interval={config.display_interval}
      loading={marketData.view.loading}
      onCrosshairMove={marketData.actions.onCrosshairMove}
      onNeedMoreLeft={null}
      canLoadMoreLeft={false}
      datasetKey={String(marketData.view.meta.seriesKey ?? "replay-uninitialized")}
      upColor="#22c55e"
      downColor="#ef4444"
      theme="dark"
      customBg="#0f172a"
      dataMeta={marketData.view.meta}
      onVisibleRangeChange={marketData.actions.onVisibleRangeChange}
    />
  ) : <ReplayStatePanel runtime={runtime} />;

  return (
    <MarketPageFrame
      topBar={(
        <header className="top-bar" id="replay-top-bar" data-runtime-source="replay">
          <div className="logo">
            <div className="logo-icon">◀</div>
            <span className="logo-text">CandleScope K 线回放</span>
          </div>
          <div style={{ marginLeft: 16, fontWeight: 600 }}>REPLAY</div>
          {config && (
            <div style={{ marginLeft: 16 }}>
              {config.exchange} · {config.market_type} · {config.symbol}
            </div>
          )}
        </header>
      )}
      intervalSelector={(
        <div className="interval-toolbar-wrap" data-replay-readonly="true">
          <span className="interval-btn active">{config?.display_interval ?? "--"}</span>
          <span style={{ marginLeft: 10, color: "var(--text-muted)" }}>server-authoritative historical timeline</span>
        </div>
      )}
      workspace={(
        <MarketWorkspaceFrame
          toolbar={(
            <div className="drawing-toolbar" aria-label="Replay chart tools">
              <span className="drawing-toolbar-label">REPLAY</span>
            </div>
          )}
          exportOverlay={null}
          chart={chart}
          rightRail={(
            <aside className="watchlist-sidebar replay-right-rail" style={{ width: 320 }} aria-label="Replay session status">
              <div style={{ padding: 16 }}>
                <strong>Replay session</strong>
                <div>State: {runtime.store.state ?? runtime.phase}</div>
                <div>Sequence: {runtime.store.sequence}</div>
                <div>Bars: {marketData.status.barCount}</div>
                <div>Connection: {runtime.store.connectionState}</div>
              </div>
            </aside>
          )}
        />
      )}
      featureSurfaces={null}
      statusBar={(
        <footer className="status-bar" id="replay-status-bar">
          <div className="status-left">
            <span><span className={`status-dot ${runtime.store.connectionState === "connected" ? "connected" : "loading"}`} />REPLAY</span>
            <span>{marketData.status.barCount} bars</span>
            <span>{runtime.store.statusReason ?? runtime.phase}</span>
          </div>
          <div className="status-right">
            <span>No live feeds</span>
            <span>replay.v1</span>
          </div>
        </footer>
      )}
    />
  );
}
