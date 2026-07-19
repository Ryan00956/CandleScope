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
  enabled: boolean;
  dockView: TradeFlowDockView;
  sideFilter: TradeFlowSideFilter;
  minNotional: number;
  largeTradeNotional: number;
}

export interface TradeFlowPreferenceActions {
  setEnabled(enabled: boolean): void;
  toggleEnabled(): void;
  setDockView(view: TradeFlowDockView): void;
  setSideFilter(side: TradeFlowSideFilter): void;
  setMinNotional(value: number): void;
  setLargeTradeNotional(value: number): void;
}

export interface TradeFlowRuntime {
  view: {
    identity: TradeFlowIdentity;
    supported: boolean;
    supportMessage: string | null;
    preferences: TradeFlowPreferences;
    store: TradeFlowExternalStore;
    markerSource: ExternalMarkerSource | null;
  };
  actions: TradeFlowPreferenceActions & { retry(): void };
  status: { enabled: boolean };
}
