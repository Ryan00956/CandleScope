import assert from "node:assert/strict";
import test from "node:test";

import { LiquidationStore } from "../liquidationStore.js";
import type {
  LiquidationEvent,
  LiquidationQualityMetadata,
  LiquidationRollup,
} from "../liquidationTypes.js";

const identity = { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" };
const quality: LiquidationQualityMetadata = {
  sourceQuality: "sampled_best_effort",
  sourceExhaustive: false,
  samplingMode: "latest_per_symbol_1000ms",
  lossySnapshot: true,
  backfillable: false,
  exchangeUpdateIntervalMs: 1000,
};

function event(overrides: Partial<LiquidationEvent> = {}): LiquidationEvent {
  return {
    ...identity,
    orderSide: "SELL",
    positionSide: "long",
    filledQuantity: 1,
    executedNotional: 20_000,
    tradeTimeMs: 1_700_000_000_100,
    eventTimeMs: 1_700_000_000_110,
    receivedAtMs: 1_700_000_000_120,
    source: "websocket",
    fingerprint: "event-1",
    ...overrides,
  };
}

function rollup(overrides: Partial<LiquidationRollup> = {}): LiquidationRollup {
  return {
    ...identity,
    period: "1m",
    positionSide: "long",
    bucketStartMs: 1_699_999_980_000,
    bucketEndMs: 1_700_000_040_000,
    filledQuantity: 1,
    filledNotional: 20_000,
    eventCount: 1,
    maxEventNotional: 20_000,
    firstEventTimeMs: 1_700_000_000_100,
    lastEventTimeMs: 1_700_000_000_100,
    isFinal: false,
    revision: 1,
    updatedAtMs: 1_700_000_000_120,
    ...overrides,
  };
}

test("liquidation store deduplicates replayed events and removes history-covered live data", () => {
  const store = new LiquidationStore();
  store.applyEvents(identity, [event(), event()], quality);
  assert.equal(store.getSnapshot(identity).liveEvents.length, 1);

  store.mergeHistory(identity, [rollup()], quality);
  const snapshot = store.getSnapshot(identity);
  assert.equal(snapshot.liveEvents.length, 0);
  assert.equal(snapshot.rollups[0]?.filledNotional, 20_000);
});

test("final liquidation rollups cannot be overwritten by later provisional rows", () => {
  const store = new LiquidationStore();
  store.mergeHistory(identity, [rollup({
    isFinal: true,
    revision: 2,
    filledNotional: 30_000,
  })], quality);
  store.mergeHistory(identity, [rollup({
    isFinal: false,
    revision: 99,
    updatedAtMs: 1_700_000_100_000,
    filledNotional: 99_000,
  })], quality);
  assert.equal(store.getSnapshot(identity).rollups[0]?.filledNotional, 30_000);
});

test("resync clears only unconfirmed liquidation state", () => {
  const store = new LiquidationStore();
  store.mergeHistory(identity, [
    rollup({ isFinal: true }),
    rollup({
      bucketStartMs: 1_700_000_040_000,
      bucketEndMs: 1_700_000_100_000,
      isFinal: false,
    }),
  ], quality);
  store.applyEvents(identity, [event({
    fingerprint: "event-later",
    tradeTimeMs: 1_700_000_110_000,
    receivedAtMs: 1_700_000_110_010,
  })], quality);

  store.clearUnconfirmed(identity);
  const snapshot = store.getSnapshot(identity);
  assert.equal(snapshot.rollups.length, 1);
  assert.equal(snapshot.rollups[0]?.isFinal, true);
  assert.equal(snapshot.liveEvents.length, 0);
});
