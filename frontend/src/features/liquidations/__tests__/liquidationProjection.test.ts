import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiquidationPane,
  projectLiquidationsToCandles,
} from "../liquidationProjection.js";
import {
  toEpochSeconds,
  type KlineBar,
} from "../../market-data/marketDataTypes.js";
import type {
  LiquidationEvent,
  LiquidationRollup,
  LiquidationSnapshot,
} from "../liquidationTypes.js";

const startSeconds = 1_700_000_000;
const bars: KlineBar[] = [0, 300, 600].map((offset) => {
  const time = toEpochSeconds(startSeconds + offset);
  assert.ok(time);
  return {
    time,
    open: 1,
    high: 2,
    low: 0,
    close: 1,
    volume: 1,
  };
});

function row(
  offsetMs: number,
  positionSide: "long" | "short",
  filledNotional: number,
): LiquidationRollup {
  const bucketStartMs = startSeconds * 1000 + offsetMs;
  return {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    period: "1m",
    positionSide,
    bucketStartMs,
    bucketEndMs: bucketStartMs + 60_000,
    filledQuantity: 1,
    filledNotional,
    eventCount: 1,
    maxEventNotional: filledNotional,
    firstEventTimeMs: bucketStartMs + 1,
    lastEventTimeMs: bucketStartMs + 1,
    isFinal: true,
    revision: 1,
    updatedAtMs: bucketStartMs + 2,
  };
}

function liveEvent(offsetMs: number, notional: number): LiquidationEvent {
  return {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    orderSide: "BUY",
    positionSide: "short",
    filledQuantity: 1,
    executedNotional: notional,
    tradeTimeMs: startSeconds * 1000 + offsetMs,
    eventTimeMs: startSeconds * 1000 + offsetMs,
    receivedAtMs: startSeconds * 1000 + offsetMs + 1,
    source: "websocket",
    fingerprint: `event-${offsetMs}`,
  };
}

test("liquidation projection aggregates 1m rows into chart bars without inventing zeroes", () => {
  const projected = projectLiquidationsToCandles([
    row(60_000, "long", 10_000),
    row(120_000, "long", 5_000),
    row(360_000, "short", 8_000),
  ], [liveEvent(180_000, 2_000)], bars, "5m");

  assert.deepEqual(projected, [
    {
      time: startSeconds,
      longNotional: 15_000,
      shortNotional: 2_000,
      hasLiveEvents: true,
      allRowsFinal: false,
    },
    {
      time: startSeconds + 300,
      longNotional: null,
      shortNotional: 8_000,
      hasLiveEvents: false,
      allRowsFinal: true,
    },
  ]);
});

test("liquidation pane places long above zero and short below zero", () => {
  const snapshot: LiquidationSnapshot = {
    rollups: [row(60_000, "long", 10_000), row(360_000, "short", 8_000)],
    liveEvents: [],
    connectionStatus: "live",
    quality: null,
    revision: 1,
  };
  const pane = buildLiquidationPane(snapshot, bars, "5m", {
    enabled: true,
    visible: true,
    identityKey: "binance:futures:BTCUSDT",
    connectionStatus: "live",
    error: null,
    historyError: null,
    quality: null,
  });

  assert.equal(pane.lines[0]?.data[0]?.value, 10_000);
  assert.equal(pane.lines[1]?.data[0]?.value, -8_000);
  assert.equal(pane.lines[0]?.scale, "symmetric-zero");
  assert.equal(pane.pointMetadataFallback, "none");
  assert.match(pane.missingPointText || "", /不等于 0/);
});

test("empty liquidation pane stays visible and states observed-only semantics", () => {
  const pane = buildLiquidationPane({
    rollups: [],
    liveEvents: [],
    connectionStatus: "live",
    quality: null,
    revision: 0,
  }, bars, "1m", {
    enabled: true,
    visible: true,
    identityKey: "binance:futures:BTCUSDT",
    connectionStatus: "live",
    error: null,
    historyError: null,
    quality: null,
  });
  assert.match(pane.statusText || "", /空白不等于 0/);
  assert.ok(pane.lines.every((line) => line.data.length === 0));
});
