import assert from "node:assert/strict";
import test from "node:test";

import {
  applyActiveIndicatorUpdate,
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

test("controlled runtime line updates stay live without becoming workspace edits", () => {
  const current = [{
    id: "boll",
    name: "BOLL",
    params: { period: 20 },
    lines: [],
  }];
  const line = { name: "Middle", data: [{ time: 1, value: 100 }] };
  const update = applyActiveIndicatorUpdate(current, (indicators) => indicators.map((indicator) => ({
    ...indicator,
    lines: [line],
  })));

  assert.equal(update.durableChanged, false);
  assert.deepEqual(update.indicators[0]?.lines, [line]);
  assert.notEqual(update.indicators, current);
});

test("controlled definition edits are marked for workspace persistence", () => {
  const current = [{ id: "ma", name: "MA", params: { period: 20 }, lines: [] }];
  const update = applyActiveIndicatorUpdate(current, (indicators) => indicators.map((indicator) => ({
    ...indicator,
    params: { period: 50 },
  })));

  assert.equal(update.durableChanged, true);
  assert.deepEqual(update.indicators[0]?.params, { period: 50 });
});
