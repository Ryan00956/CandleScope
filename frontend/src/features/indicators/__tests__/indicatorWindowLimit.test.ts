import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndicatorOhlcv,
  buildIndicatorOhlcvSignature,
  chunkIndicatorComputeJobs,
  INDICATOR_HISTORY_LIMIT,
  limitIndicatorHistory,
} from "../indicatorComputeRuntime.js";
import { buildHostedSubscriptionMessage } from "../indicatorWsRuntime.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import { epochSeconds, mustBeDefined } from "../../../test/testHelpers.js";

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
  const firstLimited = mustBeDefined(limited[0]);
  const firstOhlcv = mustBeDefined(ohlcv[0]);
  const expectedSource = mustBeDefined(source[10]);

  assert.equal(limited.length, INDICATOR_HISTORY_LIMIT);
  assert.equal(firstLimited.time, expectedSource.time);
  assert.equal(ohlcv.length, INDICATOR_HISTORY_LIMIT);
  assert.deepEqual(firstOhlcv, {
    time: expectedSource.time,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 100,
  });
});

test("local compute signature follows the transmitted tail instead of prepended history", () => {
  const tail = bars(INDICATOR_HISTORY_LIMIT);
  const prepended = [
    ...bars(10).map((bar, index) => ({ ...bar, time: epochSeconds(1_600_000_000 + index * 60) })),
    ...tail,
  ];
  assert.equal(
    buildIndicatorOhlcvSignature(prepended),
    buildIndicatorOhlcvSignature(tail),
  );

  const corrected = tail.map((bar, index) => (
    index === 1_000 ? { ...bar, close: Number(bar.close) + 1 } : bar
  ));
  assert.notEqual(
    buildIndicatorOhlcvSignature(corrected),
    buildIndicatorOhlcvSignature(tail),
  );
});

test("local compute keeps ordinary plans in one request and bounds oversized plans", () => {
  assert.deepEqual(chunkIndicatorComputeJobs([1, 2, 3, 4]), [[1, 2, 3, 4]]);
  const jobs = Array.from({ length: 33 }, (_, index) => index);
  const chunks = chunkIndicatorComputeJobs(jobs);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 32);
  assert.deepEqual(chunks[1], [32]);
});
