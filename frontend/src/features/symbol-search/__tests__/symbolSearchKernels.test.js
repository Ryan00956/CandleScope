import assert from "node:assert/strict";
import test from "node:test";

import { loadSymbolFavorites } from "../symbolFavoritesStore.js";
import { filterSymbols } from "../symbolSearchFilter.js";

function withFavoritesStorage(raw, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => raw, setItem() {} },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("symbol favorites storage rejects damaged shapes and invalid entries", () => {
  withFavoritesStorage("{damaged", () => assert.deepEqual(loadSymbolFavorites(), []));
  withFavoritesStorage(JSON.stringify(["spot:BTCUSDT", 4, null, ""]), () => {
    assert.deepEqual(loadSymbolFavorites(), ["spot:BTCUSDT"]);
  });
});

test("symbol filter combines market, exchange, quote, search, and favorites", () => {
  const symbols = [
    {
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      exchange: "binance",
      marketType: "spot",
      _key: "spot:BTCUSDT",
    },
    {
      symbol: "ETH-USDT-SWAP",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      exchange: "okx",
      marketType: "futures",
      _key: "okx:futures:ETH-USDT-SWAP",
    },
  ];
  assert.deepEqual(filterSymbols({
    allSymbols: symbols,
    marketType: "favorites",
    exchangeFilter: new Set(["binance"]),
    quoteFilter: "USDT",
    search: "btc",
    favorites: ["spot:BTCUSDT"],
  }), [symbols[0]]);
});
