import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type {
  MarketMetricChannel,
  MarketMetricId,
} from "./marketMetricSelectionTypes.js";
import type { LiquidationRuntimeView } from "../liquidations/liquidationTypes.js";

export const ADVANCED_MARKET_CHANNELS = [
  "mark_price",
  "index_price",
  "funding_rate",
  "open_interest",
  "basis",
] as const;

export type AdvancedMarketChannel = (typeof ADVANCED_MARKET_CHANNELS)[number];
export const FUNDING_RATE_PROVENANCE = [
  "exchange_settlement",
  "derived_history",
  "exchange_realtime",
] as const;
export type FundingRateProvenance = (typeof FUNDING_RATE_PROVENANCE)[number];
export const FUNDING_RATE_QUALITY = [
  "final",
  "estimated",
  "live",
  "carried",
  "stale",
] as const;
export type FundingRateQuality = (typeof FUNDING_RATE_QUALITY)[number];

export interface FundingRateData extends Record<string, unknown> {
  funding_rate: number;
  provenance?: FundingRateProvenance;
  quality?: FundingRateQuality;
  is_final?: boolean;
  sample_kind?: "settlement" | "estimate" | "preview" | string;
  funding_time_ms?: number;
  raw_funding_time_ms?: number;
  sample_time_ms?: number;
  target_funding_time_ms?: number;
  next_funding_time_ms?: number;
  funding_cycle_ms?: number;
  observed_at_ms?: number;
  carried?: boolean;
  stale?: boolean;
  formula_version?: string;
  input_resolution?: string;
  input_coverage?: number;
}

export const DEFAULT_OPEN_INTEREST_PERIOD = "5m";
export type AdvancedMarketConnectionStatus =
  | "disabled"
  | "connecting"
  | "live"
  | "reconnecting"
  | "disconnected";

export interface AdvancedMarketIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
}

export interface MarketStreamKeyPayload {
  exchange: string;
  market_type: string;
  symbol: string;
  channel: AdvancedMarketChannel;
  params: Record<string, unknown>;
}

export interface MarketStateRecord {
  key: MarketStreamKeyPayload;
  topic: string;
  channel: AdvancedMarketChannel;
  event_time_ms: number;
  received_at_ms: number;
  source: string;
  sequence: number | null;
  revision: number;
  data: Record<string, unknown>;
}

export interface MarketSnapshotPayload {
  type: "market.snapshot";
  as_of_ms: number;
  data: MarketStateRecord[];
  missing: MarketStreamKeyPayload[];
}

export interface MarketHistoryCoverage {
  earliest_ms: number | null;
  latest_ms: number | null;
  complete: boolean;
}

export type MarketHistoryState = "ready" | "pending" | "exhausted";

export interface MarketHistoryExcludedRange {
  start_ms: number;
  end_ms: number;
  reason?: string;
}

export interface MarketHistoryPayload {
  type: "market.history";
  key: MarketStreamKeyPayload;
  count: number;
  data: MarketStateRecord[];
  coverage: MarketHistoryCoverage;
  fallback?: boolean;
  has_more?: boolean;
  next_start_ms?: number | null;
  next_end_ms?: number | null;
  history_state?: MarketHistoryState;
  complete?: boolean;
  retryable?: boolean;
  terminal_reason?: string | null;
  earliest_available_ms?: number | null;
  next_before_ms?: number | null;
  availability_revision?: string | null;
  excluded_ranges?: MarketHistoryExcludedRange[];
}

export type MarketSocketMessage =
  | { type: "connected"; protocol?: string; max_subscriptions?: number }
  | { type: "subscribed" | "unsubscribed"; request_id?: string; streams: MarketStreamKeyPayload[] }
  | { type: "snapshot"; request_id?: string; data: MarketStateRecord[]; missing: MarketStreamKeyPayload[] }
  | { type: "update"; protocol?: string; data: MarketStateRecord[] }
  | { type: "error"; request_id?: string; code?: string; detail?: string };

export interface AdvancedMarketSummarySnapshot {
  markPrice: number | null;
  indexPrice: number | null;
  basis: number | null;
  basisRate: number | null;
  basisBps: number | null;
  receivedAtMs: number | null;
  connectionStatus: AdvancedMarketConnectionStatus;
}

export interface AdvancedMarketMetricsSnapshot {
  fundingHistory: readonly MarketStateRecord[];
  fundingRealtimeHistory: readonly MarketStateRecord[];
  fundingPreview: MarketStateRecord | null;
  openInterestHistory: readonly MarketStateRecord[];
  openInterestPeriod: string;
  connectionStatus: AdvancedMarketConnectionStatus;
  revision: number;
}

export type AdvancedMarketStudyStatus =
  | "available"
  | "loading"
  | "active"
  | "hidden"
  | "unavailable"
  | "error";

export interface AdvancedMarketMetricCapability {
  supported: boolean;
  reason: string | null;
}

export interface AdvancedMarketStudyView {
  id: MarketMetricId;
  channel: MarketMetricChannel;
  name: string;
  description: string;
  category: "contract-data";
  paneTarget: "sub";
  added: boolean;
  visible: boolean;
  supported: boolean;
  supportReason: string | null;
  status: AdvancedMarketStudyStatus;
  error: string | null;
}

export interface AdvancedMarketRuntimeView {
  enabled: boolean;
  summaryEnabled: boolean;
  metricsEnabled: boolean;
  identity: AdvancedMarketIdentity;
  identityKey: string;
  interval: string;
  seriesKey: string;
  seriesStore: SeriesWindowStore | null;
  marketStudies: readonly AdvancedMarketStudyView[];
  metricCapabilities: Record<MarketMetricChannel, AdvancedMarketMetricCapability>;
  stateMetricsEnabled: boolean;
  liquidations: LiquidationRuntimeView;
}

export interface AdvancedMarketRuntime {
  view: AdvancedMarketRuntimeView;
  actions: {
    ensureVisibleRange(range: unknown): boolean;
    retry(): void;
    addMarketStudy(id: MarketMetricId): void;
    removeMarketStudy(id: MarketMetricId): void;
    toggleMarketStudyVisibility(id: MarketMetricId): void;
  };
  status: {
    enabled: boolean;
    connectionStatus: AdvancedMarketConnectionStatus;
  };
}

export interface AdvancedMarketPaneSnapshot {
  panes: IndicatorSubPane[];
  revision: number;
}

export function buildAdvancedMarketIdentityKey(identity: AdvancedMarketIdentity): string {
  return [
    String(identity.exchange || "").trim().toLowerCase(),
    String(identity.marketType || "").trim().toLowerCase(),
    String(identity.symbol || "").trim().toUpperCase(),
  ].join(":");
}

export function normalizeAdvancedMarketIdentity(
  identity: AdvancedMarketIdentity,
): AdvancedMarketIdentity {
  return {
    exchange: String(identity.exchange || "").trim().toLowerCase(),
    marketType: String(identity.marketType || "").trim().toLowerCase(),
    symbol: String(identity.symbol || "").trim().toUpperCase(),
  };
}
