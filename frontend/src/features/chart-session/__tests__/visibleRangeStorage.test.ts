import assert from "node:assert/strict";
import test from "node:test";

import {
  getVisibleRangeForInterval,
  normalizeVisibleRange,
  planVisibleRangeRestore,
  saveVisibleRangeForInterval,
} from "../visibleRangeStorage.js";
import { withLocalStorage } from "./localStorageHarness.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

const VISIBLE_RANGE_KEY = "candlescope-visible-ranges";

interface StoredVisibleRange {
  barSpacing: number;
  rightOffset: number;
  rightmostTime: number;
  savedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStoredVisibleRange(value: unknown): value is StoredVisibleRange {
  if (!isRecord(value)) return false;
  const record = value;
  return typeof record.barSpacing === "number"
    && typeof record.rightOffset === "number"
    && typeof record.rightmostTime === "number"
    && typeof record.savedAt === "number";
}

test("normalizeVisibleRange stores the phase7 anchor tuple", () => {
  assert.deepEqual(normalizeVisibleRange({
    logical: { from: 10, to: 20 },
    time: { from: 100, to: 200 },
    barSpacing: 8,
    rightOffset: 3,
    rightmostTime: 200,
    dataVersion: 99,
  }), {
    barSpacing: 8,
    rightOffset: 3,
    rightmostTime: 200,
  });
});

test("normalizeVisibleRange migrates legacy scroll and time fields", () => {
  assert.deepEqual(normalizeVisibleRange({
    time: { from: 100, to: 200 },
    barSpacing: 7,
    scrollPosition: 5,
  }), {
    barSpacing: 7,
    rightOffset: 5,
    rightmostTime: 200,
  });
});

test("planVisibleRangeRestore uses a single anchor mode", () => {
  assert.deepEqual(planVisibleRangeRestore({
    time: { from: 100, to: 200 },
    barSpacing: 7,
    scrollPosition: 5,
  }, [{ time: 150 }], { version: 1 }), {
    mode: "anchor",
    barSpacing: 7,
    rightOffset: 5,
    rightmostTime: 200,
  });
});

test("corrupt visible-range storage fails closed", () => {
  for (const raw of ["{broken", "null", "[]"]) {
    withLocalStorage({ [VISIBLE_RANGE_KEY]: raw }, () => {
      assert.equal(
        getVisibleRangeForInterval("BTCUSDT", "1h", "spot", "binance"),
        null,
      );
    });
  }
});

test("legacy interval-only visible ranges remain readable", () => {
  withLocalStorage({
    [VISIBLE_RANGE_KEY]: JSON.stringify({
      "1h": {
        barSpacing: 7,
        scrollPosition: 5,
        time: { to: 200 },
      },
    }),
  }, () => {
    assert.deepEqual(
      getVisibleRangeForInterval("BTCUSDT", "1h", "spot", "binance"),
      { barSpacing: 7, rightOffset: 5, rightmostTime: 200 },
    );
  });
});

test("visible ranges write the composite identity key", () => {
  withLocalStorage({}, (storage) => {
    saveVisibleRangeForInterval(
      "BTC-USDT",
      "1M",
      { barSpacing: 8, rightOffset: 2, rightmostTime: 300 },
      "spot",
      "okx",
    );
    const parsed: unknown = JSON.parse(mustBeDefined(storage.getItem(VISIBLE_RANGE_KEY)));
    assert.ok(isRecord(parsed));
    const saved = parsed;
    const entry = saved["okx::spot::BTC-USDT::1M"];
    assert.ok(isStoredVisibleRange(entry));
    assert.deepEqual(
      {
        barSpacing: entry.barSpacing,
        rightOffset: entry.rightOffset,
        rightmostTime: entry.rightmostTime,
      },
      { barSpacing: 8, rightOffset: 2, rightmostTime: 300 },
    );
    assert.ok(Number.isFinite(entry.savedAt));
  });
});
