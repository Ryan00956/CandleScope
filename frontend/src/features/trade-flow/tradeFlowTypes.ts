import type { ExternalMarkerSource } from "../../chart-adapter/externalMarkerSource.js";

export type TradeFlowConnectionStatus =
  | "idle"
  | "unsupported"
  | "connecting"
  | "reconnecting"
  | "live"
  | "gap"
  | "error";

export type TradeFlowSide = "buy" | "sell";
export type TradeFlowSideFilter = "all" | TradeFlowSide;
export type TradeFlowDockView = "order-book" | "tape" | "profile";
export type TradeFlowIndicatorId = "trade-flow:cvd" | "trade-flow:delta";
export type TradeFlowIndicatorKey = "cvd" | "delta";

export const TRADE_FLOW_INDICATOR_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "trade-flow:cvd" as const,
    key: "cvd" as const,
    category: "volume" as const,
    name: "CVD（累计成交量差）",
    description: "基于 K 线主动买卖量构建的连续前缀和；与右侧实时订单流独立。",
  }),
  Object.freeze({
    id: "trade-flow:delta" as const,
    key: "delta" as const,
    category: "volume" as const,
    name: "Volume Delta（成交量差）",
    description: "逐根 K 线展示主动买量、主动卖量及其差值；与右侧实时订单流独立。",
  }),
]);

export function isTradeFlowIndicatorId(value: unknown): value is TradeFlowIndicatorId {
  return TRADE_FLOW_INDICATOR_DEFINITIONS.some((definition) => definition.id === value);
}

export function tradeFlowIndicatorKey(id: TradeFlowIndicatorId): TradeFlowIndicatorKey {
  return id === "trade-flow:cvd" ? "cvd" : "delta";
}

export interface TradeFlowIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
}

export interface AggregateTrade {
  exchange: string;
  marketType: string;
  symbol: string;
  aggTradeId: number;
  price: number;
  quantity: number;
  quoteQuantity: number;
  tradeTimeMs: number;
  eventTimeMs: number;
  receivedAtMs: number;
  isBuyerMaker: boolean;
  aggressorSide: TradeFlowSide;
  source: string;
  firstTradeId: number | null;
  lastTradeId: number | null;
}

export interface TradeFlowAggregateStats {
  buyQuote: number;
  sellQuote: number;
  buyBase: number;
  sellBase: number;
  buyCount: number;
  sellCount: number;
  maxTradeNotional: number;
}

export interface TradeFlowStoreSnapshot {
  status: TradeFlowConnectionStatus;
  records: readonly AggregateTrade[];
  stats: TradeFlowAggregateStats;
  continuity: boolean;
  message: string | null;
  error: string | null;
  version: number;
}

export interface TradeFlowExternalStore {
  getSnapshot(): TradeFlowStoreSnapshot;
  getServerSnapshot(): TradeFlowStoreSnapshot;
  subscribe(listener: () => void): () => void;
  replaceRecent(records: readonly AggregateTrade[]): boolean;
  appendBatch(records: readonly AggregateTrade[]): boolean;
  publishStatus(
    status: Exclude<TradeFlowConnectionStatus, "live">,
    options?: { message?: string | null; error?: string | null; clearRecords?: boolean },
  ): void;
  markGap(message: string): void;
  reset(status?: "idle" | "unsupported", message?: string | null): void;
  destroy(): void;
}

export interface TradeFlowPreferences {
  dockView: TradeFlowDockView;
  indicators: Record<TradeFlowIndicatorKey, {
    added: boolean;
    visible: boolean;
  }>;
  sideFilter: TradeFlowSideFilter;
  minNotional: number;
  largeTradeNotional: number;
}

export interface TradeFlowPreferenceActions {
  setDockView(view: TradeFlowDockView): void;
  addIndicator(id: TradeFlowIndicatorId): void;
  removeIndicator(id: TradeFlowIndicatorId): void;
  toggleIndicatorVisibility(id: TradeFlowIndicatorId): void;
  setSideFilter(side: TradeFlowSideFilter): void;
  setMinNotional(value: number): void;
  setLargeTradeNotional(value: number): void;
}

export interface TradeFlowRuntime {
  view: {
    identity: TradeFlowIdentity;
    interval: string;
    supported: boolean;
    supportMessage: string | null;
    preferences: TradeFlowPreferences;
    store: TradeFlowExternalStore;
    markerSource: ExternalMarkerSource | null;
  };
  actions: TradeFlowPreferenceActions & { retry(): void };
  status: { enabled: boolean };
}
