import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostedSubscriptionMessage,
  dispatchIndicatorWsMessage,
  parseIndicatorWsMessage,
  resolveIndicatorSubscriptionCachePolicy,
} from "../indicatorWsRuntime.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

type WsHandlers = NonNullable<Parameters<typeof dispatchIndicatorWsMessage>[1]>;

test("indicator.recomputed dispatches a targeted range refresh notification", () => {
  const calls: Array<{ indicatorId: string; payload: unknown }> = [];
  const onRecomputed: NonNullable<WsHandlers["onRecomputed"]> = (indicatorId, payload) => {
    calls.push({ indicatorId, payload });
  };

  const handled = dispatchIndicatorWsMessage({
    type: "indicator.recomputed",
    clientId: "ma-1",
    range: { start: 10, end: 30 },
    timestampMs: 123,
  }, {
    onRecomputed,
  });

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(mustBeDefined(calls[0]).indicatorId, "ma-1");
  assert.deepEqual(
    malformedFixture<{ range: unknown }>(mustBeDefined(calls[0]).payload).range,
    { start: 10, end: 30 },
  );
});

test("indicator value dispatch distinguishes preview from final update", () => {
  const calls: Array<{
    indicatorId: string;
    values: unknown;
    barTime: number;
    isFinal: boolean;
    sourceSubscriptionSignature: string | undefined;
  }> = [];
  const handlers: WsHandlers = {
    onValues: (
      indicatorId,
      values,
      barTime,
      isFinal,
      _message,
      sourceSubscriptionSignature,
    ) => {
      calls.push({
        indicatorId,
        values,
        barTime,
        isFinal,
        sourceSubscriptionSignature,
      });
    },
  };

  assert.equal(dispatchIndicatorWsMessage({
    type: "indicator.preview",
    clientId: "ma-1",
    values: { ma: 10 },
    barTime: 100,
  }, handlers, "config-a"), true);
  assert.equal(dispatchIndicatorWsMessage({
    type: "indicator.update",
    clientId: "ma-1",
    values: { ma: 11 },
    barTime: 160,
  }, handlers, "config-b"), true);

  assert.deepEqual(calls, [
    {
      indicatorId: "ma-1",
      values: { ma: 10 },
      barTime: 100,
      isFinal: false,
      sourceSubscriptionSignature: "config-a",
    },
    {
      indicatorId: "ma-1",
      values: { ma: 11 },
      barTime: 160,
      isFinal: true,
      sourceSubscriptionSignature: "config-b",
    },
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
  const calls: Array<{ indicatorId: string; payload: unknown }> = [];
  const onSubscribed: NonNullable<WsHandlers["onSubscribed"]> = (indicatorId, payload) => {
    calls.push({ indicatorId, payload });
  };
  assert.equal(dispatchIndicatorWsMessage(malformedFixture<
    Parameters<typeof dispatchIndicatorWsMessage>[0]
  >({
    type: "indicator.subscribed",
    clientId: "ma-1",
    resumeStatus: "up_to_date",
    dataRevision: { correctionRevision: 3 },
  }), {
    onSubscribed,
  }), true);
  assert.equal(mustBeDefined(calls[0]).indicatorId, "ma-1");
  assert.equal(
    malformedFixture<{ resumeStatus: unknown }>(mustBeDefined(calls[0]).payload).resumeStatus,
    "up_to_date",
  );
});

test("indicator.subscribed parses a terminal failed realtime acknowledgement", () => {
  const parsed = parseIndicatorWsMessage(JSON.stringify({
    type: "indicator.subscribed",
    clientId: "ma-1",
    ok: false,
    interval: "1h",
    requestedInterval: "60m",
    canonicalInterval: "1h",
    subscriptionStatus: "failed",
    realtimeStatus: "unavailable",
    code: "INDICATOR_STREAM_SUBSCRIPTION_FAILED",
    error: "Realtime indicator stream is unavailable for interval 1h.",
    failure: {
      interval: "1h",
      code: "INDICATOR_STREAM_SUBSCRIPTION_FAILED",
      message: "Realtime indicator stream is unavailable for interval 1h.",
    },
    errorDetail: {
      message: "Realtime indicator stream is unavailable for interval 1h.",
      hint: "Use HTTP history.",
    },
  }));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.message.type, "indicator.subscribed");
  if (parsed.message.type !== "indicator.subscribed") return;
  assert.equal(parsed.message.subscriptionStatus, "failed");
  assert.equal(parsed.message.requestedInterval, "60m");
  assert.equal(parsed.message.canonicalInterval, "1h");
  assert.equal(parsed.message.failure?.code, "INDICATOR_STREAM_SUBSCRIPTION_FAILED");
  assert.equal(parsed.message.errorDetail?.hint, "Use HTTP history.");
});

test("history-required preserves compatible cache unless revision data invalidates it", () => {
  const compatible = resolveIndicatorSubscriptionCachePolicy({
    resumeStatus: "history_required",
    resumeReason: "resume-gap-too-large",
    dataRevision: {
      serverEpoch: "boot-1",
      correctionRevision: 4,
      closedThrough: 1_700_000_000,
    },
  });
  assert.equal(compatible.invalidate, false);
  assert.equal(compatible.historyInvalid, false);
  assert.equal(compatible.dirtyRange, null);

  const expired = resolveIndicatorSubscriptionCachePolicy({
    resumeStatus: "history_required",
    dataRevision: {
      serverEpoch: "boot-2",
      correctionRevision: 0,
      historyInvalid: true,
    },
  });
  assert.equal(expired.invalidate, true);

  const dirty = resolveIndicatorSubscriptionCachePolicy({
    resumeStatus: "history_required",
    dataRevision: {
      serverEpoch: "boot-1",
      correctionRevision: 5,
      dirtyRange: { start: 100, end: 200 },
    },
  });
  assert.equal(dirty.invalidate, true);
  assert.deepEqual(dirty.dirtyRange, { start: 100, end: 200 });
});

test("WebSocket parser returns a typed patch message", () => {
  const parsed = parseIndicatorWsMessage(JSON.stringify({
    type: "indicator.patch",
    clientId: "ma-1",
    seq: 8,
    range: { start: 100, end: 200 },
    dataRevision: { serverEpoch: "boot-1", correctionRevision: 3 },
    lines: [{ outputName: "ma", data: [{ time: 100, value: 10 }] }],
  }));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) assert.fail("Expected typed patch message");
  assert.equal(parsed.message.type, "indicator.patch");
  assert.equal(parsed.message.seq, 8);
  assert.equal(mustBeDefined(parsed.message.dataRevision).correctionRevision, "3");
  assert.deepEqual(parsed.message.range, { start: 100, end: 200 });
});

