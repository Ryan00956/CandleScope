import assert from "node:assert/strict";
import test from "node:test";

import { dispatchIndicatorWsMessage } from "../indicatorWsRuntime.js";

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
