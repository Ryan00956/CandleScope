import type { ExternalMarkerSource } from "../../chart-adapter/externalMarkerSource.js";
import {
  isKlineOrderFlowIndicatorId,
  KLINE_ORDER_FLOW_INDICATOR_DEFINITIONS,
  klineOrderFlowIndicatorKey,
} from "../indicators/klineOrderFlowStudy.js";
import type {
  KlineOrderFlowIndicatorId,
  KlineOrderFlowIndicatorKey,
} from "../indicators/klineOrderFlowStudy.js";

export type TradeFlowConnectionStatus =
  | "idle"
  | "unsupported"
  | "connecting"
  | "reconnecting"
  | "live"
  | "gap"
  | "error";

export type TradeFlowSide = "buy" | "sell";
export type TradeFlowContinuityMode = "strict_repairable" | "observational";
export type TradeFlowDeliveryMode = "live_stream" | "polling_observational" | null;
export type TradeFlowSideFilter = "all" | TradeFlowSide;
export type TradeFlowDockView = "order-book" | "tape" | "profile";
export type TradeFlowIndicatorId = KlineOrderFlowIndicatorId;
export type TradeFlowIndicatorKey = KlineOrderFlowIndicatorKey;

export const TRADE_FLOW_INDICATOR_DEFINITIONS =
  KLINE_ORDER_FLOW_INDICATOR_DEFINITIONS;

export function isTradeFlowIndicatorId(value: unknown): value is TradeFlowIndicatorId {
  return isKlineOrderFlowIndicatorId(value);
}

export function tradeFlowIndicatorKey(id: TradeFlowIndicatorId): TradeFlowIndicatorKey {
  return klineOrderFlowIndicatorKey(id);
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
  tradeId: string | null;
  continuityMode: TradeFlowContinuityMode;
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
  continuityMode: TradeFlowContinuityMode;
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
    continuityMode: TradeFlowContinuityMode;
    deliveryMode: TradeFlowDeliveryMode;
    preferences: TradeFlowPreferences;
    store: TradeFlowExternalStore;
    markerSource: ExternalMarkerSource | null;
  };
  actions: TradeFlowPreferenceActions & { retry(): void };
  status: { enabled: boolean };
}
