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
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";

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
  const locale = useLocale();
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
      title: t("replay.rail.watchlist", {}, locale),
      icon: <WatchlistRailIcon />,
      order: 10,
      sizing: "flex",
      defaultHeight: 260,
      minHeight: MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
      collapsedSummary: t("replay.rail.watchlistSummary", {}, locale),
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.paper,
      title: t("replay.rail.paper", {}, locale),
      icon: <PaperRailIcon />,
      order: 20,
      sizing: "fixed",
      defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: MARKET_DOCK_MIN_HEIGHT,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
      collapsedSummary: t("replay.rail.paperSummary", {}, locale),
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.account,
      title: t("replay.rail.account", {}, locale),
      icon: <AccountRailIcon />,
      order: 30,
      sizing: "fixed",
      defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: 180,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
      collapsedSummary: t("replay.rail.accountSummary", {}, locale),
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.activity,
      title: t("replay.rail.activity", {}, locale),
      icon: <ActivityRailIcon />,
      order: 40,
      sizing: "fixed",
      defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: MARKET_DOCK_MIN_HEIGHT,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
      collapsedSummary: t("replay.rail.activitySummary", {}, locale),
    },
    {
      id: REPLAY_RAIL_VIEW_IDS.capabilities,
      title: t("replay.rail.capabilities", {}, locale),
      icon: <CapabilityRailIcon />,
      order: 50,
      sizing: "fixed",
      defaultHeight: 280,
      minHeight: 160,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
      collapsedSummary: t("replay.rail.capabilitiesSummary", {}, locale),
    },
  ], [locale]);

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
    actions.closeView(viewId as ReplayRailViewId);
  }, [actions]);

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
      viewId === REPLAY_RAIL_VIEW_IDS.paper ? t("replay.rail.paper", {}, locale)
        : viewId === REPLAY_RAIL_VIEW_IDS.account ? t("replay.rail.account", {}, locale)
          : viewId === REPLAY_RAIL_VIEW_IDS.activity ? t("replay.rail.activity", {}, locale)
            : viewId === REPLAY_RAIL_VIEW_IDS.capabilities ? t("replay.rail.capabilities", {}, locale)
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
        aria-label={t("replay.rail.dockAria", { title }, locale)}
      >
        <header className="replay-market-dock-tabs">
          <span className="ob-title">{title}</span>
          <button
            type="button"
            className="replay-market-dock-collapse"
            onClick={() => closeView(viewId)}
            aria-label={t("replay.rail.collapse", { title }, locale)}
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
    locale,
    viewer,
  ]);

  return (
    <MarketRightRailFrame
      source="replay"
      ariaLabel={t("replay.rail.sidebarAria")}
      views={views}
      openViewIds={preferences.openViewIds}
      panelCollapsed={preferences.panelCollapsed}
      onToggleView={onToggleView}
      onTogglePanelCollapsed={actions.togglePanelCollapsed}
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
