import React, { useCallback, useMemo } from "react";
import MarketRightRailFrame from "../../../app/MarketRightRailFrame.js";
import ReplayCapabilitySurface from "./ReplayCapabilitySurface.js";
import { buildReplayCapabilityModel } from "../replayCapabilityModel.js";
import ReplayPaperTradingDock from "./ReplayPaperTradingDock.js";
import ReplayWatchlistPanel from "./ReplayWatchlistPanel.js";
import type { ReplayWorkspacePreferenceActions, ReplayWorkspacePreferences } from "../replayWorkspacePreferences.js";
import type { ReplayIndicatorRuntime } from "../useReplayIndicatorRuntime.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";


export interface ReplayRightMarketRailProps {
  readonly runtime: ReplayRuntime;
  readonly viewer: ReplayViewerRuntime;
  readonly indicators: ReplayIndicatorRuntime;
  readonly preferences: ReplayWorkspacePreferences;
  readonly actions: ReplayWorkspacePreferenceActions;
  readonly upColor: string;
  readonly downColor: string;
}

function ReplayRightMarketRail({
  runtime,
  viewer,
  indicators,
  preferences,
  actions,
  upColor,
  downColor,
}: ReplayRightMarketRailProps) {
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? null;
  const selectedTrack = viewer.marketTracks?.tracks.find(
    (track) => track.track_id === selectedTrackId,
  ) ?? null;
  const capabilities = useMemo(() => buildReplayCapabilityModel(
    runtime.store.sessionConfig?.source_kind ?? "BAR",
    selectedTrack?.historical_book ?? null,
  ), [runtime.store.sessionConfig?.source_kind, selectedTrack?.historical_book]);
  const renderDock = useCallback((height: number) => (
    <section
      className={`replay-market-dock ${preferences.dockCollapsed ? "collapsed" : ""}`}
      style={{ height }}
      aria-label="回放市场与纸面交易面板"
    >
      <header className="replay-market-dock-tabs">
        {(["capabilities", "paper", "activity"] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            className={preferences.activeDock === tab ? "active" : ""}
            onClick={() => actions.setActiveDock(tab)}
          >{tab === "capabilities" ? "能力" : tab === "paper" ? "纸面交易" : "活动"}</button>
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
          {preferences.activeDock === "capabilities" && <ReplayCapabilitySurface capabilities={capabilities} />}
          {preferences.activeDock === "paper" && (
            <ReplayPaperTradingDock runtime={runtime} viewer={viewer} indicatorStatus={indicators.status} />
          )}
          {preferences.activeDock === "activity" && (
            <div className="replay-activity-summary" data-replay-panel="activity">
              <strong>已揭示活动</strong>
              <span>Orders {runtime.store.orders.length}</span>
              <span>Fills {runtime.store.fills.length}</span>
              <span>Warnings {runtime.store.warnings.length}</span>
              <span>Journal {runtime.store.journal.length}</span>
              <small>完整明细可在纸面交易 tab 与报告中查看。</small>
            </div>
          )}
        </div>
      )}
    </section>
  ), [actions, capabilities, indicators.status, preferences, runtime, viewer]);

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
        width: preferences.railWidth,
        collapsed: preferences.railCollapsed,
        onWidthChange: actions.setRailWidth,
      }}
      dockLayout={{
        height: preferences.dockHeight,
        collapsed: preferences.dockCollapsed,
        onHeightChange: actions.setDockHeight,
      }}
      upColor={upColor}
      downColor={downColor}
    />
  );
}

export default React.memo(ReplayRightMarketRail);
