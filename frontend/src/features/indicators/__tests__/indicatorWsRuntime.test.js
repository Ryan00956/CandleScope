import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostedSubscriptionMessage,
  dispatchIndicatorWsMessage,
} from "../indicatorWsRuntime.js";

test("indicator.recomputed dispatches a targeted range refresh notification", () => {
  const calls = [];

  const handled = dispatchIndicatorWsMessage({
    type: "indicator.recomputed",
    clientId: "ma-1",
    range: { start: 10, end: 30 },
    timestampMs: 123,
  }, {
    onRecomputed: (indicatorId, payload) => calls.push({ indicatorId, payload }),
  });

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].indicatorId, "ma-1");
  assert.deepEqual(calls[0].payload.range, { start: 10, end: 30 });
});

test("indicator value dispatch distinguishes preview from final update", () => {
  const calls = [];
  const handlers = {
    onValues: (indicatorId, values, barTime, isFinal) => {
      calls.push({ indicatorId, values, barTime, isFinal });
    },
  };

  assert.equal(dispatchIndicatorWsMessage({
    type: "indicator.preview",
    clientId: "ma-1",
    values: { ma: 10 },
    barTime: 100,
  }, handlers), true);
  assert.equal(dispatchIndicatorWsMessage({
    type: "indicator.update",
    clientId: "ma-1",
    values: { ma: 11 },
    barTime: 160,
  }, handlers), true);

  assert.deepEqual(calls, [
    { indicatorId: "ma-1", values: { ma: 10 }, barTime: 100, isFinal: false },
    { indicatorId: "ma-1", values: { ma: 11 }, barTime: 160, isFinal: true },
  ]);
});

test("subscription resume metadata is sent only when a cached checkpoint exists", () => {
  const baseContext = {
    candleDownColor: "#f00",
    candleUpColor: "#0f0",
    chartDataLength: 100,
    exchange: "binance",
    interval: "1m",
    marketType: "spot",
    symbol: "BTCUSDT",
  };
  const indicator = { id: "vol", engineName: "VOL", params: {} };
  const cold = buildHostedSubscriptionMessage(indicator, baseContext);
  assert.equal("resumeFrom" in cold, false);

  const warm = buildHostedSubscriptionMessage(indicator, {
    ...baseContext,
    resumeFrom: 1_700_000_000,
    serverEpoch: "boot-1",
    correctionRevision: 7,
  });
  assert.equal(warm.resumeFrom, 1_700_000_000);
  assert.equal(warm.serverEpoch, "boot-1");
  assert.equal(warm.correctionRevision, "7");
});

test("indicator.subscribed dispatches revision and resume acknowledgement", () => {
  const calls = [];
  assert.equal(dispatchIndicatorWsMessage({
    type: "indicator.subscribed",
    clientId: "ma-1",
    resumeStatus: "up_to_date",
    dataRevision: { correctionRevision: 3 },
  }, {
    onSubscribed: (indicatorId, payload) => calls.push({ indicatorId, payload }),
  }), true);
  assert.equal(calls[0].indicatorId, "ma-1");
  assert.equal(calls[0].payload.resumeStatus, "up_to_date");
});
