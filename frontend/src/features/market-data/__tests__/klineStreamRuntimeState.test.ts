import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeKlineStreamInterval,
  createKlineStreamAcknowledgementState,
  getKlineStreamIntervalStatus,
  reduceKlineStreamControlMessage,
  retainTrackedKlineStreamRejections,
} from "../useKlineStreamRuntime.js";

test("socket open remains connecting until the current interval is acknowledged", () => {
  const state = createKlineStreamAcknowledgementState();

  assert.equal(getKlineStreamIntervalStatus(state, "1m"), "connecting");
});

test("mixed subscription ACK activates only accepted intervals and rejects failures", () => {
  const state = reduceKlineStreamControlMessage(
    createKlineStreamAcknowledgementState(),
    {
      type: "subscribed",
      request_id: "request-1",
      requested_intervals: ["1m", "7s"],
      intervals: ["1m"],
      failed: [{ interval: "7s", code: "unsupported_interval" }],
      active_intervals: ["1m"],
    },
  );

  assert.deepEqual(state.activeIntervals, ["1m"]);
  assert.deepEqual(state.rejectedIntervals, ["7s"]);
  assert.equal(getKlineStreamIntervalStatus(state, "1m"), "live");
  assert.equal(getKlineStreamIntervalStatus(state, "7s"), "fallback");
});

test("a first valid current-interval kline confirms legacy backends", () => {
  const state = acknowledgeKlineStreamInterval(
    createKlineStreamAcknowledgementState(),
    "47m",
  );

  assert.equal(getKlineStreamIntervalStatus(state, "47m"), "live");
});

test("ACK state treats fixed-duration aliases as the same interval", () => {
  const state = reduceKlineStreamControlMessage(
    createKlineStreamAcknowledgementState(),
    {
      type: "subscribed",
      requested_intervals: ["60m"],
      intervals: ["1h"],
      failed: [],
      active_intervals: ["1h"],
    },
  );

  assert.equal(getKlineStreamIntervalStatus(state, "60m"), "live");
});

test("unsubscribed current intervals wait for a new ACK and removed failures can retry", () => {
  const rejected = reduceKlineStreamControlMessage(
    createKlineStreamAcknowledgementState(),
    {
      type: "subscribed",
      requested_intervals: ["7s"],
      intervals: [],
      failed: [{ interval: "7s" }],
      active_intervals: [],
    },
  );
  const removed = retainTrackedKlineStreamRejections(rejected, ["1m"]);
  assert.equal(getKlineStreamIntervalStatus(removed, "7s"), "connecting");

  const live = reduceKlineStreamControlMessage(
    createKlineStreamAcknowledgementState(),
    { type: "subscribed", intervals: ["1m"], active_intervals: ["1m"] },
  );
  const unsubscribed = reduceKlineStreamControlMessage(live, {
    type: "unsubscribed",
    intervals: ["1m"],
    active_intervals: [],
  });
  assert.equal(getKlineStreamIntervalStatus(unsubscribed, "1m"), "connecting");
});
