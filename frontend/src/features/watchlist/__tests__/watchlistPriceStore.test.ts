import assert from "node:assert/strict";
import test from "node:test";

import { createWatchlistPriceStore } from "../watchlistPriceStore.js";

function createManualScheduler() {
  let callback: (() => void) | null = null;
  let requestCount = 0;
  let cancelCount = 0;
  return {
    scheduler: {
      request(next: () => void) {
        requestCount += 1;
        callback = next;
        return requestCount;
      },
      cancel() {
        cancelCount += 1;
        callback = null;
      },
    },
    flush() {
      const current = callback;
      callback = null;
      current?.();
    },
    get requestCount() {
      return requestCount;
    },
    get cancelCount() {
      return cancelCount;
    },
  };
}

test("watchlist price store coalesces packets and publishes the latest symbol tick once per frame", () => {
  const manual = createManualScheduler();
  const controller = createWatchlistPriceStore(manual.scheduler);
  let allPublications = 0;
  let btcPublications = 0;
  let ethPublications = 0;
  controller.store.subscribe(() => { allPublications += 1; });
  controller.store.subscribeSymbol("binance:spot:BTCUSDT", () => { btcPublications += 1; });
  controller.store.subscribeSymbol("binance:spot:ETHUSDT", () => { ethPublications += 1; });

  controller.enqueue([{ symbol: "binance:spot:BTCUSDT", price: 100 }]);
  controller.enqueue([
    { symbol: "binance:spot:BTCUSDT", price: 101 },
    { symbol: "binance:spot:ETHUSDT", price: 20 },
  ]);

  assert.equal(manual.requestCount, 1);
  assert.deepEqual(controller.store.getSnapshot(), {});
  manual.flush();

  assert.equal(controller.store.getSymbolSnapshot("binance:spot:BTCUSDT")?.price, 101);
  assert.equal(controller.store.getSymbolSnapshot("binance:spot:ETHUSDT")?.price, 20);
  assert.equal(allPublications, 1);
  assert.equal(btcPublications, 1);
  assert.equal(ethPublications, 1);
});

test("watchlist price store deduplicates equal ticks and preserves untouched symbol identities", () => {
  const manual = createManualScheduler();
  const controller = createWatchlistPriceStore(manual.scheduler);
  let btcPublications = 0;
  let ethPublications = 0;
  controller.store.subscribeSymbol("BTC", () => { btcPublications += 1; });
  controller.store.subscribeSymbol("ETH", () => { ethPublications += 1; });

  controller.enqueue([
    { symbol: "BTC", price: 100, daily_change: 2 },
    { symbol: "ETH", price: 20 },
  ]);
  manual.flush();
  const firstSnapshot = controller.store.getSnapshot();
  const firstEth = controller.store.getSymbolSnapshot("ETH");

  controller.enqueue([{ symbol: "BTC", price: 100, daily_change: 2 }]);
  manual.flush();
  assert.equal(controller.store.getSnapshot(), firstSnapshot);
  assert.equal(btcPublications, 1);
  assert.equal(ethPublications, 1);

  controller.enqueue([{ symbol: "BTC", price: 102, daily_change: 4 }]);
  manual.flush();
  assert.notEqual(controller.store.getSnapshot(), firstSnapshot);
  assert.equal(controller.store.getSymbolSnapshot("ETH"), firstEth);
  assert.equal(btcPublications, 2);
  assert.equal(ethPublications, 1);
  assert.equal(Object.isFrozen(controller.store.getSnapshot()), true);
  assert.equal(Object.isFrozen(controller.store.getSymbolSnapshot("BTC")), true);
});

test("watchlist price store cancellation drops an unpublished frame", () => {
  const manual = createManualScheduler();
  const controller = createWatchlistPriceStore(manual.scheduler);
  controller.enqueue([{ symbol: "BTC", price: 100 }]);
  controller.cancelPending();
  manual.flush();

  assert.equal(manual.cancelCount, 1);
  assert.equal(controller.store.getSymbolSnapshot("BTC"), undefined);
});
