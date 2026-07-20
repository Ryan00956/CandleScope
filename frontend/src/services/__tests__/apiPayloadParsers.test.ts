import assert from "node:assert/strict";
import test from "node:test";
import { ApiPayloadError, parseKlineBar } from "../apiPayloadParsers.js";

const BASE_BAR = Object.freeze({
  time: 1_700_000_000,
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  volume: 10,
});

test("parseKlineBar preserves valid fail-closed order-flow fields", () => {
  const parsed = parseKlineBar({
    ...BASE_BAR,
    quote_volume: 1_000,
    trades: 25,
    taker_buy_base: 6,
    taker_buy_quote: 650,
    order_flow: {
      taker_sell_base: 4,
      volume_delta_base: 2,
      taker_buy_ratio_base: 0.6,
      cvd_contribution_base: 2,
    },
  });

  assert.equal(parsed.trades, 25);
  assert.equal(parsed.order_flow?.volume_delta_base, 2);
  assert.equal(parsed.order_flow?.cvd_contribution_base, 2);
});

test("parseKlineBar preserves explicit unavailable order-flow values", () => {
  const parsed = parseKlineBar({
    ...BASE_BAR,
    quote_volume: null,
    trades: null,
    taker_buy_base: null,
    taker_buy_quote: null,
    order_flow: null,
  });

  assert.equal(parsed.quote_volume, null);
  assert.equal(parsed.order_flow, null);
});

test("parseKlineBar rejects malformed order-flow enhancements", () => {
  assert.throws(() => parseKlineBar({
    ...BASE_BAR,
    order_flow: {
      taker_sell_base: 4,
      volume_delta_base: Number.NaN,
      taker_buy_ratio_base: 1.2,
      cvd_contribution_base: 2,
    },
  }), ApiPayloadError);
  assert.throws(() => parseKlineBar({ ...BASE_BAR, trades: 1.5 }), ApiPayloadError);
});
