import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFullSubscriptionIntervalSignature,
  buildWatchlistConsumerId,
  getFullSubscriptionResourceSummary,
  getFullSubscriptionIntervals,
  getSubscriptionTierRequestOptions,
  shouldResyncFullSubscriptionIntervals,
} from "../watchlistSubscriptionPolicy.js";

test("getFullSubscriptionIntervals combines native and custom intervals in stable order", () => {
  assert.deepEqual(
    getFullSubscriptionIntervals({
      nativeIntervals: [
        { value: "1m" },
        { value: "1h" },
        { value: "1M" },
      ],
      customIntervalRecords: [
        { value: "45m" },
        { value: "1h" },
        { value: "bogus" },
        "4h",
      ],
    }),
    ["1m", "1h", "1M", "45m", "4h"],
  );
});

test("getSubscriptionTierRequestOptions includes intervals only for full tier", () => {
  const full = getSubscriptionTierRequestOptions({
    symbol: "okx:spot:BTC-USDT",
    tier: "full",
    nativeIntervals: [{ value: "1m" }, { value: "1h" }],
    customIntervalRecords: [{ value: "45m" }],
  });

  assert.deepEqual(full, {
    consumerId: "watchlist:global:okx:spot:BTC-USDT",
    intervals: ["1m", "1h", "45m"],
  });

  const price = getSubscriptionTierRequestOptions({
    symbol: "okx:spot:BTC-USDT",
    tier: "price",
    nativeIntervals: [{ value: "1m" }],
    customIntervalRecords: [{ value: "45m" }],
  });

  assert.deepEqual(price, {
    consumerId: "watchlist:global:okx:spot:BTC-USDT",
  });
});

test("getFullSubscriptionResourceSummary reports native and custom counts", () => {
  assert.deepEqual(
    getFullSubscriptionResourceSummary({
      nativeIntervals: [{ value: "1m" }, { value: "1h" }, { value: "1h" }],
      customIntervalRecords: [{ value: "45m" }, { value: "1h" }, { value: "4h" }],
    }),
    {
      nativeCount: 2,
      customCount: 2,
      totalIntervals: 4,
      shortText: "ticker + 4周期",
      tooltip: "完全订阅：ticker + 2 native + 2 custom",
    },
  );
});

test("buildWatchlistConsumerId uses a single local watchlist owner", () => {
  assert.equal(
    buildWatchlistConsumerId("spot:BTCUSDT"),
    "watchlist:global:spot:BTCUSDT",
  );
});

test("full subscriptions exclude custom intervals without an exact purpose-specific base", () => {
  assert.deepEqual(getFullSubscriptionIntervals({
    nativeIntervals: [{ value: "1m" }, { value: "1h" }],
    customIntervalRecords: [{ value: "7s" }, { value: "47m" }, { value: "90s" }],
  }), ["1m", "1h", "47m"]);
  assert.deepEqual(getFullSubscriptionIntervals({
    nativeIntervals: [{ value: "1s" }, { value: "1m" }],
    customIntervalRecords: [{ value: "7s" }, { value: "90s" }],
  }), ["1s", "1m", "7s", "90s"]);
});

test("full interval resync compares normalized sets and suppresses duplicate inflight work", () => {
  const observed = buildFullSubscriptionIntervalSignature(["1m", "1h"]);
  assert.equal(shouldResyncFullSubscriptionIntervals({
    tier: "full",
    desiredIntervals: ["1h", "1m"],
    observedSignature: observed,
  }), false);
  assert.equal(shouldResyncFullSubscriptionIntervals({
    tier: "full",
    desiredIntervals: ["1m", "1h", "45m"],
    observedSignature: observed,
  }), true);
  const desired = buildFullSubscriptionIntervalSignature(["1m", "1h", "45m"]);
  assert.equal(shouldResyncFullSubscriptionIntervals({
    tier: "full",
    desiredIntervals: ["1m", "1h", "45m"],
    observedSignature: observed,
    inFlightSignature: desired,
  }), false);
  assert.equal(shouldResyncFullSubscriptionIntervals({
    tier: "full",
    desiredIntervals: ["1m", "1h", "45m"],
    observedSignature: observed,
    inFlightSignature: buildFullSubscriptionIntervalSignature(["1m", "1h"]),
  }), false, "a changed desired set waits for the current per-symbol PUT to settle");
  assert.equal(shouldResyncFullSubscriptionIntervals({
    tier: "price",
    desiredIntervals: ["1m", "1h", "45m"],
    observedSignature: observed,
  }), false);
});

test("full interval policy canonicalizes semantic aliases without merging calendar alignments", () => {
  assert.deepEqual(getFullSubscriptionIntervals({
    nativeIntervals: [{ value: "1h" }, { value: "1w" }, { value: "1M" }],
    customIntervalRecords: [{ value: "60m" }, { value: "7d" }, { value: "30d" }],
  }), ["1h", "1w", "1M", "7d", "30d"]);
  assert.equal(
    buildFullSubscriptionIntervalSignature(["60m", "24h"]),
    buildFullSubscriptionIntervalSignature(["1h", "1d"]),
  );
});
