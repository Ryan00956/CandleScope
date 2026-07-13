import assert from "node:assert/strict";
import test from "node:test";

import {
  getFallbackIntervalAfterCustomClear,
  getFallbackIntervalAfterCustomRemove,
  resolveSupportedInterval,
} from "../intervalPolicy.js";

const nativeIntervals = [
  { value: "1m", seconds: 60 },
  { value: "1h", seconds: 3600 },
  { value: "1d", seconds: 86400 },
];

test("supported interval resolution preserves custom/native values and otherwise falls back", () => {
  const isNative = (_exchange, interval) => nativeIntervals.some((item) => item.value === interval);
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
});

test("custom interval removal prefers recent custom then nearest native interval", () => {
  const isNative = (_exchange, interval) => nativeIntervals.some((item) => item.value === interval);
  assert.equal(getFallbackIntervalAfterCustomRemove({
    removedInterval: "30m",
    customIntervalRecords: [
      { value: "20m", lastUsedAt: 1 },
      { value: "45m", lastUsedAt: 2 },
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
  assert.equal(getFallbackIntervalAfterCustomClear({
    interval: "50m",
    nativeIntervals,
  }), "1h");
});
