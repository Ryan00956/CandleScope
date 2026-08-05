/** Source-neutral geometry shared by live and replay right-rail adapters. */
export const MARKET_RAIL_DEFAULT_WIDTH = 320;
export const MARKET_RAIL_MIN_WIDTH = 260;
export const MARKET_RAIL_MAX_WIDTH = 520;

/** Fixed outer activity-bar strip (VS Code style). */
export const MARKET_ACTIVITY_BAR_WIDTH = 44;

export const MARKET_DOCK_DEFAULT_HEIGHT = 360;
export const MARKET_DOCK_MIN_HEIGHT = 220;
export const MARKET_DOCK_MAX_HEIGHT = 640;
export const MARKET_DOCK_COLLAPSED_HEIGHT = 36;
export const MARKET_RAIL_MIN_SIDEBAR_HEIGHT = 180;
export const MARKET_RAIL_SPLITTER_HEIGHT = 5;
export const MARKET_RAIL_VIEW_MIN_FLEX_HEIGHT = 120;

/** Built-in live rail view ids. Plugins may register additional ids. */
export const LIVE_RAIL_VIEW_IDS = {
  watchlist: "watchlist",
  orderBook: "order-book",
  tape: "tape",
  profile: "profile",
} as const;

export type LiveRailViewId = (typeof LIVE_RAIL_VIEW_IDS)[keyof typeof LIVE_RAIL_VIEW_IDS];

export const DEFAULT_LIVE_OPEN_VIEW_IDS: readonly string[] = [
  LIVE_RAIL_VIEW_IDS.watchlist,
  LIVE_RAIL_VIEW_IDS.orderBook,
];
