import { t } from "../../i18n/index.js";
import {
  canResolveIntervalFromNativeValues,
  canonicalizeIntervalValue,
} from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import type {
  FullSubscriptionOptions,
  IntervalCandidate,
  SubscriptionTierRequestOptions,
} from "./watchlistTypes.js";

function intervalValue(item: IntervalCandidate): unknown {
  return typeof item === "string" ? item : item?.value;
}

export function getFullSubscriptionIntervals({
  nativeIntervals = [],
  customIntervalRecords = [],
}: FullSubscriptionOptions = {}): IntervalString[] {
  const nativeValues = normalizedUniqueValues(nativeIntervals);
  const nativeSet = new Set(nativeValues);
  const customValues = normalizedUniqueValues(customIntervalRecords)
    .filter((value) => (
      !nativeSet.has(value)
      && canResolveIntervalFromNativeValues(value, nativeValues)
    ));
  return [...nativeValues, ...customValues];
}

function normalizedUniqueValues(items: IntervalCandidate[] = []): IntervalString[] {
  const seen = new Set<IntervalString>();
  const values: IntervalString[] = [];
  for (const item of items || []) {
    const value = canonicalizeIntervalValue(intervalValue(item));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

export function buildFullSubscriptionIntervalSignature(
  intervals: IntervalCandidate[] = [],
): string {
  return normalizedUniqueValues(intervals).sort().join("|");
}

export function shouldResyncFullSubscriptionIntervals({
  tier,
  desiredIntervals = [],
  observedSignature,
  inFlightSignature,
}: {
  tier: string;
  desiredIntervals?: IntervalCandidate[];
  observedSignature?: string | undefined;
  inFlightSignature?: string | undefined;
}): boolean {
  if (tier !== "full") return false;
  const desiredSignature = buildFullSubscriptionIntervalSignature(desiredIntervals);
  return observedSignature !== desiredSignature && inFlightSignature === undefined;
}

export function getFullSubscriptionResourceSummary({
  nativeIntervals = [],
  customIntervalRecords = [],
}: FullSubscriptionOptions = {}): {
  nativeCount: number;
  customCount: number;
  totalIntervals: number;
  shortText: string;
  tooltip: string;
} {
  const nativeValues = normalizedUniqueValues(nativeIntervals);
  const nativeSet = new Set(nativeValues);
  const customValues = normalizedUniqueValues(customIntervalRecords)
    .filter((value) => (
      !nativeSet.has(value)
      && canResolveIntervalFromNativeValues(value, nativeValues)
    ));
  const totalIntervals = nativeValues.length + customValues.length;

  return {
    nativeCount: nativeValues.length,
    customCount: customValues.length,
    totalIntervals,
    shortText: totalIntervals > 0 ? t("watchlist.fullSummary", { n: totalIntervals }) : "ticker",
    tooltip: t("watchlist.fullTooltip", { native: nativeValues.length, custom: customValues.length }),
  };
}

export function buildWatchlistConsumerId(symbol: unknown): string {
  return `watchlist:global:${symbol}`;
}

export function getSubscriptionTierRequestOptions({
  symbol,
  tier,
  nativeIntervals = [],
  customIntervalRecords = [],
}: SubscriptionTierRequestOptions = {}): {
  consumerId: string;
  intervals?: IntervalString[];
} {
  const options: { consumerId: string; intervals?: IntervalString[] } = {
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
