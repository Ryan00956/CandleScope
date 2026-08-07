import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import OrderBookDock from "../features/order-book/OrderBookDock.js";
import type { OrderBookRuntime } from "../features/order-book/orderBookTypes.js";
import TradeFlowDock from "../features/trade-flow/TradeFlowDock.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";
import WatchlistSidebar from "../features/watchlist/WatchlistSidebar.js";
import type { WatchlistSidebarProps } from "../features/watchlist/WatchlistSidebar.js";
import { DEFAULT_WATCHLIST_WIDTH } from "../features/watchlist/watchlistStore.js";
import {
  LIVE_RAIL_VIEW_IDS,
  MARKET_DOCK_DEFAULT_HEIGHT,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
  MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
} from "../shared/marketRailLayout.js";
import {
  listContributedMarketRailViews,
  mergeMarketRailViews,
  subscribeMarketRailRegistry,
} from "./marketRailRegistry.js";
import {
  OrderBookRailIcon,
  ProfileRailIcon,
  TapeRailIcon,
  WatchlistRailIcon,
} from "./marketRailIcons.js";
import type { MarketRailViewDescriptor } from "./marketRailTypes.js";
import MarketRightRailFrame from "./MarketRightRailFrame.js";

export interface RightMarketRailProps {
  watchlist: WatchlistSidebarProps;
  orderBook: OrderBookRuntime;
  tradeFlow: TradeFlowRuntime;
  openViewIds: readonly string[];
  panelCollapsed?: boolean;
  onToggleView: (viewId: string) => void;
  /** Close one dock's content (distinct from hiding the whole panel). */
  onCloseView?: (viewId: string) => void;
  onTogglePanelCollapsed?: () => void;
  viewHeights: Readonly<Record<string, number>>;
  onViewHeightChange: (viewId: string, height: number) => void;
  /** Optional plugin/extra view renderers keyed by view id. */
  renderExtraView?: (viewId: string, height: number) => React.ReactNode;
}

const BUILT_IN_VIEWS: MarketRailViewDescriptor[] = [
  {
    id: LIVE_RAIL_VIEW_IDS.watchlist,
    title: "自选",
    icon: <WatchlistRailIcon />,
    order: 10,
    sizing: "flex",
    minHeight: MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
  },
  {
    id: LIVE_RAIL_VIEW_IDS.orderBook,
    title: "盘口",
    icon: <OrderBookRailIcon />,
    order: 20,
    sizing: "fixed",
    defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
    minHeight: MARKET_DOCK_MIN_HEIGHT,
    maxHeight: MARKET_DOCK_MAX_HEIGHT,
  },
  {
    id: LIVE_RAIL_VIEW_IDS.tape,
    title: "成交",
    icon: <TapeRailIcon />,
    order: 30,
    sizing: "fixed",
    defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
    minHeight: MARKET_DOCK_MIN_HEIGHT,
    maxHeight: MARKET_DOCK_MAX_HEIGHT,
  },
  {
    id: LIVE_RAIL_VIEW_IDS.profile,
    title: "分布",
    icon: <ProfileRailIcon />,
    order: 40,
    sizing: "fixed",
    defaultHeight: MARKET_DOCK_DEFAULT_HEIGHT,
    minHeight: MARKET_DOCK_MIN_HEIGHT,
    maxHeight: MARKET_DOCK_MAX_HEIGHT,
  },
];

function RightMarketRail({
  watchlist,
  orderBook,
  tradeFlow,
  openViewIds,
  panelCollapsed = false,
  onToggleView,
  onCloseView,
  onTogglePanelCollapsed,
  viewHeights,
  onViewHeightChange,
  renderExtraView,
}: RightMarketRailProps) {
  const contributed = useSyncExternalStore(
    subscribeMarketRailRegistry,
    listContributedMarketRailViews,
    listContributedMarketRailViews,
  );
  const views = useMemo(
    () => mergeMarketRailViews(BUILT_IN_VIEWS, contributed),
    [contributed],
  );

  const closeView = useCallback((viewId: string) => {
    if (onCloseView) {
      onCloseView(viewId);
      return;
    }
    // Fallback for callers that only wire toggle: never expand-from-collapse via X.
    if (openViewIds.includes(viewId) && !panelCollapsed) onToggleView(viewId);
  }, [onCloseView, onToggleView, openViewIds, panelCollapsed]);

  const renderView = useCallback((viewId: string, height: number) => {
    if (viewId === LIVE_RAIL_VIEW_IDS.watchlist) {
      return (
        <WatchlistSidebar
          {...watchlist}
          onRequestClose={() => closeView(LIVE_RAIL_VIEW_IDS.watchlist)}
        />
      );
    }
    if (viewId === LIVE_RAIL_VIEW_IDS.orderBook) {
      return (
        <OrderBookDock
          runtime={orderBook}
          height={height}
          onRequestClose={() => closeView(LIVE_RAIL_VIEW_IDS.orderBook)}
        />
      );
    }
    if (viewId === LIVE_RAIL_VIEW_IDS.tape) {
      return (
        <TradeFlowDock
          runtime={tradeFlow}
          height={height}
          mode="tape"
          onRequestClose={() => closeView(LIVE_RAIL_VIEW_IDS.tape)}
        />
      );
    }
    if (viewId === LIVE_RAIL_VIEW_IDS.profile) {
      return (
        <TradeFlowDock
          runtime={tradeFlow}
          height={height}
          mode="profile"
          onRequestClose={() => closeView(LIVE_RAIL_VIEW_IDS.profile)}
        />
      );
    }
    return renderExtraView?.(viewId, height) ?? null;
  }, [closeView, orderBook, renderExtraView, tradeFlow, watchlist]);

  return (
    <MarketRightRailFrame
      source="live"
      views={views}
      openViewIds={openViewIds}
      panelCollapsed={panelCollapsed}
      onToggleView={onToggleView}
      {...(onTogglePanelCollapsed === undefined
        ? {}
        : { onTogglePanelCollapsed })}
      renderView={renderView}
      layout={{
        width: watchlist.layout?.width ?? DEFAULT_WATCHLIST_WIDTH,
        ...(watchlist.actions?.setWidth === undefined
          ? {}
          : { onWidthChange: watchlist.actions.setWidth }),
      }}
      viewHeights={viewHeights}
      onViewHeightChange={onViewHeightChange}
      {...(watchlist.upColor === undefined ? {} : { upColor: watchlist.upColor })}
      {...(watchlist.downColor === undefined ? {} : { downColor: watchlist.downColor })}
    />
  );
}

export default React.memo(RightMarketRail);
