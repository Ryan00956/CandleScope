import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_EXPRESSION_MAX_DEPTH,
  AlertPayloadError,
  parseAlertExpression,
} from "../alertTypes.js";
import {
  buildAlertPayloadFromDraft,
  createDefaultAlertDraft,
  createDraftFromRule,
  describeExpression,
} from "../alertRuleModel.js";
import {
  deleteAlertRule,
  fetchAlertRules,
  setAlertRuleEnabled,
} from "../../../services/alertsApi.js";

function condition() {
  return {
    left: "close",
    comparator: "crossesAbove",
    right: { type: "number", value: 68000 },
  };
}

function rule(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "alert-1",
    name: "BTC break",
    description: "",
    enabled: true,
    target: {
      exchange: "binance",
      marketType: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
    },
    triggerOn: "bar_close",
    expression: condition(),
    actions: [{ type: "in_app", enabled: true, config: { template: "hit" } }],
    cooldownMs: 30000,
    expiresAt: null,
    maxTriggers: 1,
    tags: ["frontend-editor"],
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function withFetch(responses, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, options) => {
      calls.push({ url, options });
      const payload = responses.shift();
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      };
    },
  });
  try {
    return await run(calls);
  } finally {
    if (previous) Object.defineProperty(globalThis, "fetch", previous);
    else delete globalThis.fetch;
  }
}

test("alert expression parser accepts a valid recursive tree", () => {
  const expression = {
    op: "AND",
    children: [
      condition(),
      { op: "NOT", children: [{ ...condition(), comparator: "<" }] },
    ],
  };
  assert.deepEqual(parseAlertExpression(expression), expression);
  assert.match(describeExpression(expression), /且/);
});

test("alert expression parser fails closed for malformed, cyclic, and overly deep trees", () => {
  assert.throws(
    () => parseAlertExpression({ op: "NOT", children: [condition(), condition()] }),
    AlertPayloadError,
  );

  const cyclic = { op: "AND", children: [] };
  cyclic.children.push(cyclic);
  assert.throws(() => parseAlertExpression(cyclic), /cyclic expression/);

  let deep = condition();
  for (let index = 0; index <= ALERT_EXPRESSION_MAX_DEPTH; index += 1) {
    deep = { op: "NOT", children: [deep] };
  }
  assert.throws(() => parseAlertExpression(deep), /exceeds/);
  assert.equal(describeExpression({ op: "AND", children: [] }), "未配置触发条件");
});

test("alert model preserves the backend expression contract and falls back from bad rule data", () => {
  const draft = createDefaultAlertDraft({ symbol: "BTCUSDT", price: 68000 });
  const payload = buildAlertPayloadFromDraft({
    draft,
    fallbackSymbol: "BTCUSDT",
    fallbackMarketType: "spot",
    fallbackExchange: "binance",
    interval: "1m",
  });
  assert.equal(payload.expression.op, "AND");
  assert.equal(payload.target.symbol, "BTCUSDT");

  const restored = createDraftFromRule(rule({ expression: { op: "NOT", children: [] } }));
  assert.equal(restored.expression.type, "group");
  assert.equal(restored.messageTemplate, "hit");
});

test("alerts API validates unknown responses and types enabled/delete contracts", async () => {
  await withFetch([[rule({ expression: { op: "AND", children: [] } })]], async () => {
    await assert.rejects(() => fetchAlertRules(), AlertPayloadError);
  });

  await withFetch([rule({ enabled: false }), { ok: true, id: "alert-1" }], async (calls) => {
    const updated = await setAlertRuleEnabled("alert-1", false);
    const deleted = await deleteAlertRule("alert-1");
    assert.equal(updated.enabled, false);
    assert.deepEqual(deleted, { ok: true, id: "alert-1" });
    assert.equal(calls[0].options.method, "PATCH");
    assert.equal(calls[0].options.body, JSON.stringify({ enabled: false }));
    assert.equal(calls[1].options.method, "DELETE");
  });
});
