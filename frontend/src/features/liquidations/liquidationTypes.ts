import type { AdvancedMarketConnectionStatus } from "../advanced-market-data/advancedMarketDataTypes.js";

export const LIQUIDATION_PROTOCOL = "liquidation.v1" as const;
export const LIQUIDATION_SOURCE_QUALITY = "sampled_best_effort" as const;
export const LIQUIDATION_SAMPLING_MODE = "latest_per_symbol_1000ms" as const;

export type LiquidationPositionSide = "long" | "short";

export interface LiquidationIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
}

export interface LiquidationStreamKey {
  exchange: string;
  market_type: string;
  symbol: string;
  channel: "liquidation";
  params: Record<string, string>;
}

export interface LiquidationQualityMetadata {
  sourceQuality: typeof LIQUIDATION_SOURCE_QUALITY;
  sourceExhaustive: false;
  samplingMode: typeof LIQUIDATION_SAMPLING_MODE;
  lossySnapshot: true;
  backfillable: false;
  exchangeUpdateIntervalMs: number;
}

export interface LiquidationEvent {
  exchange: string;
  marketType: string;
  symbol: string;
  orderSide: "BUY" | "SELL";
  positionSide: LiquidationPositionSide;
  filledQuantity: number;
  executedNotional: number;
  tradeTimeMs: number;
  eventTimeMs: number;
  receivedAtMs: number;
  source: string;
  fingerprint: string;
}

export interface LiquidationRollup {
  exchange: string;
  marketType: string;
  symbol: string;
  period: "1m";
  positionSide: LiquidationPositionSide;
  bucketStartMs: number;
  bucketEndMs: number;
  filledQuantity: number;
  filledNotional: number;
  eventCount: number;
  maxEventNotional: number;
  firstEventTimeMs: number;
  lastEventTimeMs: number;
  isFinal: boolean;
  revision: number;
  updatedAtMs: number;
}

export interface LiquidationHistoryPayload {
  type: "liquidation.history";
  protocol: typeof LIQUIDATION_PROTOCOL;
  key: LiquidationStreamKey;
  count: number;
  data: LiquidationRollup[];
  hasMore: boolean;
  coverage: {
    earliestMs: number | null;
    latestMs: number | null;
    allRowsFinal: boolean;
    observedOnly: true;
  };
  quality: LiquidationQualityMetadata;
}

export type LiquidationSocketMessage =
  | {
      type: "connected";
      protocol: typeof LIQUIDATION_PROTOCOL;
      quality: LiquidationQualityMetadata;
    }
  | {
      type: "subscribed" | "unsubscribed";
      protocol: typeof LIQUIDATION_PROTOCOL;
      requestId: string;
      streams: LiquidationStreamKey[];
      quality: LiquidationQualityMetadata | null;
    }
  | {
      type: "recent";
      protocol: typeof LIQUIDATION_PROTOCOL;
      requestId: string;
      data: LiquidationEvent[];
      quality: LiquidationQualityMetadata;
    }
  | {
      type: "liquidation.batch";
      protocol: typeof LIQUIDATION_PROTOCOL;
      sequence: number;
      deliveryContinuity: true;
      resyncRequired: false;
      droppedBefore: 0;
      data: LiquidationEvent[];
      quality: LiquidationQualityMetadata;
    }
  | {
      type: "resync_required";
      protocol: typeof LIQUIDATION_PROTOCOL;
      code: string;
      sequence: number | null;
      deliveryContinuity: false;
      resyncRequired: true;
      droppedBefore: number;
      quality: LiquidationQualityMetadata;
    }
  | {
      type: "error";
      requestId: string | null;
      code: string;
      detail: string;
    };

export interface LiquidationSnapshot {
  rollups: readonly LiquidationRollup[];
  liveEvents: readonly LiquidationEvent[];
  connectionStatus: AdvancedMarketConnectionStatus;
  quality: LiquidationQualityMetadata | null;
  revision: number;
}

export interface LiquidationRuntimeView {
  enabled: boolean;
  visible: boolean;
  identityKey: string;
  connectionStatus: AdvancedMarketConnectionStatus;
  error: string | null;
  historyError: string | null;
  quality: LiquidationQualityMetadata | null;
}

export interface LiquidationCapability {
  supported: boolean;
  reason: string | null;
}
