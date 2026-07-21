import React, { useCallback } from "react";
import OrderBookDock from "../features/order-book/OrderBookDock.js";
import type { OrderBookRuntime } from "../features/order-book/orderBookTypes.js";
import TradeFlowDock from "../features/trade-flow/TradeFlowDock.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";
import WatchlistSidebar from "../features/watchlist/WatchlistSidebar.js";
import type { WatchlistSidebarProps } from "../features/watchlist/WatchlistSidebar.js";
import { DEFAULT_WATCHLIST_WIDTH } from "../features/watchlist/watchlistStore.js";
import MarketRightRailFrame from "./MarketRightRailFrame.js";


export interface RightMarketRailProps {
  watchlist: WatchlistSidebarProps;
  orderBook: OrderBookRuntime;
  tradeFlow: TradeFlowRuntime;
}

function RightMarketRail({ watchlist, orderBook, tradeFlow }: RightMarketRailProps) {
  const renderDock = useCallback((height: number) => (
    tradeFlow.view.preferences.dockView === "order-book" ? (
      <OrderBookDock
        runtime={orderBook}
        height={height}
        onOpenTradeFlow={() => tradeFlow.actions.setDockView("tape")}
      />
    ) : (
      <TradeFlowDock
        runtime={tradeFlow}
        height={height}
        collapsed={orderBook.view.preferences.collapsed}
        onCollapsedChange={orderBook.actions.setCollapsed}
        onOpenOrderBook={() => tradeFlow.actions.setDockView("order-book")}
      />
    )
  ), [orderBook, tradeFlow]);

  return (
    <MarketRightRailFrame
      source="live"
      sidebar={<WatchlistSidebar {...watchlist} />}
      renderDock={renderDock}
      layout={{
        width: watchlist.layout?.width ?? DEFAULT_WATCHLIST_WIDTH,
        collapsed: watchlist.layout?.sidebarCollapsed ?? false,
        ...(watchlist.actions?.setWidth === undefined ? {} : { onWidthChange: watchlist.actions.setWidth }),
      }}
      dockLayout={{
        height: orderBook.view.preferences.height,
        collapsed: orderBook.view.preferences.collapsed,
        onHeightChange: orderBook.actions.setHeight,
      }}
      {...(watchlist.upColor === undefined ? {} : { upColor: watchlist.upColor })}
      {...(watchlist.downColor === undefined ? {} : { downColor: watchlist.downColor })}
    />
  );
}

export default React.memo(RightMarketRail);
