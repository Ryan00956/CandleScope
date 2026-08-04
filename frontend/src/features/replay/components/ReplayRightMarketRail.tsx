import React, { useCallback, useMemo, useState } from "react";
import MarketRightRailFrame from "../../../app/MarketRightRailFrame.js";
import ReplayCapabilitySurface from "./ReplayCapabilitySurface.js";
import { buildReplayCapabilityModel } from "../replayCapabilityModel.js";
import ReplayMarketDataDock from "./ReplayMarketDataDock.js";
import ReplayPaperTradingDock from "./ReplayPaperTradingDock.js";
import ReplayTradingWorkbench from "./ReplayTradingWorkbench.js";
import ReplayWatchlistPanel from "./ReplayWatchlistPanel.js";
import type { ReplayWorkspacePreferenceActions, ReplayWorkspacePreferences } from "../replayWorkspacePreferences.js";
import type {
  ReplaySharedIndicatorRuntime,
} from "../useReplaySharedIndicatorRuntime.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";


export interface ReplayRightMarketRailProps {
  readonly runtime: ReplayRuntime;
  readonly viewer: ReplayViewerRuntime;
  readonly indicators: ReplaySharedIndicatorRuntime;
  readonly preferences: ReplayWorkspacePreferences;
  readonly actions: ReplayWorkspacePreferenceActions;
  readonly upColor: string;
  readonly downColor: string;
  readonly formatTime: (valueMs: number) => string;
}

function ReplayRightMarketRail({
  runtime,
  viewer,
  indicators,
  preferences,
  actions,
  upColor,
  downColor,
  formatTime,
}: ReplayRightMarketRailProps) {
  const [accountDockOpen, setAccountDockOpen] = useState(false);
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? null;
  const selectedTrack = viewer.marketTracks?.tracks.find(
    (track) => track.track_id === selectedTrackId,
  ) ?? null;
  const capabilities = useMemo(() => buildReplayCapabilityModel(
    runtime.store.sessionConfig?.source_kind ?? "BAR",
    selectedTrack?.historical_book ?? null,
  ), [runtime.store.sessionConfig?.source_kind, selectedTrack?.historical_book]);
  const activeDock = accountDockOpen ? "account" : preferences.activeDock;
  const effectiveRailWidth = activeDock === "paper" || activeDock === "account"
    ? Math.max(400, preferences.railWidth)
    : preferences.railWidth;
  const selectDock = useCallback((dock: "paper" | "account" | "activity" | "capabilities") => {
    if (dock === "account") {
      setAccountDockOpen(true);
      return;
    }
    setAccountDockOpen(false);
    actions.setActiveDock(dock);
  }, [actions]);
  const renderDock = useCallback((height: number) => (
    <section
      className={`replay-market-dock ${preferences.dockCollapsed ? "collapsed" : ""}`}
      style={{ height }}
      aria-label="回放市场与纸面交易面板"
      data-active-dock={activeDock}
    >
      <header className="replay-market-dock-tabs">
        {(["paper", "account", "activity", "capabilities"] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            className={activeDock === tab ? "active" : ""}
            onClick={() => selectDock(tab)}
          >{tab === "paper" ? "下单" : tab === "account" ? "仓位" : tab === "activity" ? "市场" : "能力"}</button>
        ))}
        <button
          type="button"
          className="replay-market-dock-collapse"
          onClick={() => actions.setDockCollapsed(!preferences.dockCollapsed)}
          aria-label={preferences.dockCollapsed ? "展开回放面板" : "收起回放面板"}
        >{preferences.dockCollapsed ? "⌃" : "⌄"}</button>
      </header>
      {!preferences.dockCollapsed && (
        <div className="replay-market-dock-body">
          {activeDock === "capabilities" && <ReplayCapabilitySurface capabilities={capabilities} />}
          {activeDock === "paper" && (
            <ReplayPaperTradingDock
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
          {activeDock === "account" && (
            <ReplayTradingWorkbench
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
          {activeDock === "activity" && (
            <ReplayMarketDataDock
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
        </div>
      )}
    </section>
  ), [actions, activeDock, capabilities, formatTime, indicators.status, preferences.dockCollapsed, runtime, selectDock, viewer]);

  return (
    <MarketRightRailFrame
      source="replay"
      ariaLabel="回放自选与市场侧栏"
      sidebar={(
        <ReplayWatchlistPanel
          runtime={runtime}
          viewer={viewer}
          collapsed={preferences.railCollapsed}
          onCollapsedChange={actions.setRailCollapsed}
        />
      )}
      renderDock={renderDock}
      layout={{
        width: effectiveRailWidth,
        collapsed: preferences.railCollapsed,
        onWidthChange: actions.setRailWidth,
      }}
      dockLayout={{
        height: preferences.dockHeight,
        collapsed: preferences.dockCollapsed,
        onHeightChange: actions.setDockHeight,
        minimumSidebarHeight: activeDock === "account" ? 90 : 130,
      }}
      upColor={upColor}
      downColor={downColor}
    />
  );
}

export default React.memo(ReplayRightMarketRail);
