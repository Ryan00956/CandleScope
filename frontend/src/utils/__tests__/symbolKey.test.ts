import assert from "node:assert/strict";
import test from "node:test";

import {
  inferExchangeFromSymbol,
  parseSymbolKey,
  symbolKey,
} from "../symbolKey.js";

test("Binance composite keys keep the legacy two-part format", () => {
  const key = symbolKey("btcusdt", "SPOT", "BINANCE");
  assert.equal(key, "spot:BTCUSDT");
  assert.deepEqual(parseSymbolKey(key), {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
  });
});

test("non-Binance composite keys round-trip exchange, market, and symbol", () => {
  const key = symbolKey("btc-usdt", "SPOT", "OKX");
  assert.equal(key, "okx:spot:BTC-USDT");
  assert.deepEqual(parseSymbolKey(key), {
    exchange: "okx",
    marketType: "spot",
    symbol: "BTC-USDT",
  });
  assert.equal(inferExchangeFromSymbol("BTC-USDT"), "okx");
});
