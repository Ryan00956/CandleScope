import {
  canonicalizeIntervalValue,
  intervalSemanticSignature,
  intervalsSemanticallyEquivalent,
  parseIntervalSeconds,
} from "../../utils/intervals.js";
import type {
  CustomIntervalRecord,
  ExchangeCatalog,
  ExchangeConfig,
  ExchangeId,
  IntervalString,
  MarketType,
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
  return nativeIntervals.find((item) => intervalsSemanticallyEquivalent(item.value, preferredInterval))?.value
    || nativeIntervals[0]?.value
    || preferredInterval;
}

export function getEffectiveCustomIntervalRecords(
  customIntervalRecords: readonly CustomIntervalRecord[],
  nativeIntervals: readonly NativeInterval[],
): CustomIntervalRecord[] {
  const nativeValues = new Set(nativeIntervals.map((item) => intervalSemanticSignature(item.value)));
  return customIntervalRecords.filter((record) => !nativeValues.has(intervalSemanticSignature(record.value)));
}

export interface ResolveSupportedIntervalOptions {
  exchange: ExchangeId;
  marketType?: MarketType;
  interval: IntervalString;
  exchangeCatalog: ExchangeCatalog | null;
  savedCustomIntervals: readonly IntervalString[];
  nativeIntervals: readonly NativeInterval[];
  isNativeIntervalSupported: NativeIntervalSupport;
}

export function resolveSupportedInterval({
  exchange,
  marketType,
  interval,
  exchangeCatalog,
  savedCustomIntervals,
  nativeIntervals,
  isNativeIntervalSupported,
}: ResolveSupportedIntervalOptions): IntervalString {
  const native = nativeIntervals.find((item) => intervalsSemanticallyEquivalent(item.value, interval));
  if (native) return native.value;
  if (isNativeIntervalSupported(exchange, interval, exchangeCatalog, marketType, "history")) {
    return canonicalizeIntervalValue(interval) || interval;
  }
  const custom = savedCustomIntervals.find((item) => intervalsSemanticallyEquivalent(item, interval));
  if (custom) return canonicalizeIntervalValue(custom) || custom;
  return getFallbackNativeInterval(nativeIntervals, "1h");
}

export interface CustomIntervalRemoveFallbackOptions {
  removedInterval: IntervalString;
  customIntervalRecords: readonly CustomIntervalRecord[];
  nativeIntervals: readonly NativeInterval[];
  exchange: ExchangeId;
  marketType?: MarketType;
  exchangeCatalog?: ExchangeCatalog | null;
  isNativeIntervalSupported: NativeIntervalSupport;
}

export function getFallbackIntervalAfterCustomRemove({
  removedInterval,
  customIntervalRecords,
  nativeIntervals,
  exchange,
  marketType,
  exchangeCatalog = null,
  isNativeIntervalSupported,
}: CustomIntervalRemoveFallbackOptions): IntervalString {
  const nativeEquivalent = nativeIntervals.find((item) => (
    intervalsSemanticallyEquivalent(item.value, removedInterval)
  ));
  if (nativeEquivalent) return nativeEquivalent.value;
  if (isNativeIntervalSupported(
    exchange,
    removedInterval,
    exchangeCatalog,
    marketType,
    "history",
  )) return removedInterval;

  const recentCustom = customIntervalRecords
    .filter((record) => !intervalsSemanticallyEquivalent(record.value, removedInterval))
    .sort((left, right) => (right.lastUsedAt || 0) - (left.lastUsedAt || 0))[0];
  if (recentCustom) return recentCustom.value;

  const removedSeconds = parseIntervalSeconds(removedInterval);
  if (!removedSeconds) {
    return isNativeIntervalSupported(exchange, "1h", exchangeCatalog, marketType, "history")
      ? "1h"
      : nativeIntervals[0]?.value || "1m";
  }

  return [...nativeIntervals]
    .filter((item) => !intervalsSemanticallyEquivalent(item.value, removedInterval))
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
  const native = nativeIntervals.find((item) => intervalsSemanticallyEquivalent(item.value, interval));
  if (native) return native.value;
  const currentSeconds = parseIntervalSeconds(interval);
  if (!currentSeconds) return "1h";
  return [...nativeIntervals]
    .sort((left, right) => Math.abs(left.seconds - currentSeconds) - Math.abs(right.seconds - currentSeconds))[0]?.value
    || "1h";
}
