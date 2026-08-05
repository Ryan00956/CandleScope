import React, { useCallback, useMemo, useState } from "react";
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
import type { ReplayWorkspacePreferenceActions, ReplayWorkspacePreferences } from "../replayWorkspacePreferences.js";
import type {
  ReplaySharedIndicatorRuntime,
} from "../useReplaySharedIndicatorRuntime.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";

const REPLAY_VIEW_IDS = {
  watchlist: "replay-watchlist",
  paper: "replay-paper",
  account: "replay-account",
  activity: "replay-activity",
  capabilities: "replay-capabilities",
} as const;

type ReplayDockViewId =
  | typeof REPLAY_VIEW_IDS.paper
  | typeof REPLAY_VIEW_IDS.account
  | typeof REPLAY_VIEW_IDS.activity
  | typeof REPLAY_VIEW_IDS.capabilities;

function initialOpenViewIds(preferences: ReplayWorkspacePreferences): string[] {
  const open: string[] = [];
  if (!preferences.railCollapsed) open.push(REPLAY_VIEW_IDS.watchlist);
  if (!preferences.dockCollapsed) {
    if (preferences.activeDock === "activity") open.push(REPLAY_VIEW_IDS.activity);
    else if (preferences.activeDock === "capabilities") open.push(REPLAY_VIEW_IDS.capabilities);
    else open.push(REPLAY_VIEW_IDS.paper);
  }
  return open;
}

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
  const [openViewIds, setOpenViewIds] = useState(() => initialOpenViewIds(preferences));
  const [viewHeights, setViewHeights] = useState<Record<string, number>>(() => ({
    [REPLAY_VIEW_IDS.paper]: preferences.dockHeight || MARKET_DOCK_DEFAULT_HEIGHT,
    [REPLAY_VIEW_IDS.account]: Math.max(preferences.dockHeight || MARKET_DOCK_DEFAULT_HEIGHT, 360),
    [REPLAY_VIEW_IDS.activity]: preferences.dockHeight || MARKET_DOCK_DEFAULT_HEIGHT,
    [REPLAY_VIEW_IDS.capabilities]: 280,
  }));

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
      id: REPLAY_VIEW_IDS.watchlist,
      title: "自选",
      icon: <WatchlistRailIcon />,
      order: 10,
      sizing: "flex",
      minHeight: MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
    },
    {
      id: REPLAY_VIEW_IDS.paper,
      title: "下单",
      icon: <PaperRailIcon />,
      order: 20,
      sizing: "fixed",
      defaultHeight: preferences.dockHeight || MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: MARKET_DOCK_MIN_HEIGHT,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
    {
      id: REPLAY_VIEW_IDS.account,
      title: "仓位",
      icon: <AccountRailIcon />,
      order: 30,
      sizing: "fixed",
      defaultHeight: Math.max(preferences.dockHeight || MARKET_DOCK_DEFAULT_HEIGHT, 360),
      minHeight: 180,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
    {
      id: REPLAY_VIEW_IDS.activity,
      title: "市场",
      icon: <ActivityRailIcon />,
      order: 40,
      sizing: "fixed",
      defaultHeight: preferences.dockHeight || MARKET_DOCK_DEFAULT_HEIGHT,
      minHeight: MARKET_DOCK_MIN_HEIGHT,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
    {
      id: REPLAY_VIEW_IDS.capabilities,
      title: "能力",
      icon: <CapabilityRailIcon />,
      order: 50,
      sizing: "fixed",
      defaultHeight: 280,
      minHeight: 160,
      maxHeight: MARKET_DOCK_MAX_HEIGHT,
    },
  ], [preferences.dockHeight]);

  const syncLegacyPreferences = useCallback((nextOpen: readonly string[]) => {
    const watchlistOpen = nextOpen.includes(REPLAY_VIEW_IDS.watchlist);
    actions.setRailCollapsed(!watchlistOpen);
    const dockIds: ReplayDockViewId[] = [
      REPLAY_VIEW_IDS.paper,
      REPLAY_VIEW_IDS.account,
      REPLAY_VIEW_IDS.activity,
      REPLAY_VIEW_IDS.capabilities,
    ];
    const openDocks = dockIds.filter((id) => nextOpen.includes(id));
    actions.setDockCollapsed(openDocks.length === 0);
    // Prefer a persisted dock key (account is activity-bar-only and not in ReplayDockView).
    const primary = [...openDocks].reverse().find((id) => id !== REPLAY_VIEW_IDS.account);
    if (primary === REPLAY_VIEW_IDS.paper) actions.setActiveDock("paper");
    else if (primary === REPLAY_VIEW_IDS.activity) actions.setActiveDock("activity");
    else if (primary === REPLAY_VIEW_IDS.capabilities) actions.setActiveDock("capabilities");
  }, [actions]);

  const onToggleView = useCallback((viewId: string) => {
    setOpenViewIds((current) => {
      const next = current.includes(viewId)
        ? current.filter((id) => id !== viewId)
        : [...current, viewId];
      syncLegacyPreferences(next);
      return next;
    });
  }, [syncLegacyPreferences]);

  const effectiveRailWidth = openViewIds.includes(REPLAY_VIEW_IDS.paper)
    || openViewIds.includes(REPLAY_VIEW_IDS.account)
    ? Math.max(400, preferences.railWidth)
    : preferences.railWidth;

  const onViewHeightChange = useCallback((viewId: string, height: number) => {
    setViewHeights((current) => ({ ...current, [viewId]: height }));
    if (
      viewId === REPLAY_VIEW_IDS.paper
      || viewId === REPLAY_VIEW_IDS.account
      || viewId === REPLAY_VIEW_IDS.activity
      || viewId === REPLAY_VIEW_IDS.capabilities
    ) {
      actions.setDockHeight(height);
    }
  }, [actions]);

  const closeView = useCallback((viewId: string) => {
    if (openViewIds.includes(viewId)) onToggleView(viewId);
  }, [onToggleView, openViewIds]);

  const renderView = useCallback((viewId: string, height: number) => {
    if (viewId === REPLAY_VIEW_IDS.watchlist) {
      return (
        <ReplayWatchlistPanel
          runtime={runtime}
          viewer={viewer}
          collapsed={false}
          onCollapsedChange={(collapsed) => {
            if (collapsed) closeView(REPLAY_VIEW_IDS.watchlist);
            else if (!openViewIds.includes(REPLAY_VIEW_IDS.watchlist)) {
              onToggleView(REPLAY_VIEW_IDS.watchlist);
            }
          }}
        />
      );
    }

    const title =
      viewId === REPLAY_VIEW_IDS.paper ? "下单"
        : viewId === REPLAY_VIEW_IDS.account ? "仓位"
          : viewId === REPLAY_VIEW_IDS.activity ? "市场"
            : viewId === REPLAY_VIEW_IDS.capabilities ? "能力"
              : viewId;
    const dockAttr =
      viewId === REPLAY_VIEW_IDS.paper ? "paper"
        : viewId === REPLAY_VIEW_IDS.account ? "account"
          : viewId === REPLAY_VIEW_IDS.activity ? "activity"
            : "capabilities";

    return (
      <section
        className="replay-market-dock"
        style={{ height }}
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
          {viewId === REPLAY_VIEW_IDS.capabilities && (
            <ReplayCapabilitySurface capabilities={capabilities} />
          )}
          {viewId === REPLAY_VIEW_IDS.paper && (
            <ReplayPaperTradingDock
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
          {viewId === REPLAY_VIEW_IDS.account && (
            <ReplayTradingWorkbench
              runtime={runtime}
              viewer={viewer}
              indicatorStatus={indicators.status}
              formatTime={formatTime}
            />
          )}
          {viewId === REPLAY_VIEW_IDS.activity && (
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
    openViewIds,
    runtime,
    viewer,
  ]);

  return (
    <MarketRightRailFrame
      source="replay"
      ariaLabel="回放自选与市场侧栏"
      views={views}
      openViewIds={openViewIds}
      onToggleView={onToggleView}
      renderView={renderView}
      layout={{
        width: effectiveRailWidth,
        onWidthChange: actions.setRailWidth,
      }}
      viewHeights={viewHeights}
      onViewHeightChange={onViewHeightChange}
      upColor={upColor}
      downColor={downColor}
    />
  );
}

export default React.memo(ReplayRightMarketRail);
