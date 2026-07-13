import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndicatorOhlcv,
  INDICATOR_HISTORY_LIMIT,
  limitIndicatorHistory,
} from "../indicatorComputeRuntime.js";
import { buildHostedSubscriptionMessage } from "../indicatorWsRuntime.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import { epochSeconds } from "../../../test/testHelpers.js";

function bars(count: number): KlineBar[] {
  return Array.from({ length: count }, (_, index) => ({
    time: epochSeconds(1_700_000_000 + index * 60),
    open: index,
    high: index + 1,
    low: index - 1,
    close: index + 0.5,
    volume: index * 10,
  }));
}

test("hosted subscription historyLimit is capped to the indicator window", () => {
  const message = buildHostedSubscriptionMessage({
    id: "ma",
    engineName: "MA",
    params: { period: 20 },
    visible: true,
  }, {
    chartDataLength: 50_000,
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  });

  assert.equal(message.historyLimit, INDICATOR_HISTORY_LIMIT);
});

test("local indicator ohlcv is capped to the newest indicator window", () => {
  const source = bars(INDICATOR_HISTORY_LIMIT + 10);
  const limited = limitIndicatorHistory(source);
  const ohlcv = buildIndicatorOhlcv(source);

  assert.equal(limited.length, INDICATOR_HISTORY_LIMIT);
  assert.equal(limited[0].time, source[10].time);
  assert.equal(ohlcv.length, INDICATOR_HISTORY_LIMIT);
  assert.deepEqual(ohlcv[0], {
    time: source[10].time,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 100,
  });
});
