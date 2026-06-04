import { normalizeIntervalValue } from "../../utils/intervals.js";

function intervalValue(item) {
  return typeof item === "string" ? item : item?.value;
}

export function getFullSubscriptionIntervals({
  nativeIntervals = [],
  customIntervalRecords = [],
} = {}) {
  const seen = new Set();
  const intervals = [];

  for (const item of [...nativeIntervals, ...customIntervalRecords]) {
    const value = normalizeIntervalValue(intervalValue(item));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    intervals.push(value);
  }

  return intervals;
}

function normalizedUniqueValues(items) {
  const seen = new Set();
  const values = [];
  for (const item of items || []) {
    const value = normalizeIntervalValue(intervalValue(item));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

export function getFullSubscriptionResourceSummary({
  nativeIntervals = [],
  customIntervalRecords = [],
} = {}) {
  const nativeValues = normalizedUniqueValues(nativeIntervals);
  const nativeSet = new Set(nativeValues);
  const customValues = normalizedUniqueValues(customIntervalRecords)
    .filter((value) => !nativeSet.has(value));
  const totalIntervals = nativeValues.length + customValues.length;

  return {
    nativeCount: nativeValues.length,
    customCount: customValues.length,
    totalIntervals,
    shortText: totalIntervals > 0 ? `ticker + ${totalIntervals}周期` : "ticker",
    tooltip: `完全订阅：ticker + ${nativeValues.length} native + ${customValues.length} custom`,
  };
}

export function buildWatchlistConsumerId(symbol) {
  return `watchlist:global:${symbol}`;
}

export function getSubscriptionTierRequestOptions({
  symbol,
  tier,
  nativeIntervals = [],
  customIntervalRecords = [],
} = {}) {
  const options = {
    consumerId: buildWatchlistConsumerId(symbol),
  };

  if (tier === "full") {
    options.intervals = getFullSubscriptionIntervals({
      nativeIntervals,
      customIntervalRecords,
    });
  }

  return options;
}
