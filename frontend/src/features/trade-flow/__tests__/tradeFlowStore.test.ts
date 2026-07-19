import assert from "node:assert/strict";
import test from "node:test";
import { createTradeFlowStore } from "../tradeFlowStore.js";
import type { AggregateTrade } from "../tradeFlowTypes.js";

function trade(id: number): AggregateTrade {
  return {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    aggTradeId: id,
    price: 60_000 + id,
    quantity: 0.1,
    quoteQuantity: 6_000,
    tradeTimeMs: 1_700_000_000_000 + id,
    eventTimeMs: 1_700_000_000_000 + id,
    receivedAtMs: 1_700_000_000_000 + id,
    isBuyerMaker: id % 2 === 0,
    aggressorSide: id % 2 === 0 ? "sell" : "buy",
    source: "websocket",
    firstTradeId: id * 2,
    lastTradeId: id * 2 + 1,
  };
}

test("TradeFlow store ingests every ordered record while coalescing UI publication", () => {
  const callbacks: Array<() => void> = [];
  const store = createTradeFlowStore({
    maxRecords: 10,
    scheduler: {
      request(callback) { callbacks.push(callback); return callbacks.length; },
      cancel() {},
    },
  });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  assert.equal(store.replaceRecent([trade(1)]), true);
  assert.equal(store.appendBatch([trade(2), trade(3)]), true);
  assert.equal(callbacks.length, 1);
  assert.equal(notifications, 0);

  callbacks.shift()?.();
  assert.deepEqual(store.getSnapshot().records.map((item) => item.aggTradeId), [1, 2, 3]);
  assert.equal(notifications, 1);
});

test("TradeFlow store is bounded without introducing an internal sequence gap", () => {
  let flush: (() => void) | null = null;
  const store = createTradeFlowStore({
    maxRecords: 3,
    scheduler: {
      request(callback) { flush = callback; return 1; },
      cancel() { flush = null; },
    },
  });
  store.replaceRecent([trade(1), trade(2), trade(3)]);
  store.appendBatch([trade(4)]);
  (flush as (() => void) | null)?.();
  assert.deepEqual(store.getSnapshot().records.map((item) => item.aggTradeId), [2, 3, 4]);
  assert.equal(store.getSnapshot().continuity, true);
});

test("TradeFlow store clears derived output on an aggregate-trade ID gap", () => {
  let flush: (() => void) | null = null;
  const store = createTradeFlowStore({
    scheduler: {
      request(callback) { flush = callback; return 1; },
      cancel() { flush = null; },
    },
  });
  store.replaceRecent([trade(10)]);
  (flush as (() => void) | null)?.();

  assert.equal(store.appendBatch([trade(12)]), false);
  assert.equal(store.getSnapshot().status, "gap");
  assert.equal(store.getSnapshot().records.length, 0);
  assert.equal(store.getSnapshot().continuity, false);
});
