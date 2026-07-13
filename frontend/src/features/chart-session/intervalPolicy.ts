import { parseIntervalSeconds } from "../../utils/intervals.js";
import type {
  CustomIntervalRecord,
  ExchangeConfig,
  ExchangeId,
  IntervalString,
  NativeInterval,
  NativeIntervalSupport,
} from "./chartSessionTypes.js";

export function getExchangeMarketTypes(exchangeConfig: ExchangeConfig): string[] {
  return exchangeConfig.markets
    .map((market) => market.market_type)
    .filter((marketType): marketType is string => Boolean(marketType));
}

export function getFallbackNativeInterval(
  nativeIntervals: readonly NativeInterval[],
  preferredInterval: IntervalString = "1h",
): IntervalString {
  return nativeIntervals.find((item) => item.value === preferredInterval)?.value
    || nativeIntervals[0]?.value
    || preferredInterval;
}

export interface ResolveSupportedIntervalOptions {
  exchange: ExchangeId;
  interval: IntervalString;
  exchangeCatalog: unknown;
  savedCustomIntervals: readonly IntervalString[];
  nativeIntervals: readonly NativeInterval[];
  isNativeIntervalSupported: NativeIntervalSupport;
}

export function resolveSupportedInterval({
  exchange,
  interval,
  exchangeCatalog,
  savedCustomIntervals,
  nativeIntervals,
  isNativeIntervalSupported,
}: ResolveSupportedIntervalOptions): IntervalString {
  if (savedCustomIntervals.includes(interval)) return interval;
  if (isNativeIntervalSupported(exchange, interval, exchangeCatalog)) return interval;
  return getFallbackNativeInterval(nativeIntervals, "1h");
}

export interface CustomIntervalRemoveFallbackOptions {
  removedInterval: IntervalString;
  customIntervalRecords: readonly CustomIntervalRecord[];
  nativeIntervals: readonly NativeInterval[];
  exchange: ExchangeId;
  isNativeIntervalSupported: NativeIntervalSupport;
}

export function getFallbackIntervalAfterCustomRemove({
  removedInterval,
  customIntervalRecords,
  nativeIntervals,
  exchange,
  isNativeIntervalSupported,
}: CustomIntervalRemoveFallbackOptions): IntervalString {
  const recentCustom = customIntervalRecords
    .filter((record) => record.value !== removedInterval)
    .sort((left, right) => (right.lastUsedAt || 0) - (left.lastUsedAt || 0))[0];
  if (recentCustom) return recentCustom.value;

  const removedSeconds = parseIntervalSeconds(removedInterval);
  if (!removedSeconds) {
    return isNativeIntervalSupported(exchange, "1h") ? "1h" : nativeIntervals[0]?.value || "1m";
  }

  return [...nativeIntervals]
    .filter((item) => item.value !== removedInterval)
    .sort((left, right) => Math.abs(left.seconds - removedSeconds) - Math.abs(right.seconds - removedSeconds))[0]?.value
    || "1h";
}

export interface CustomIntervalClearFallbackOptions {
  interval: IntervalString;
  nativeIntervals: readonly NativeInterval[];
}

export function getFallbackIntervalAfterCustomClear({
  interval,
  nativeIntervals,
}: CustomIntervalClearFallbackOptions): IntervalString {
  const currentSeconds = parseIntervalSeconds(interval);
  if (!currentSeconds) return "1h";
  return [...nativeIntervals]
    .sort((left, right) => Math.abs(left.seconds - currentSeconds) - Math.abs(right.seconds - currentSeconds))[0]?.value
    || "1h";
}
