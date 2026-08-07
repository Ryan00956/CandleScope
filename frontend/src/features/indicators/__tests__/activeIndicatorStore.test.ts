import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcilePersistedIndicatorDefinitions,
} from "../activeIndicatorStore.js";

test("unchanged durable indicator definitions retain live runtime fields", () => {
  const current = [{
    id: "ma",
    name: "MA",
    params: { period: 20 },
    lines: [{ name: "MA", data: [{ time: 1, value: 2 }] }],
  }];
  const reconciled = reconcilePersistedIndicatorDefinitions(current, [{
    id: "ma",
    name: "MA",
    params: { period: 20 },
  }]);
  assert.equal(reconciled, current);
});

test("an external durable edit replaces stale live indicator definitions", () => {
  const current = [{ id: "ma", name: "MA", params: { period: 20 } }];
  const persisted = [
    { id: "ma", name: "MA", params: { period: 50 } },
    { id: "rsi", name: "RSI", params: { period: 14 } },
  ];
  const reconciled = reconcilePersistedIndicatorDefinitions(current, persisted);
  assert.deepEqual(reconciled, persisted);
  assert.notEqual(reconciled, persisted);
});
