import assert from "node:assert/strict";
import test from "node:test";

import { loadSymbolFavorites } from "../symbolFavoritesStore.js";
import {
  buildExchangeChips,
  buildMarketTabs,
  filterSymbols,
  resolveExchangeMarketType,
} from "../symbolSearchFilter.js";
import {
  symbolCatalogNeedsRetry,
  symbolCatalogRetryAtMs,
  symbolCatalogRetryDelayMs,
} from "../symbolCatalogRuntime.js";
import { SymbolCatalogClientCache } from "../symbolCatalogClientCache.js";

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
    [0, 1, 2, 3, 4, 20].map((attempt) => symbolCatalogRetryDelayMs(attempt)),
    [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
  );
  assert.equal(symbolCatalogRetryDelayMs(0, 30_000, 0), 30_000);
  assert.equal(symbolCatalogRetryAtMs({
    detail: JSON.stringify({
      retry_at_ms: 30_000,
      markets: { "bybit:spot": { retry_at_ms: 30_000 } },
    }),
  }), 30_000);
});

test("symbol catalog cache blocks only the first attempt and remains bounded", () => {
  const cache = new SymbolCatalogClientCache(2);
  const binance = { exchange: "binance", marketType: "futures" };
  const bybit = { exchange: "bybit", marketType: "swap.linear" };
  const okx = { exchange: "okx", marketType: "spot" };
  const btc = {
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    exchange: "binance",
    marketType: "futures",
    _key: "binance:futures:BTCUSDT",
  };

  assert.equal(cache.shouldBlock([binance]), true);
  cache.rememberAttempt(binance);
  assert.equal(cache.shouldBlock([binance]), false);
  assert.deepEqual(cache.read([binance]), []);
  cache.remember(binance, [btc]);
  assert.deepEqual(cache.read([binance]), [btc]);

  cache.rememberAttempt(bybit);
  cache.rememberAttempt(okx);
  assert.equal(cache.shouldBlock([binance]), true);
  assert.equal(cache.shouldBlock([bybit]), false);
  assert.equal(cache.shouldBlock([okx]), false);
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

test("capability catalog exposes unloaded exchanges and exact CCXT market types", () => {
  const exchangeCatalog = {
    aster: { label: "Aster", markets: [] },
    binance: { label: "Binance", markets: [{ market_type: "spot", label: "Spot" }] },
    bybit: {
      label: "Bybit",
      markets: [
        { market_type: "spot", label: "Spot" },
        { market_type: "swap.linear", label: "Perpetual Swap (Linear)" },
      ],
    },
  };
  assert.deepEqual(
    buildExchangeChips({
      allSymbols: [],
      currentExchange: "binance",
      exchangeCatalog,
    }).map((item) => [item.key, item.disabled]),
    [["aster", true], ["binance", false], ["bybit", false]],
  );
  assert.deepEqual(
    buildMarketTabs({
      allSymbols: [],
      exchangeCatalog,
      exchangeFilter: new Set(["bybit"]),
    }).map((item) => [item.key, item.label]),
    [
      ["favorites", "★ 收藏"],
      ["spot", "现货"],
      ["swap.linear", "Perpetual Swap (Linear)"],
    ],
  );
  const bybitTabs = buildMarketTabs({
    allSymbols: [],
    exchangeCatalog,
    exchangeFilter: new Set(["bybit"]),
  });
  assert.equal(resolveExchangeMarketType("futures", bybitTabs), "swap.linear");
  assert.equal(resolveExchangeMarketType("spot", bybitTabs), "spot");
});
