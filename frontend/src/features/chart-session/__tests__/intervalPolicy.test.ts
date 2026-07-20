import assert from "node:assert/strict";
import test from "node:test";

import {
  getEffectiveCustomIntervalRecords,
  getFallbackIntervalAfterCustomClear,
  getFallbackIntervalAfterCustomRemove,
  resolveSupportedInterval,
} from "../intervalPolicy.js";
import type { CustomIntervalRecord } from "../chartSessionTypes.js";

const nativeIntervals = [
  { value: "1m", seconds: 60 },
  { value: "1h", seconds: 3600 },
  { value: "1d", seconds: 86400 },
];

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
});

test("custom interval removal prefers recent custom then nearest native interval", () => {
  const isNative = (_exchange: string, interval: string) => nativeIntervals.some((item) => item.value === interval);
  assert.equal(getFallbackIntervalAfterCustomRemove({
    removedInterval: "30m",
    customIntervalRecords: [
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
