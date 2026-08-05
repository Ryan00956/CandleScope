import React, { useCallback, useMemo } from "react";
import MarketRightRailFrame from "../../../app/MarketRightRailFrame.js";
import {
  AccountRailIcon,
  ActivityRailIcon,
  CapabilityRailIcon,
  PaperRailIcon,
  WatchlistRailIcon,
} from "../../../app/marketRailIcons.js";
import type { MarketRailViewDescriptor } from "../../../app/marketRailTypes.js";
import {
  MARKET_DOCK_DEFAULT_HEIGHT,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
  MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
} from "../../../shared/marketRailLayout.js";
import ReplayCapabilitySurface from "./ReplayCapabilitySurface.js";
import { buildReplayCapabilityModel } from "../replayCapabilityModel.js";
import ReplayMarketDataDock from "./ReplayMarketDataDock.js";
import ReplayPaperTradingDock from "./ReplayPaperTradingDock.js";
import ReplayTradingWorkbench from "./ReplayTradingWorkbench.js";
import ReplayWatchlistPanel from "./ReplayWatchlistPanel.js";
import {
  REPLAY_RAIL_VIEW_IDS,
} from "../replayWorkspacePreferences.js";
import type {
  ReplayRailViewId,
  ReplayWorkspacePreferenceActions,
  ReplayWorkspacePreferences,
} from "../replayWorkspacePreferences.js";
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
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? null;
  const selectedTrack = viewer.marketTracks?.tracks.find(
    (track) => track.track_id === selectedTrackId,
  ) ?? null;
  const capabilities = useMemo(() => buildReplayCapabilityModel(
    runtime.store.sessionConfig?.source_kind ?? "BAR",
    selectedTrack?.historical_book ?? null,
  ), [runtime.store.sessionConfig?.source_kind, selectedTrack?.historical_book]);

  const views = useMemo<MarketRailViewDescriptor[]>(() => [
    {
      id: REPLAY_RAIL_VIEW_IDS.watchlist,
      title: "自选",
      icon: <WatchlistRailIcon />,
      order: 10,
      sizing: "flex",
      minHeight: MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.paper,
      title: "下单",
      icon: <PaperRailIcon />,
      order: 20,
      sizing: "fixed",
      defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: MARKET_DOCK_MIN_HEIGHT,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.account,
      title: "仓位",
      icon: <AccountRailIcon />,
      order: 30,
      sizing: "fixed",
      defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: 180,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.activity,
      title: "市场",
      icon: <ActivityRailIcon />,
      order: 40,
      sizing: "fixed",
      defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: MARKET_DOCK_MIN_HEIGHT,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.capabilities,
      title: "能力",
      icon: <CapabilityRailIcon />,
      order: 50,
      sizing: "fixed",
      defaultHeight: 280,
      minHeight: 160,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
  ], []);

  const onToggleView = useCallback((viewId: string) => {
    actions.toggleView(viewId as ReplayRailViewId);
  }, [actions]);

  const effectiveRailWidth = preferences.openViewIds.includes(REPLAY_RAIL_VIEW_IDS.paper)
    || preferences.openViewIds.includes(REPLAY_RAIL_VIEW_IDS.account)
    ? Math.max(400, preferences.railWidth)
    : preferences.railWidth;

  const onViewHeightChange = useCallback((viewId: string, height: number) => {
    actions.setViewHeight(viewId as ReplayRailViewId, height);
  }, [actions]);

  const closeView = useCallback((viewId: string) => {
    if (preferences.openViewIds.includes(viewId as ReplayRailViewId)) onToggleView(viewId);
  }, [onToggleView, preferences.openViewIds]);

  const renderView = useCallback((viewId: string) => {
    if (viewId === REPLAY_RAIL_VIEW_IDS.watchlist) {
      return (
        <ReplayWatchlistPanel
          runtime={runtime}
          viewer={viewer}
          collapsed={false}
          onCollapsedChange={(collapsed) => {
            if (collapsed) closeView(REPLAY_RAIL_VIEW_IDS.watchlist);
            else if (!preferences.openViewIds.includes(REPLAY_RAIL_VIEW_IDS.watchlist)) {
              onToggleView(REPLAY_RAIL_VIEW_IDS.watchlist);
            }
          }}
        />
      );
    }

    const title =
      viewId === REPLAY_RAIL_VIEW_IDS.paper ? "下单"
        : viewId === REPLAY_RAIL_VIEW_IDS.account ? "仓位"
          : viewId === REPLAY_RAIL_VIEW_IDS.activity ? "市场"
            : viewId === REPLAY_RAIL_VIEW_IDS.capabilities ? "能力"
              : viewId;
    const dockAttr =
      viewId === REPLAY_RAIL_VIEW_IDS.paper ? "paper"
        : viewId === REPLAY_RAIL_VIEW_IDS.account ? "account"
          : viewId === REPLAY_RAIL_VIEW_IDS.activity ? "activity"
            : "capabilities";

    return (
      <section
        className="replay-market-dock"
        style={{ height: "100%" }}
        data-active-dock={dockAttr}
        aria-label={`回放${title}`}
      >
        <header className="replay-market-dock-tabs">
          <span className="ob-title">{title}</span>
          <button
            type="button"
            className="replay-market-dock-collapse"
            onClick={() => closeView(viewId)}
            aria-label={`关闭${title}面板`}
          >×</button>
        </header>
        <div className="replay-market-dock-body">
          {viewId === REPLAY_RAIL_VIEW_IDS.capabilities && (
            <ReplayCapabilitySurface capabilities={capabilities} />
          )}
          {viewId === REPLAY_RAIL_VIEW_IDS.paper && (
            <ReplayPaperTradingDock
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
          {viewId === REPLAY_RAIL_VIEW_IDS.account && (
            <ReplayTradingWorkbench
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
          {viewId === REPLAY_RAIL_VIEW_IDS.activity && (
            <ReplayMarketDataDock
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
        </div>
      </section>
    );
  }, [
    capabilities,
    closeView,
    formatTime,
    indicators.status,
    onToggleView,
    preferences.openViewIds,
    runtime,
    viewer,
  ]);

  return (
    <MarketRightRailFrame
      source="replay"
      ariaLabel="回放自选与市场侧栏"
      views={views}
      openViewIds={preferences.openViewIds}
      onToggleView={onToggleView}
      renderView={renderView}
      layout={{
        width: effectiveRailWidth,
        onWidthChange: actions.setRailWidth,
      }}
      viewHeights={preferences.viewHeights}
      onViewHeightChange={onViewHeightChange}
      upColor={upColor}
      downColor={downColor}
    />
  );
}

export default React.memo(ReplayRightMarketRail);
