import assert from "node:assert/strict";
import test from "node:test";

import { buildSubscriptionTierRequestBody } from "../subscriptionApiPolicy.js";

test("buildSubscriptionTierRequestBody includes full intervals and consumer id", () => {
  assert.deepEqual(
    buildSubscriptionTierRequestBody("full", {
      intervals: ["1m", "1h"],
      consumerId: "watchlist:client-a:spot:BTCUSDT",
    }),
    {
      tier: "full",
      intervals: ["1m", "1h"],
      consumer_id: "watchlist:client-a:spot:BTCUSDT",
    },
  );
});

test("buildSubscriptionTierRequestBody omits intervals outside full tier", () => {
  assert.deepEqual(
    buildSubscriptionTierRequestBody("price", {
      intervals: ["1m", "1h"],
      consumerId: "watchlist:client-a:spot:BTCUSDT",
    }),
    {
      tier: "price",
      consumer_id: "watchlist:client-a:spot:BTCUSDT",
    },
  );
});
