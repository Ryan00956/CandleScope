import type { IntervalString } from "../../utils/intervals.js";
import type {
  ExchangeId,
  MarketType,
  SymbolCode,
} from "../../utils/symbolKey.js";

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
