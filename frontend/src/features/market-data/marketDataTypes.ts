import type { IntervalString } from "../../utils/intervals.js";
import type {
  ExchangeId,
  MarketType,
  SymbolCode,
} from "../../utils/symbolKey.js";
import type { SeriesDataFeed } from "./feed/seriesDataFeed.js";
import type {
  ChartSessionKey,
  ChartSessionTransition,
} from "../chart-session/chartSessionTypes.js";

declare const epochSecondsBrand: unique symbol;
declare const epochMillisecondsBrand: unique symbol;
declare const seriesKeyBrand: unique symbol;
declare const dataRevisionBrand: unique symbol;

export type EpochSeconds = number & { readonly [epochSecondsBrand]: true };
export type EpochMilliseconds = number & { readonly [epochMillisecondsBrand]: true };
export type SeriesKey = string & { readonly [seriesKeyBrand]: true };
export type DataRevision = number & { readonly [dataRevisionBrand]: true };

export interface TimeRangeSec {
  start: EpochSeconds;
  end: EpochSeconds;
}

export interface TimeRangeMs {
  start: EpochMilliseconds;
  end: EpochMilliseconds;
}

export interface MarketSeries {
  exchange: ExchangeId;
  marketType: MarketType;
  symbol: SymbolCode;
  interval: IntervalString;
}

export interface KlineBar extends Record<string, unknown> {
  time: EpochSeconds;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  is_closed?: boolean;
  quote_volume?: number | null;
  trades?: number | null;
  taker_buy_base?: number | null;
  taker_buy_quote?: number | null;
  order_flow?: KlineOrderFlow | null;
}

export interface KlineOrderFlow extends Record<string, unknown> {
  taker_sell_base: number;
  volume_delta_base: number;
  taker_buy_ratio_base: number | null;
  cvd_contribution_base: number;
}

export interface KlineBarInput extends Record<string, unknown> {
  time?: unknown;
}

export interface SeriesGap {
  from: EpochSeconds;
  to: EpochSeconds;
  missingBars: number | null;
}

export interface SeriesCoverage {
  firstTime: EpochSeconds | null;
  lastTime: EpochSeconds | null;
  bars: number;
  gaps: SeriesGap[];
}

export interface SeriesDescription {
  seriesKey: SeriesKey | null;
  bars: number;
  firstTime: EpochSeconds | null;
  lastTime: EpochSeconds | null;
  coverage: SeriesCoverage;
  version: DataRevision;
}

export interface SeriesWindowSegment {
  bars: KlineBar[];
}

export interface SeriesWindowIndexRef {
  segmentIndex: number;
  rowIndex: number;
}

export interface MarketCacheIdentity {
  marketType: MarketType;
  exchange: ExchangeId;
}

export type HasMarketCache = (
  symbol: SymbolCode,
  interval: IntervalString,
  identity: MarketCacheIdentity,
) => boolean;

export interface UseChartBackgroundPrefetchOptions
  extends Pick<MarketSeries, "exchange" | "marketType" | "symbol"> {
  activeInterval: IntervalString;
  trackedIntervals: readonly IntervalString[];
  nativeIntervals: readonly IntervalString[];
  hasCache: HasMarketCache;
  seriesDataFeed: SeriesDataFeed;
  enabled?: boolean;
}

export interface UseSessionTransitionResetOptions {
  clearCache(): void;
  interval: IntervalString;
  markChartDataTransition(
    symbol: SymbolCode,
    interval: IntervalString,
    reason: string,
  ): void;
  realtimePriceRef?: { current: number | null } | null;
  sessionKey: ChartSessionKey;
  setCrosshairData(value: null): void;
  setError(value: null): void;
  setHasMoreLeft(value: boolean): void;
  setLastPrice(value: null): void;
  setLoading(value: boolean): void;
  symbol: SymbolCode;
}

export type SessionTransitionReset = (
  transition: ChartSessionTransition | null | undefined,
) => void;

export function toEpochSeconds(value: unknown): EpochSeconds | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed as EpochSeconds) : null;
}

export function toEpochMilliseconds(value: unknown): EpochMilliseconds | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed as EpochMilliseconds) : null;
}

export function secondsToMilliseconds(value: EpochSeconds): EpochMilliseconds {
  return (value * 1000) as EpochMilliseconds;
}

export function millisecondsToSeconds(value: EpochMilliseconds): EpochSeconds {
  return (value / 1000) as EpochSeconds;
}

export function asSeriesKey(value: string): SeriesKey {
  return value as SeriesKey;
}

export function asDataRevision(value: number): DataRevision {
  return value as DataRevision;
}
