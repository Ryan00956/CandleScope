import assert from "node:assert/strict";
import test from "node:test";
import { buildTradeFlowProfile } from "../tradeFlowProfile.js";
import type { AggregateTrade } from "../tradeFlowTypes.js";

function trade(id: number, price: number, side: "buy" | "sell", quote: number): AggregateTrade {
  return {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    aggTradeId: id,
    price,
    quantity: quote / price,
    quoteQuantity: quote,
    tradeTimeMs: id,
    eventTimeMs: id,
    receivedAtMs: id,
    isBuyerMaker: side === "sell",
    aggressorSide: side,
    source: "websocket",
    firstTradeId: null,
    lastTradeId: null,
  };
}

test("price profile keeps aggressor-side volume and count separate", () => {
  const profile = buildTradeFlowProfile([
    trade(1, 100, "buy", 2_000),
    trade(2, 100, "sell", 500),
  ]);
  assert.equal(profile.rows.length, 1);
  assert.equal(profile.rows[0]?.buyQuote, 2_000);
  assert.equal(profile.rows[0]?.sellQuote, 500);
  assert.equal(profile.rows[0]?.deltaQuote, 1_500);
  assert.equal(profile.rows[0]?.buyCount, 1);
  assert.equal(profile.rows[0]?.sellCount, 1);
});
