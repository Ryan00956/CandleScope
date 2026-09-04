import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChartSessionKey,
  CHART_SESSION_TRANSITION_TYPES,
  createChartSessionTransition,
  decideControlledSessionApply,
} from "../chartSessionTransition.js";

test("session transitions retain complete from/to identities and stable keys", () => {
  const from = {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1h",
  };
  const to = { ...from, interval: "15m" };
  const transition = createChartSessionTransition({
    id: 7,
    type: CHART_SESSION_TRANSITION_TYPES.INTERVAL_CHANGE,
    from,
    to,
  });

  assert.equal(buildChartSessionKey(from), "binance:spot:BTCUSDT:1h");
  assert.equal(transition.fromSessionKey, "binance:spot:BTCUSDT:1h");
  assert.equal(transition.sessionKey, "binance:spot:BTCUSDT:15m");
  assert.equal(transition.id, 7);
  assert.ok(Number.isFinite(transition.createdAt));
});

test("controlled session echoes hold intermediate keys while local edits are unacked", () => {
  assert.equal(decideControlledSessionApply("A", "A", "A"), "ack");
  assert.equal(decideControlledSessionApply("B", "C", "A"), "hold");
  assert.equal(decideControlledSessionApply("C", "C", "A"), "ack");
  assert.equal(decideControlledSessionApply("D", "A", "A"), "apply");
  assert.equal(decideControlledSessionApply("B", "B", null), "ack");
  assert.equal(decideControlledSessionApply("B", "A", null), "apply");
});
