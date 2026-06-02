import { parseIntervalSeconds } from "../../utils/intervals";

export function getExchangeMarketTypes(exchangeConfig) {
  return exchangeConfig.markets.map((market) => market.market_type).filter(Boolean);
}

export function getFallbackNativeInterval(nativeIntervals, preferredInterval = "1h") {
  return nativeIntervals.find((item) => item.value === preferredInterval)?.value
    || nativeIntervals[0]?.value
    || preferredInterval;
}

export function resolveSupportedInterval({
  exchange,
  interval,
  exchangeCatalog,
  savedCustomIntervals,
  nativeIntervals,
  isNativeIntervalSupported,
}) {
  if (savedCustomIntervals.includes(interval)) return interval;
  if (isNativeIntervalSupported(exchange, interval, exchangeCatalog)) return interval;
  return getFallbackNativeInterval(nativeIntervals, "1h");
}

export function getFallbackIntervalAfterCustomRemove({
  removedInterval,
  customIntervalRecords,
  nativeIntervals,
  exchange,
  isNativeIntervalSupported,
}) {
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

export function getFallbackIntervalAfterCustomClear({ interval, nativeIntervals }) {
  const currentSeconds = parseIntervalSeconds(interval);
  if (!currentSeconds) return "1h";
  return [...nativeIntervals]
    .sort((left, right) => Math.abs(left.seconds - currentSeconds) - Math.abs(right.seconds - currentSeconds))[0]?.value
    || "1h";
}