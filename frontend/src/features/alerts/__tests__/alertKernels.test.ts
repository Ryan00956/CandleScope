import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_EXPRESSION_MAX_DEPTH,
  ALERT_EXPRESSION_MAX_NODES,
  AlertPayloadError,
  parseAlertNotificationMessage,
  parseAlertExpression,
  parseAlertSystemStatus,
} from "../alertTypes.js";
import { deliverAlertNotification } from "../alertDeliveryClient.js";
import {
  buildAlertPayloadFromDraft,
  createDefaultAlertDraft,
  createDraftFromRule,
  describeAlertDraftExpression,
  describeExpression,
} from "../alertRuleModel.js";
import {
  deleteAlertRule,
  fetchAlertRules,
  setAlertRuleEnabled,
} from "../../../services/alertsApi.js";
import type {
  AlertConditionExpression,
  AlertExpression,
  AlertRule,
} from "../alertTypes.js";
import {
  malformedFixture,
  mustBeDefined,
} from "../../../test/testHelpers.js";

function condition(): AlertConditionExpression {
  return {
    left: "close",
    comparator: "crossesAbove",
    right: { type: "number", value: 68000 },
  };
}

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
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
    afterTrigger: "auto_disable",
    tags: ["frontend-editor"],
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface FetchCall {
  url: string | URL | Request;
  options?: RequestInit;
}

async function withFetch<T>(
  responses: unknown[],
  run: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const calls: FetchCall[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({
        url,
        ...(options === undefined ? {} : { options }),
      });
      const payload = responses.shift();
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    return await run(calls);
  } finally {
    if (previous) Object.defineProperty(globalThis, "fetch", previous);
    else Reflect.deleteProperty(globalThis, "fetch");
  }
}

test("alert expression parser accepts a valid recursive tree", () => {
  const expression: AlertExpression = {
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

  const cyclic: { op: string; children: unknown[] } = { op: "AND", children: [] };
  cyclic.children.push(cyclic);
  assert.throws(() => parseAlertExpression(cyclic), /cyclic expression/);

  let deep: unknown = condition();
  for (let index = 0; index <= ALERT_EXPRESSION_MAX_DEPTH; index += 1) {
    deep = { op: "NOT", children: [deep] };
  }
  assert.throws(() => parseAlertExpression(deep), /exceeds/);
  assert.throws(
    () => parseAlertExpression({
      op: "AND",
      children: Array.from({ length: ALERT_EXPRESSION_MAX_NODES }, condition),
    }),
    /exceeds/,
  );
  assert.throws(
    () => parseAlertExpression({
      left: "close",
      comparator: "between",
      right: { type: "range", min: 2, max: 1 },
    }),
    /minimum exceeds maximum/,
  );
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
  assert.ok("op" in payload.expression);
  assert.equal(payload.expression.op, "AND");
  assert.equal(payload.target.symbol, "BTCUSDT");
  assert.equal(payload.afterTrigger, "auto_disable");
  assert.equal("op" in payload.expression ? payload.expression.children.length : 0, 1);
  assert.match(describeAlertDraftExpression(draft.expression), /收盘价 上穿 68000/);

  const restored = createDraftFromRule(malformedFixture<AlertRule>({
    ...rule(),
    expression: { op: "NOT", children: [] },
  }));
  assert.equal(restored.expression.type, "group");
  assert.equal(restored.messageTemplate, "hit");
});

test("alerts API validates unknown responses and types enabled/delete contracts", async () => {
  await withFetch([[{ ...rule(), expression: { op: "AND", children: [] } }]], async () => {
    await assert.rejects(() => fetchAlertRules(), AlertPayloadError);
  });

  await withFetch([rule({ enabled: false }), { ok: true, id: "alert-1" }], async (calls) => {
    const updated = await setAlertRuleEnabled("alert-1", false);
    const deleted = await deleteAlertRule("alert-1");
    assert.equal(updated.enabled, false);
    assert.deepEqual(deleted, { ok: true, id: "alert-1" });
    assert.equal(mustBeDefined(calls[0]).options?.method, "PATCH");
    assert.equal(mustBeDefined(calls[0]).options?.body, JSON.stringify({ enabled: false }));
    assert.equal(mustBeDefined(calls[1]).options?.method, "DELETE");
  });
});

test("alert runtime status parser preserves per-rule readiness", () => {
  const parsed = parseAlertSystemStatus({
    registeredChannels: ["in_app"],
    notificationBroker: {
      subscribers: 1,
      queueSize: 0,
      published: 2,
      dropped: 0,
    },
    runtime: {
      started: true,
      dataManager: true,
      status: "running",
      subscriptions: [{
        ruleId: "alert-1",
        target: { symbol: "BTCUSDT", interval: "1m" },
      }],
      rules: [{
        ruleId: "alert-1",
        state: "warming",
        enabled: true,
        subscribed: true,
        requiredFields: ["rsi"],
        indicatorReady: { rsi: false, ma20: true },
        historyBars: 10,
        lastEvaluatedAt: null,
        lastEventType: null,
        lastError: null,
      }],
    },
  });

  assert.equal(parsed.runtime.rules[0]?.state, "warming");
  assert.equal(parsed.runtime.rules[0]?.indicatorReady.rsi, false);
  assert.equal(parsed.runtime.rules[0]?.historyBars, 10);
});

test("alert notification parser and in-app delivery fail closed", async () => {
  const notification = parseAlertNotificationMessage({
    schemaVersion: 1,
    dispatchId: "dispatch-1",
    eventId: "event-1",
    ruleId: "alert-1",
    action: { type: "in_app", config: {} },
    message: "BTC hit",
    target: { symbol: "BTCUSDT" },
    values: { close: 100 },
    createdAt: 1,
  });
  const delivered: string[] = [];

  const receipt = await deliverAlertNotification(notification, (item) => delivered.push(item.dispatchId));

  assert.deepEqual(receipt, { status: "delivered", detail: "toast_rendered" });
  assert.deepEqual(delivered, ["dispatch-1"]);
  assert.throws(
    () => parseAlertNotificationMessage({ ...notification, action: { type: "email", config: {} } }),
    AlertPayloadError,
  );
});
