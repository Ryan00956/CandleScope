import type { IntervalString } from "../../utils/intervals.js";
import type {
  ExchangeId,
  MarketType,
  SymbolCode,
  SymbolIdentity,
} from "../../utils/symbolKey.js";

export type DatasetKey = string;
export type ChartSessionKey = string;

export interface ChartSession extends SymbolIdentity {
  interval: IntervalString;
}

export type ChartSessionTransitionType =
  | "symbol-change"
  | "interval-change"
  | "market-type-change"
  | "capability-correction";

export interface ChartSessionTransition {
  id: number;
  type: ChartSessionTransitionType;
  from: ChartSession;
  to: ChartSession;
  fromSessionKey: ChartSessionKey;
  sessionKey: ChartSessionKey;
  createdAt: number;
}

export interface UserPrefs extends Record<string, unknown> {
  lastSymbol?: unknown;
  lastExchange?: unknown;
  lastMarketType?: unknown;
  lastInterval?: unknown;
}

export interface NativeInterval {
  value: IntervalString;
  seconds: number;
  label?: string;
}

export interface CustomIntervalRecord {
  value: IntervalString;
  lastUsedAt?: number;
}

export interface ExchangeMarketConfig {
  market_type?: string | null;
}

export interface ExchangeConfig {
  markets: readonly ExchangeMarketConfig[];
}

export type NativeIntervalSupport = (
  exchange: ExchangeId,
  interval: IntervalString,
  exchangeCatalog?: unknown,
) => boolean;

export interface VisibleRangeSnapshot {
  barSpacing?: number;
  rightOffset?: number;
  rightmostTime?: number;
  savedAt?: number;
}

export interface AnchorVisibleRangeRestore {
  mode: "anchor";
  barSpacing: number | null;
  rightOffset: number | null;
  rightmostTime: number | null;
}

export interface FitVisibleRangeRestore {
  mode: "fit";
  timeRange: null;
  logicalRange: null;
  barSpacing: null;
  rightOffset: null;
  rightmostTime: null;
}

export type VisibleRangeRestorePlan = AnchorVisibleRangeRestore | FitVisibleRangeRestore;
export type PaneHeights = Record<string, number[]>;

export type { ExchangeId, IntervalString, MarketType, SymbolCode };
