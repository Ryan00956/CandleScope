import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWatchlistConsumerId,
  getFullSubscriptionResourceSummary,
  getFullSubscriptionIntervals,
  getSubscriptionTierRequestOptions,
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
