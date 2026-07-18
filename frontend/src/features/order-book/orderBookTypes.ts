export const PARTIAL_DEPTH_LEVELS = [5, 10, 20] as const;
export const UPDATE_INTERVALS_MS = [100, 250, 500] as const;
export const FULL_OUTPUT_LIMITS = [20, 50, 100] as const;
export const PARTIAL_PRICE_GROUPINGS = ["auto", "raw", "10"] as const;
export const FULL_PRICE_GROUPINGS = ["auto", "raw", "10", "100", "1000"] as const;

export type OrderBookMode = "partial" | "full";
export type PartialDepthLevel = (typeof PARTIAL_DEPTH_LEVELS)[number];
export type OrderBookUpdateIntervalMs = (typeof UPDATE_INTERVALS_MS)[number];
export type FullOutputLimit = (typeof FULL_OUTPUT_LIMITS)[number];
export type PriceGrouping = (typeof FULL_PRICE_GROUPINGS)[number];
export type OrderBookConnectionStatus =
  | "idle"
  | "unsupported"
  | "connecting"
  | "reconnecting"
  | "live"
  | "stale"
  | "error";

export interface OrderBookIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
}

export type OrderBookLevel = readonly [price: number, quantity: number];

export interface OrderBookBook {
  mode: OrderBookMode;
  identity: OrderBookIdentity;
  topic: string;
  eventTimeMs: number;
  receivedAtMs: number;
  source: string;
  sequence: number | null;
  revision: number;
  bids: readonly OrderBookLevel[];
  asks: readonly OrderBookLevel[];
  topBid: number | null;
  topAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  spreadBps: number | null;
  notionalImbalance: number | null;
  updateIntervalMs: number | null;
  depthLevels: number | null;
  outputLimit: number | null;
  bookBidLevels: number | null;
  bookAskLevels: number | null;
  priceTickSize: number | null;
  priceStep: number | null;
  priceGrouping: PriceGrouping;
  aggregationApplied: boolean;
  bucketBidLevels: number | null;
  bucketAskLevels: number | null;
}

export interface OrderBookStoreSnapshot {
  status: OrderBookConnectionStatus;
  book: OrderBookBook | null;
  message: string | null;
  error: string | null;
  version: number;
}

export interface OrderBookExternalStore {
  getSnapshot(): OrderBookStoreSnapshot;
  getServerSnapshot(): OrderBookStoreSnapshot;
  subscribe(listener: () => void): () => void;
  publishBook(book: OrderBookBook): void;
  publishStatus(
    status: Exclude<OrderBookConnectionStatus, "live">,
    options?: { message?: string | null; error?: string | null; clearBook?: boolean },
  ): void;
  reset(status?: "idle" | "unsupported", message?: string | null): void;
  destroy(): void;
}

export interface OrderBookPreferences {
  height: number;
  collapsed: boolean;
  mode: OrderBookMode;
  partialDepth: PartialDepthLevel;
  updateIntervalMs: OrderBookUpdateIntervalMs;
  fullOutputLimit: FullOutputLimit;
  partialPriceGrouping: PriceGrouping;
  fullPriceGrouping: PriceGrouping;
}

export interface OrderBookPreferenceActions {
  setHeight(height: number): void;
  setCollapsed(collapsed: boolean): void;
  setMode(mode: OrderBookMode): void;
  setPartialDepth(depth: PartialDepthLevel): void;
  setUpdateIntervalMs(interval: OrderBookUpdateIntervalMs): void;
  setFullOutputLimit(limit: FullOutputLimit): void;
  setPriceGrouping(mode: OrderBookMode, grouping: PriceGrouping): void;
}

export interface OrderBookRuntime {
  view: {
    identity: OrderBookIdentity;
    supported: boolean;
    supportMessage: string | null;
    preferences: OrderBookPreferences;
    store: OrderBookExternalStore;
  };
  actions: OrderBookPreferenceActions & {
    retry(): void;
  };
  status: {
    enabled: boolean;
  };
}
