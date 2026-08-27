import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAggregateTrade,
  parseTradeFlowSocketMessage,
  TradeFlowPayloadError,
} from "../tradeFlowParser.js";

const RAW_TRADE = Object.freeze({
  exchange: "binance",
  market_type: "futures",
  symbol: "BTCUSDT",
  agg_trade_id: 10,
  price: 60_000,
  quantity: 0.1,
  quote_quantity: 6_000,
  trade_time_ms: 1_700_000_000_000,
  event_time_ms: 1_700_000_000_001,
  received_at_ms: 1_700_000_000_002,
  is_buyer_maker: false,
  aggressor_side: "buy",
  source: "websocket",
  first_trade_id: 20,
  last_trade_id: 21,
});

test("TradeFlow parser normalizes the backend aggregate-trade contract", () => {
  const parsed = parseAggregateTrade(RAW_TRADE);
  assert.equal(parsed.marketType, "futures");
  assert.equal(parsed.aggressorSide, "buy");
  assert.equal(parsed.quoteQuantity, 6_000);
});

test("TradeFlow parser rejects conflicting aggressor direction", () => {
  assert.throws(() => parseAggregateTrade({
    ...RAW_TRADE,
    is_buyer_maker: true,
    aggressor_side: "buy",
  }), TradeFlowPayloadError);
});

test("TradeFlow parser preserves explicit batch continuity state", () => {
  const parsed = parseTradeFlowSocketMessage({
    type: "trade.batch",
    protocol: "tradeflow.v1",
    sequence: 7,
    continuity: true,
    resync_required: false,
    data: [RAW_TRADE],
  });
  assert.equal(parsed.kind, "batch");
  if (parsed.kind === "batch") {
    assert.equal(parsed.sequence, 7);
    assert.equal(parsed.records.length, 1);
  }
});

test("TradeFlow parser preserves the request id on server errors", () => {
  const parsed = parseTradeFlowSocketMessage({
    type: "error",
    request_id: "trade-flow-subscribe-7",
    code: "SUBSCRIBE_FAILED",
    detail: "temporarily unavailable",
  });
  assert.deepEqual(parsed, {
    kind: "error",
    requestId: "trade-flow-subscribe-7",
    code: "SUBSCRIBE_FAILED",
    detail: "temporarily unavailable",
  });
});

test("TradeFlow parser preserves the observational contract without inventing exchange continuity", () => {
  const parsed = parseTradeFlowSocketMessage({
    type: "trade.batch",
    protocol: "tradeflow.v1",
    continuity_mode: "observational",
    sequence: 8,
    continuity: true,
    resync_required: false,
    data: [{
      ...RAW_TRADE,
      agg_trade_id: 3,
      trade_id: "opaque-provider-id",
      first_trade_id: null,
      last_trade_id: null,
      continuity_mode: "observational",
    }],
  });
  assert.equal(parsed.kind, "batch");
  if (parsed.kind === "batch") {
    assert.equal(parsed.continuityMode, "observational");
    assert.equal(parsed.records[0]?.tradeId, "opaque-provider-id");
    assert.equal(parsed.records[0]?.continuityMode, "observational");
  }
});
