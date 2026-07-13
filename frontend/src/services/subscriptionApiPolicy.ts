import type {
  SubscriptionRequestOptions,
  SubscriptionTier,
  SubscriptionTierRequestBody,
} from "../features/watchlist/watchlistTypes.js";

export function buildSubscriptionTierRequestBody(
  tier: SubscriptionTier,
  options: SubscriptionRequestOptions = {},
): SubscriptionTierRequestBody {
  const body: SubscriptionTierRequestBody = { tier };
  if (options.consumerId) {
    body.consumer_id = options.consumerId;
  }
  if (tier === "full" && Array.isArray(options.intervals)) {
    body.intervals = options.intervals;
  }
  return body;
}
