import assert from "node:assert/strict";
import test from "node:test";

import { loadSymbolFavorites } from "../symbolFavoritesStore.js";
import { filterSymbols } from "../symbolSearchFilter.js";
import {
  symbolCatalogNeedsRetry,
  symbolCatalogRetryDelayMs,
} from "../symbolCatalogRuntime.js";

function withFavoritesStorage(raw: string, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => raw, setItem() {} },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("symbol favorites storage rejects damaged shapes and invalid entries", () => {
  withFavoritesStorage("{damaged", () => assert.deepEqual(loadSymbolFavorites(), []));
  withFavoritesStorage(JSON.stringify(["spot:BTCUSDT", 4, null, ""]), () => {
    assert.deepEqual(loadSymbolFavorites(), ["spot:BTCUSDT"]);
  });
});

test("symbol catalog recovery retries quickly and caps its polling interval", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 20].map(symbolCatalogRetryDelayMs),
    [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
  );
});

test("symbol catalog keeps retrying partial results until every market is current", () => {
  assert.equal(symbolCatalogNeedsRetry({
    stale: true,
    symbols: [{ symbol: "BTCUSDT" }],
    markets: {
      "binance:spot": { stale: false, refreshing: false },
      "okx:spot": { stale: true, refreshing: true },
    },
  }), true);
  assert.equal(symbolCatalogNeedsRetry({
    stale: false,
    symbols: [{ symbol: "BTCUSDT" }, { symbol: "BTC-USDT" }],
    markets: {
      "binance:spot": { stale: false, refreshing: false },
      "okx:spot": { stale: false, refreshing: false },
    },
  }), false);
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
