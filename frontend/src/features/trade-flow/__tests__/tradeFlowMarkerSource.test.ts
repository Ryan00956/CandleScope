import assert from "node:assert/strict";
import test from "node:test";
import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import { createTradeFlowMarkerSource } from "../tradeFlowMarkerSource.js";
import { createTradeFlowStore } from "../tradeFlowStore.js";
import type { AggregateTrade } from "../tradeFlowTypes.js";

const BAR_TIME = 1_699_999_980;

function trade(id: number, quoteQuantity: number): AggregateTrade {
  return {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    aggTradeId: id,
    price: 60_000 + id,
    quantity: quoteQuantity / (60_000 + id),
    quoteQuantity,
    tradeTimeMs: 1_700_000_000_000 + id,
    eventTimeMs: 1_700_000_000_000 + id,
    receivedAtMs: 1_700_000_000_000 + id,
    isBuyerMaker: false,
    aggressorSide: "buy",
    source: "websocket",
    firstTradeId: id * 2,
    lastTradeId: id * 2 + 1,
  };
}

test("large-trade markers keep a stable revision while visible output is unchanged", () => {
  const callbacks: Array<() => void> = [];
  const store = createTradeFlowStore({
    scheduler: {
      request(callback) { callbacks.push(callback); return callbacks.length; },
      cancel() {},
    },
  });
  const seriesStore = new SeriesWindowStore({ intervalSeconds: 60 });
  seriesStore.replace([{ time: BAR_TIME, open: 1, high: 1, low: 1, close: 1 }]);
  const source = createTradeFlowMarkerSource({
    store,
    seriesStore,
    intervalSeconds: 60,
    threshold: 100_000,
    buyColor: "#00ff00",
    sellColor: "#ff0000",
  });

  store.replaceRecent([trade(1, 5_000)]);
  callbacks.shift()?.();
  const empty = source.getSnapshot();
  assert.equal(empty.markers.length, 0);

  store.appendBatch([trade(2, 8_000)]);
  callbacks.shift()?.();
  assert.strictEqual(source.getSnapshot(), empty);

  store.appendBatch([trade(3, 150_000)]);
  callbacks.shift()?.();
  const withBubble = source.getSnapshot();
  assert.equal(withBubble.markers.length, 1);
  assert.ok(withBubble.revision > empty.revision);

  store.appendBatch([trade(4, 9_000)]);
  callbacks.shift()?.();
  assert.strictEqual(source.getSnapshot(), withBubble);
});

test("large-trade markers follow a non-epoch-aligned series axis", () => {
  const callbacks: Array<() => void> = [];
  const store = createTradeFlowStore({
    scheduler: {
      request(callback) { callbacks.push(callback); return callbacks.length; },
      cancel() {},
    },
  });
  const seriesStore = new SeriesWindowStore({ intervalSeconds: 60 });
  seriesStore.replace([{ time: 1_699_999_970, open: 1, high: 1, low: 1, close: 1 }]);
  const source = createTradeFlowMarkerSource({
    store,
    seriesStore,
    intervalSeconds: 60,
    threshold: 100_000,
    buyColor: "#00ff00",
    sellColor: "#ff0000",
  });

  store.replaceRecent([trade(1, 150_000)]);
  callbacks.shift()?.();
  assert.equal(source.getSnapshot().markers[0]?.time, 1_699_999_970);
});
