export function buildSubscriptionTierRequestBody(tier, options = {}) {
  const body = { tier };
  if (options.consumerId) {
    body.consumer_id = options.consumerId;
  }
  if (tier === "full" && Array.isArray(options.intervals)) {
    body.intervals = options.intervals;
  }
  return body;
}
