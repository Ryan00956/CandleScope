import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCurrentHostedIndicatorSignatures,
  isCurrentHostedIndicatorMessage,
} from "../indicatorStreamIdentity.js";
import type {
  IndicatorDefinition,
  IndicatorWsMessage,
} from "../indicatorTypes.js";

const context = {
  candleDownColor: "#ef4444",
  candleUpColor: "#22c55e",
  exchange: "binance",
  interval: "1h",
  marketType: "spot",
  symbol: "BTCUSDT",
};

function hostedIndicator(overrides: Partial<IndicatorDefinition> = {}): IndicatorDefinition {
  return {
    id: "hosted-1",
    engineName: "SMA",
    params: { length: 20 },
    visible: true,
    ...overrides,
  };
}

function clientMessage(type: IndicatorWsMessage["type"]): IndicatorWsMessage {
  return { type, clientId: "hosted-1" } as IndicatorWsMessage;
}

test("all client-scoped frames share one fail-closed committed configuration gate", () => {
  const signatures = buildCurrentHostedIndicatorSignatures([hostedIndicator()], context);
  const signature = signatures.get("hosted-1");
  assert.ok(signature);

  for (const type of [
    "indicator.subscribed",
    "indicator.snapshot",
    "indicator.patch",
    "indicator.replace_range",
    "indicator.recomputed",
    "indicator.error",
    "indicator.preview",
    "indicator.update",
  ] as const) {
    const message = clientMessage(type);
    assert.equal(isCurrentHostedIndicatorMessage(message, signature, signatures), true, type);
    assert.equal(isCurrentHostedIndicatorMessage(message, undefined, signatures), false, type);
    assert.equal(isCurrentHostedIndicatorMessage(message, `${signature}:stale`, signatures), false, type);
  }
});

test("removed, hidden, and unknown clients cannot inherit the current identity", () => {
  const current = buildCurrentHostedIndicatorSignatures([
    hostedIndicator({ visible: false }),
  ], context);
  assert.equal(current.has("hosted-1"), false);
  assert.equal(
    isCurrentHostedIndicatorMessage(clientMessage("indicator.snapshot"), "old", current),
    false,
  );
  assert.equal(
    isCurrentHostedIndicatorMessage(
      { type: "heartbeat" },
      "old",
      new Map([["hosted-1", "old"]]),
    ),
    false,
  );
});

test("semantic indicator and market context changes invalidate the old wire identity", () => {
  const original = buildCurrentHostedIndicatorSignatures([hostedIndicator()], context)
    .get("hosted-1");
  assert.ok(original);

  const variants: Array<{
    indicator?: IndicatorDefinition;
    context?: typeof context;
  }> = [
    { indicator: hostedIndicator({ params: { length: 50 } }) },
    { indicator: hostedIndicator({ engineName: "EMA" }) },
    {
      indicator: hostedIndicator({
        engineName: null,
        kind: "script",
        script: "plot(close)",
      }),
    },
    {
      indicator: hostedIndicator({
        engineName: null,
        kind: "script",
        script: "plot(open)",
        securityMode: "strict",
      }),
    },
    {
      indicator: hostedIndicator({
        engineName: null,
        kind: "script",
        script: "plot(close)",
        language: "community-lang",
      }),
    },
    { context: { ...context, symbol: "ETHUSDT" } },
    { context: { ...context, interval: "4h" } },
  ];

  for (const variant of variants) {
    const next = buildCurrentHostedIndicatorSignatures(
      [variant.indicator ?? hostedIndicator()],
      variant.context ?? context,
    ).get("hosted-1");
    assert.ok(next);
    assert.notEqual(next, original);
  }

  const volumeOriginal = buildCurrentHostedIndicatorSignatures([
    hostedIndicator({ engineName: "VOL" }),
  ], context).get("hosted-1");
  const volumeRecolored = buildCurrentHostedIndicatorSignatures([
    hostedIndicator({ engineName: "VOL" }),
  ], { ...context, candleUpColor: "#00ff00" }).get("hosted-1");
  assert.ok(volumeOriginal);
  assert.ok(volumeRecolored);
  assert.notEqual(volumeRecolored, volumeOriginal);
});

test("transport generations do not change an otherwise identical configuration identity", () => {
  const signatures = buildCurrentHostedIndicatorSignatures([hostedIndicator()], context);
  const signature = signatures.get("hosted-1");
  assert.ok(signature);
  const message = clientMessage("indicator.snapshot");
  assert.equal(isCurrentHostedIndicatorMessage(message, signature, signatures), true);
  assert.equal(isCurrentHostedIndicatorMessage(message, signature, signatures), true);
});