test("WebSocket parser preserves the OHLC bar used for realtime indicator values", () => {
  const parsed = parseIndicatorWsMessage(JSON.stringify({
    type: "indicator.preview",
    clientId: "vol",
    values: { vol: 25 },
    barTime: 100,
    bar: {
      time: 100,
      open: 12,
      high: 13,
      low: 8,
      close: 9,
      volume: 25,
    },
  }));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) assert.fail("Expected typed realtime values message");
  assert.equal(parsed.message.type, "indicator.preview");
  if (parsed.message.type !== "indicator.preview") assert.fail("Expected preview message");
  assert.equal(parsed.message.bar?.close, 9);
  assert.equal(parsed.message.bar?.open, 12);
});

test("WebSocket parser rejects malformed snapshot, patch, and replace-range messages", () => {
  const malformed = [
    { type: "indicator.snapshot", lines: [] },
    { type: "indicator.patch", clientId: "ma-1", range: { start: 200, end: 100 } },
    {
      type: "indicator.replace_range",
      clientId: "ma-1",
      range: { start: 100, end: 200 },
      lines: [{ data: [{ time: 100, value: "bad" }] }],
    },
  ];

  for (const message of malformed) {
    const parsed = parseIndicatorWsMessage(JSON.stringify(message));
    assert.equal(parsed.ok, false);
    if ("error" in parsed) {
      assert.match(parsed.error.message, /Invalid indicator payload/);
    } else {
      assert.fail("Expected malformed payload to be rejected");
    }
  }
});
