import assert from "node:assert/strict";
import test from "node:test";

import {
  canResolveIntervalForSeriesIdentity,
  getEffectiveCustomIntervalRecords,
  getFallbackIntervalAfterCustomClear,
  getFallbackIntervalAfterCustomRemove,
  isExchangeIntervalCapabilityAvailable,
  resolveSupportedInterval,
} from "../intervalPolicy.js";
import type { CustomIntervalRecord } from "../chartSessionTypes.js";

const nativeIntervals = [
  { value: "1m", seconds: 60 },
  { value: "1h", seconds: 3600 },
  { value: "1d", seconds: 86400 },
];
const twelveDataNasdaqIdentity = {
  providerId: "twelvedata",
  venue: "xnas",
  assetClass: "equity",
  seriesVariant: "native",
  priceAdjustment: "raw",
  sessionVariant: "regular",
  volumeSemantics: "shares",
};

test("exchange capability readiness distinguishes loading, explicit fallback, and ready-empty catalogs", () => {
  assert.equal(isExchangeIntervalCapabilityAvailable("loading", {}, "binance", nativeIntervals), false);
  assert.equal(isExchangeIntervalCapabilityAvailable("fallback", {}, "binance", nativeIntervals), true);
  assert.equal(isExchangeIntervalCapabilityAvailable("fallback", {}, "unknown", []), false);
  assert.equal(isExchangeIntervalCapabilityAvailable("ready", {}, "binance", nativeIntervals), false);
  assert.equal(isExchangeIntervalCapabilityAvailable("ready", {
    binance: {} as never,
  }, "binance", nativeIntervals), true);
});

function customInterval(value: string, lastUsedAt: number): CustomIntervalRecord {
  return {
    value,
    createdAt: 0,
    lastUsedAt,
    usageCount: 0,
    pinned: false,
    order: 0,
  };
}

test("supported interval resolution preserves custom/native values and otherwise falls back", () => {
  const isNative = (_exchange: string, interval: string) => nativeIntervals.some((item) => item.value === interval);
  assert.equal(resolveSupportedInterval({
    exchange: "binance",
    interval: "45m",
    exchangeCatalog: {},
    savedCustomIntervals: ["45m"],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
  }), "45m");
  assert.equal(resolveSupportedInterval({
    exchange: "binance",
    interval: "1d",
    exchangeCatalog: {},
    savedCustomIntervals: [],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
  }), "1d");
  assert.equal(resolveSupportedInterval({
    exchange: "binance",
    interval: "bad",
    exchangeCatalog: {},
    savedCustomIntervals: [],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
  }), "1h");
  assert.equal(resolveSupportedInterval({
    exchange: "binance",
    interval: "7s",
    exchangeCatalog: {},
    savedCustomIntervals: ["7s"],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
  }), "1h", "saved syntax alone must not bypass exact history capabilities");
  assert.equal(resolveSupportedInterval({
    exchange: "binance",
    interval: "45m",
    exchangeCatalog: {},
    savedCustomIntervals: ["45m"],
    nativeIntervals: [],
    isNativeIntervalSupported: () => false,
  }), "45m", "an unavailable market must not invent a native 1h route");
});

test("non-default series identities allow native intervals but reject derived custom intervals", () => {
  const nativeValues = nativeIntervals.map((item) => item.value);
  const isNative = (_exchange: string, interval: string) => nativeValues.includes(interval);

  assert.equal(canResolveIntervalForSeriesIdentity(
    "twelvedata",
    "1m",
    nativeValues,
    twelveDataNasdaqIdentity,
  ), true);
  assert.equal(canResolveIntervalForSeriesIdentity(
    "twelvedata",
    "7m",
    nativeValues,
    twelveDataNasdaqIdentity,
  ), false);
  assert.equal(canResolveIntervalForSeriesIdentity(
    "binance",
    "7m",
    nativeValues,
    undefined,
  ), true);
  assert.equal(resolveSupportedInterval({
    exchange: "twelvedata",
    marketType: "stock",
    interval: "7m",
    exchangeCatalog: {},
    savedCustomIntervals: ["7m"],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
    seriesIdentity: twelveDataNasdaqIdentity,
  }), "1h");
  assert.equal(resolveSupportedInterval({
    exchange: "twelvedata",
    marketType: "stock",
    interval: "1m",
    exchangeCatalog: {},
    savedCustomIntervals: ["7m"],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
    seriesIdentity: twelveDataNasdaqIdentity,
  }), "1m");
});

test("custom interval removal prefers recent custom then nearest native interval", () => {
  const isNative = (_exchange: string, interval: string) => nativeIntervals.some((item) => item.value === interval);
  assert.equal(getFallbackIntervalAfterCustomRemove({
    removedInterval: "30m",
    customIntervalRecords: [
      customInterval("7s", 3),
      customInterval("20m", 1),
      customInterval("45m", 2),
    ],
    nativeIntervals,
    exchange: "binance",
    isNativeIntervalSupported: isNative,
  }), "45m");
  assert.equal(getFallbackIntervalAfterCustomRemove({
    removedInterval: "45m",
    customIntervalRecords: [],
    nativeIntervals,
    exchange: "binance",
    isNativeIntervalSupported: isNative,
  }), "1h");
  assert.equal(getFallbackIntervalAfterCustomRemove({
    removedInterval: "7m",
    customIntervalRecords: [customInterval("45m", 2)],
    nativeIntervals,
    exchange: "twelvedata",
    marketType: "stock",
    isNativeIntervalSupported: isNative,
    seriesIdentity: twelveDataNasdaqIdentity,
  }), "1m");
  assert.equal(getFallbackIntervalAfterCustomClear({
    interval: "50m",
    nativeIntervals,
  }), "1h");
});

test("saved custom provenance is masked when the current exchange supports it natively", () => {
  const records = [customInterval("8h", 2), customInterval("45m", 1)];
  const nativeWithEightHours = [
    ...nativeIntervals,
    { value: "8h", seconds: 28_800 },
  ];

  assert.deepEqual(
    getEffectiveCustomIntervalRecords(records, nativeWithEightHours).map((record) => record.value),
    ["45m"],
  );
  assert.equal(getFallbackIntervalAfterCustomRemove({
    removedInterval: "8h",
    customIntervalRecords: records,
    nativeIntervals: nativeWithEightHours,
    exchange: "binance",
    isNativeIntervalSupported: (_exchange, interval) => interval === "8h",
  }), "8h");
  assert.equal(getFallbackIntervalAfterCustomClear({
    interval: "8h",
    nativeIntervals: nativeWithEightHours,
  }), "8h");
});

test("semantic aliases migrate onto the native canonical interval", () => {
  const isNative = (_exchange: string, interval: string) => nativeIntervals.some((item) => item.value === interval);
  assert.deepEqual(getEffectiveCustomIntervalRecords([
    customInterval("60m", 1),
    customInterval("24h", 2),
    customInterval("7d", 3),
  ], nativeIntervals).map((record) => record.value), ["7d"]);
  assert.equal(resolveSupportedInterval({
    exchange: "binance",
    interval: "60m",
    exchangeCatalog: {},
    savedCustomIntervals: ["60m"],
    nativeIntervals,
    isNativeIntervalSupported: isNative,
  }), "1h");
  assert.equal(getFallbackIntervalAfterCustomClear({
    interval: "24h",
    nativeIntervals,
  }), "1d");
});
