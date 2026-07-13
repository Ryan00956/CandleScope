import type { IntervalString } from "../../utils/intervals.js";

export type SubscriptionTier = "none" | "price" | "full";

export interface WatchlistItem {
  symbolKey: string;
  tier?: SubscriptionTier;
}

export interface WatchlistGroup {
  id: string;
  name: string;
  symbols: string[];
  color: string;
}

export type IntervalCandidate = IntervalString | { value?: unknown };

export interface FullSubscriptionOptions {
  nativeIntervals?: IntervalCandidate[];
  customIntervalRecords?: IntervalCandidate[];
}

export interface SubscriptionTierRequestOptions extends FullSubscriptionOptions {
  symbol?: unknown;
  tier?: SubscriptionTier;
}

export interface SubscriptionRequestOptions {
  consumerId?: string;
  intervals?: IntervalString[];
}

export interface SubscriptionTierRequestBody {
  tier: SubscriptionTier;
  consumer_id?: string;
  intervals?: IntervalString[];
}
