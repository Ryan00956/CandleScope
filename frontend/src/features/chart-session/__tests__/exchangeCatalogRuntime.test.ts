import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExchangeCatalog,
  buildSortedIntervals,
  getBaseWsIntervals,
  getNativeIntervals,
  getIntervalDays,
  isNativeIntervalSupported,
} from "../exchangeCatalogRuntime.js";
import type { ExchangeCapabilityPayload } from "../../../services/apiPayloadParsers.js";

function capability(
  exchange: string,
  overrides: Partial<ExchangeCapabilityPayload> = {},
): ExchangeCapabilityPayload {
  return {
    exchange,
    name: exchange.toUpperCase(),
    markets: [
      { market_type: "spot", product_type: "spot", label: "Spot" },
      { market_type: "futures", product_type: "perpetual", label: "Futures" },
    ],
    native_intervals: ["1s", "1m", "1h", "8h"],
    protocol_features: [],
    limits: {},
    known_limitations: [],
    ...overrides,
  };
}

test("exchange catalog uses semantic aliases for native support and UI dedupe", () => {
  assert.equal(isNativeIntervalSupported("binance", "60m"), true);
  assert.equal(isNativeIntervalSupported("binance", "1s", null, "futures"), false);
  assert.equal(isNativeIntervalSupported("binance", "1s", null, "spot"), true);
  assert.equal(isNativeIntervalSupported("binance", "24h"), true);
  assert.equal(isNativeIntervalSupported("binance", "7d"), false);
  assert.equal(getIntervalDays("60m", "binance"), getIntervalDays("1h", "binance"));
  assert.equal(getBaseWsIntervals("binance").filter((value) => value === "1h").length, 1);

  const values = buildSortedIntervals(["60m", "7d", "1w", "30d", "1M"], "binance")
    .flatMap((group) => group.items.map((item) => item.value));
  assert.equal(values.filter((value) => value === "1h").length, 1);
  assert.ok(values.includes("7d"));
  assert.ok(values.includes("1w"));
  assert.ok(values.includes("30d"));
  assert.ok(values.includes("1M"));
});

test("channel capabilities select native intervals by market and purpose", () => {
  const catalog = buildExchangeCatalog([capability("binance", {
    capability_schema_version: 3,
    channels: [
      {
        channel: "kline",
        market_types: ["spot"],
        history: true,
        realtime: true,
        params: { interval: ["1s", "1m", "60m", "1h"] },
      },
      {
        channel: "kline",
        market_types: ["futures"],
        history: true,
        realtime: true,
        params: { interval: ["1m", "1h"] },
      },
      {
        channel: "ticker",
        market_types: ["futures"],
        history: true,
        realtime: true,
        params: { interval: ["1s", "8h"] },
      },
    ],
  })]);

  assert.deepEqual(
    getNativeIntervals("binance", catalog, "spot", "history").map((item) => item.value),
    ["1s", "1m", "1h"],
  );
  assert.deepEqual(
    getNativeIntervals("binance", catalog, "futures", "history").map((item) => item.value),
    ["1m", "1h"],
  );
  assert.equal(isNativeIntervalSupported("binance", "1s", catalog, "spot"), true);
  assert.equal(isNativeIntervalSupported("binance", "1s", catalog, "futures"), false);
  assert.deepEqual(getBaseWsIntervals("binance", catalog, "futures"), ["1m", "1h"]);
  assert.equal(
    buildSortedIntervals([], "binance", catalog, "futures")
      .flatMap((group) => group.items)
      .some((item) => item.value === "1s"),
    false,
  );
});

test("history and realtime channel flags are purpose-authoritative", () => {
  const catalog = buildExchangeCatalog([capability("split", {
    capability_schema_version: 3,
    channels: [
      {
        channel: "kline",
        market_types: ["spot"],
        history: true,
        realtime: false,
        params: { interval: "1m" },
      },
      {
        channel: "kline",
        market_types: ["spot"],
        history: false,
        realtime: true,
        params: { interval: ["5m"] },
      },
      {
        channel: "kline",
        market_types: ["spot"],
        history: true,
        realtime: false,
        params: { interval: ["60m", null, "bad"] },
      },
    ],
  })]);

  assert.deepEqual(
    getNativeIntervals("split", catalog, "spot", "history").map((item) => item.value),
    ["1m", "1h"],
  );
  assert.deepEqual(getBaseWsIntervals("split", catalog, "spot"), ["5m"]);
});

test("only schema 1 without channels falls back to top-level native intervals", () => {
  const catalog = buildExchangeCatalog([
    capability("legacy", {
      capability_schema_version: 1,
      native_intervals: ["60m", "1w", "30d", "1M"],
    }),
    capability("modern-missing", {
      capability_schema_version: 2,
      native_intervals: ["1s", "8h"],
    }),
    capability("legacy-empty", {
      capability_schema_version: 1,
      channels: [],
      native_intervals: ["1s", "8h"],
    }),
    capability("okx", {
      capability_schema_version: 3,
      native_intervals: ["1m", "8h"],
      channels: [{
        channel: "kline",
        market_types: ["spot", "futures"],
        history: true,
        realtime: true,
        params: { interval: ["1m", "4h"] },
      }],
    }),
  ]);

  assert.deepEqual(
    getNativeIntervals("legacy", catalog, "spot", "history").map((item) => item.value),
    ["1h", "1w", "30d", "1M"],
  );
  assert.deepEqual(getNativeIntervals("modern-missing", catalog, "spot", "history"), []);
  assert.deepEqual(getNativeIntervals("legacy-empty", catalog, "spot", "history"), []);
  assert.equal(isNativeIntervalSupported("okx", "8h", catalog, "spot"), false);
  assert.equal(isNativeIntervalSupported("okx", "4h", catalog, "spot"), true);
  assert.deepEqual(getNativeIntervals("unknown-plugin", catalog, "spot", "history"), []);
});

test("polling-only exchange never exposes WebSocket base intervals", () => {
  const catalog = buildExchangeCatalog([capability("poll", {
    capability_schema_version: 3,
    protocol_features: ["ws.polling_only"],
    channels: [{
      channel: "kline",
      market_types: ["spot"],
      history: true,
      realtime: true,
      params: { interval: ["1m"] },
    }],
  })]);
  assert.deepEqual(getNativeIntervals("poll", catalog, "spot", "realtime").map((item) => item.value), ["1m"]);
  assert.deepEqual(getBaseWsIntervals("poll", catalog, "spot"), []);
});
