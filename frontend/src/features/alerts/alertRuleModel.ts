import type {
  AlertAction,
  AlertChannelState,
  AlertConditionDraft,
  AlertDefaultPayloadInput,
  AlertDraft,
  AlertExpression,
  AlertExpressionDraft,
  AlertExpressionDraftAction,
  AlertGroupDraft,
  AlertLogicalOperator,
  AlertPayloadBuildInput,
  AlertRight,
  AlertRule,
  AlertRulePayload,
  AlertHistoryEvent,
} from "./alertTypes.js";
import { parseAlertExpression } from "./alertTypes.js";
import { getLocale, t, type MessageKey } from "../../i18n/index.js";

let nodeCounter = 0;

function createNodeId(prefix = "alert-node"): string {
  nodeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nodeCounter.toString(36)}`;
}

const SOURCE_FIXED_LABELS: Record<string, string> = {
  rsi: "RSI(14)",
  macdHist: "MACD Histogram",
  ma20: "MA(20)",
};

const SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  close: "alert.field.close",
  last: "alert.field.last",
  open: "alert.field.open",
  high: "alert.field.high",
  low: "alert.field.low",
  volume: "alert.field.volume",
};

export const ALERT_SOURCE_OPTIONS = [
  { value: "close" },
  { value: "last" },
  { value: "open" },
  { value: "high" },
  { value: "low" },
  { value: "volume" },
  { value: "rsi" },
  { value: "macdHist" },
  { value: "ma20" },
] as const;

const COMPARATOR_LABEL_KEYS: Record<string, MessageKey> = {
  crossesAbove: "alert.cmp.crossesAbove",
  crossesBelow: "alert.cmp.crossesBelow",
  ">": "alert.cmp.gt",
  "<": "alert.cmp.lt",
  ">=": "alert.cmp.gte",
  "<=": "alert.cmp.lte",
  "==": "alert.cmp.eq",
  "!=": "alert.cmp.neq",
  between: "alert.cmp.between",
  outsideRange: "alert.cmp.outside",
  percentChangeAbove: "alert.cmp.pctAbove",
  percentChangeBelow: "alert.cmp.pctBelow",
};

export const ALERT_COMPARATOR_OPTIONS = [
  { value: "crossesAbove" },
  { value: "crossesBelow" },
  { value: ">" },
  { value: "<" },
  { value: ">=" },
  { value: "<=" },
  { value: "==" },
  { value: "!=" },
  { value: "between" },
  { value: "outsideRange" },
  { value: "percentChangeAbove" },
  { value: "percentChangeBelow" },
] as const;

const RIGHT_TYPE_LABEL_KEYS: Record<string, MessageKey> = {
  number: "alert.rightKind.number",
  field: "alert.rightKind.field",
  indicator: "alert.rightKind.indicator",
};

export const ALERT_RIGHT_TYPE_OPTIONS = [
  { value: "number" },
  { value: "field" },
  { value: "indicator" },
] as const;

export function labelForSource(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  const messageKey = SOURCE_LABEL_KEYS[key];
  if (messageKey) return t(messageKey);
  return SOURCE_FIXED_LABELS[key] || key || "?";
}

export function labelForComparator(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  const messageKey = COMPARATOR_LABEL_KEYS[key];
  return messageKey ? t(messageKey) : (key || "?");
}

export function labelForRightType(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  const messageKey = RIGHT_TYPE_LABEL_KEYS[key];
  return messageKey ? t(messageKey) : (key || "?");
}
const RANGE_COMPARATORS = new Set(["between", "outsideRange"]);
const PERCENT_CHANGE_COMPARATORS = new Set(["percentChangeAbove", "percentChangeBelow"]);

export function createConditionNode(overrides: Partial<AlertConditionDraft> = {}): AlertConditionDraft {
  return {
    id: createNodeId("condition"),
    type: "condition",
    not: false,
    left: "close",
    comparator: "crossesAbove",
    rightType: "number",
    rightValue: "",
    rangeMin: "",
    rangeMax: "",
    percentValue: "",
    ...overrides,
  };
}

export function createGroupNode(overrides: Partial<AlertGroupDraft> = {}): AlertGroupDraft {
  return {
    id: createNodeId("group"),
    type: "group",
    op: "AND",
    not: false,
    children: [],
    ...overrides,
  };
}

export function createDefaultExpressionDraft(price?: unknown): AlertGroupDraft {
  const threshold = Number(price);
  return createGroupNode({
    op: "AND",
    children: [
      createConditionNode({
        left: "close",
        comparator: "crossesAbove",
        rightType: "number",
        rightValue: Number.isFinite(threshold) ? String(threshold) : "",
      }),
    ],
  });
}

export function createDefaultAlertDraft({
  symbol = "",
  price,
}: { symbol?: string; interval?: string; price?: unknown } = {}): AlertDraft {
  return {
    name: t("alert.defaultName", { symbol: symbol || t("alert.unnamedSymbol") }),
    description: t("alert.defaultDesc"),
    enabled: true,
    triggerOn: "bar_close",
    expression: createDefaultExpressionDraft(price),
    maxTriggerMode: "once",
    customMaxTriggers: 5,
    expiresMode: "never",
    customExpiresAt: "",
    afterTrigger: "auto-disable",
    cooldownMode: "30s",
    customCooldownSeconds: 60,
    messageTemplate: t("alert.defaultTemplate"),
    webhookUrl: "",
    channels: {
      in_app: true,
      browser: false,
      sound: false,
      webhook: false,
      history: true,
    },
  };
}

export function expressionDraftReducer(
  node: AlertExpressionDraft,
  action: AlertExpressionDraftAction,
): AlertExpressionDraft {
  if (!node || !action) return node;
  switch (action.type) {
    case "update-node":
      return updateNode(node, action.nodeId, (target) => applyDraftPatch(target, action.patch));
    case "add-condition":
      return updateNode(node, action.nodeId, (target) => target.type === "group" ? ({
        ...target,
        children: [...target.children, createConditionNode(action.initial || {})],
      }) : target);
    case "add-group":
      return updateNode(node, action.nodeId, (target) => target.type === "group" ? ({
        ...target,
        children: [...target.children, createGroupNode({ op: "AND", children: [createConditionNode()] })],
      }) : target);
    case "delete-node":
      return deleteNode(node, action.nodeId) || node;
    case "duplicate-node": {
      const clone = findNode(node, action.nodeId);
      return clone ? appendSibling(node, action.nodeId, cloneExpressionDraftNode(clone)) : node;
    }
    default:
      return node;
  }
}

export function buildAlertPayloadFromDraft({
  draft,
  product,
  fallbackSymbol,
  fallbackMarketType,
  fallbackExchange,
  interval,
}: AlertPayloadBuildInput): AlertRulePayload {
  const symbol = product?.symbol || fallbackSymbol || "";
  const marketType = product?.marketType || fallbackMarketType || "spot";
  const exchange = product?.exchange || fallbackExchange || "binance";

  return {
    name: draft.name?.trim() || t("alert.defaultRuleName", { symbol: symbol || t("alert.unnamedSymbol") }),
    description: draft.description?.trim() || "",
    enabled: draft.enabled !== false,
    target: {
      exchange,
      marketType,
      symbol,
      interval: interval || "1m",
    },
    triggerOn: draft.triggerOn || "bar_close",
    expression: buildExpressionPayload(draft.expression),
    actions: buildActionsPayload(draft),
    cooldownMs: resolveCooldownMs(draft),
    expiresAt: resolveExpiresAt(draft.expiresMode, draft.customExpiresAt),
    maxTriggers: resolveMaxTriggers(draft),
    afterTrigger: normalizeAfterTrigger(draft.afterTrigger),
    tags: ["frontend-editor"],
  };
}

export function buildDefaultAlertRulePayload({
  product,
  fallbackSymbol,
  fallbackMarketType,
  fallbackExchange,
  interval,
  price,
}: AlertDefaultPayloadInput): AlertRulePayload {
  const defaultDraftInput = {
    ...(product?.symbol || fallbackSymbol
      ? { symbol: product?.symbol || fallbackSymbol }
      : {}),
    ...(interval === undefined ? {} : { interval }),
    ...(price === undefined ? {} : { price }),
  };
  return buildAlertPayloadFromDraft({
    draft: createDefaultAlertDraft(defaultDraftInput),
    ...(product === undefined ? {} : { product }),
    ...(fallbackSymbol === undefined ? {} : { fallbackSymbol }),
    ...(fallbackMarketType === undefined ? {} : { fallbackMarketType }),
    ...(fallbackExchange === undefined ? {} : { fallbackExchange }),
    ...(interval === undefined ? {} : { interval }),
  });
}

export function createDraftFromRule(rule: AlertRule): AlertDraft {
  const maxTriggers = Number(rule?.maxTriggers);
  const cooldownMs = Number(rule?.cooldownMs);
  return {
    name: rule?.name || "Untitled Alert",
    description: rule?.description || "",
    enabled: rule?.enabled !== false,
    triggerOn: rule?.triggerOn || "bar_close",
    expression: parseExpressionPayload(rule?.expression) || createDefaultExpressionDraft(),
    maxTriggerMode: rule?.maxTriggers == null ? "unlimited" : (maxTriggers === 1 ? "once" : (maxTriggers === 3 ? "3" : "custom")),
    customMaxTriggers: Number.isFinite(maxTriggers) && maxTriggers > 0 ? maxTriggers : 5,
    expiresMode: rule?.expiresAt ? "custom" : "never",
    customExpiresAt: rule?.expiresAt ? toDatetimeLocalValue(rule.expiresAt) : "",
    afterTrigger: rule?.afterTrigger === "keep"
      ? "keep"
      : (rule?.afterTrigger === "pause" ? "pause" : "auto-disable"),
    cooldownMode: cooldownMs === 0 ? "always" : (cooldownMs === 30_000 ? "30s" : (cooldownMs === 300_000 ? "5m" : "custom")),
    customCooldownSeconds: Number.isFinite(cooldownMs) && cooldownMs > 0 ? Math.round(cooldownMs / 1000) : 60,
    messageTemplate: messageTemplateFromActions(rule.actions)
      || t("alert.defaultTemplate"),
    webhookUrl: webhookUrlFromActions(rule.actions),
    channels: actionsToChannelState(rule?.actions),
  };
}

export function describeAlertRule(rule: AlertRule | null | undefined): string {
  const target = rule?.target;
  const interval = target?.interval || "--";
  return `${interval} ${describeExpression(rule?.expression)}`;
}

export function describeExpression(expression: AlertExpression | unknown): string {
  let parsed: AlertExpression;
  try {
    parsed = parseAlertExpression(expression);
  } catch {
    return t("alert.noCondition");
  }
  if ("op" in parsed) {
    if (parsed.op === "NOT") {
      return t("alert.notExpr", { expr: describeExpression(parsed.children[0]) });
    }
    const glue = parsed.op === "AND" ? t("alert.andGlue") : t("alert.orGlue");
    const text = parsed.children.map(describeExpression).filter(Boolean).join(glue);
    return parsed.children.length > 1 ? `(${text})` : text || t("alert.emptyGroup");
  }
  const left = labelForSource(parsed.left);
  const comparator = labelForComparator(parsed.comparator);
  const right = describeRight(parsed.right);
  return `${left} ${comparator} ${right}`;
}

export function describeAlertChannels(rule: AlertRule | null | undefined): string {
  const channels = (rule?.actions || [])
    .filter((action) => action.enabled !== false)
    .map((action) => {
      if (action.type === "in_app") return t("alert.channelShort.inApp");
      if (action.type === "browser") return t("alert.channelShort.browser");
      if (action.type === "sound") return t("alert.channelShort.sound");
      if (action.type === "webhook") return "Webhook";
      if (action.type === "telegram") return "Telegram";
      if (action.type === "email") return t("alert.channelShort.email");
      if (action.type === "trading_signal") return t("alert.channelShort.signal");
      return action.type;
    });
  return channels.length > 0 ? channels.join(" / ") : t("alert.noChannels");
}

export function formatAlertTime(timestampMs: unknown): string {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return "--";
  return new Date(ts).toLocaleString(getLocale());
}

function buildExpressionPayload(node: AlertExpressionDraft): AlertExpression {
  let payload: AlertExpression;
  if (node.type === "group") {
    payload = {
      op: node.op === "OR" ? "OR" : "AND",
      children: node.children.map(buildExpressionPayload),
    };
  } else {
    payload = {
      left: node.left || "close",
      comparator: node.comparator || ">",
      right: buildRightPayload(node),
    };
  }
  return node.not ? { op: "NOT", children: [payload] } : payload;
}

function buildRightPayload(node: AlertConditionDraft): AlertRight {
  if (RANGE_COMPARATORS.has(node.comparator)) {
    const min = Number(node.rangeMin);
    const max = Number(node.rangeMax);
    return {
      type: "range",
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
    };
  }
  if (PERCENT_CHANGE_COMPARATORS.has(node.comparator)) {
    const value = Number(node.percentValue);
    return {
      type: "percent",
      value: Number.isFinite(value) ? value : 0,
    };
  }
  const type = node.rightType;
  if (type === "number") {
    const value = Number(node.rightValue);
    return { type: "number", value: Number.isFinite(value) ? value : 0 };
  }
  return { type, value: node.rightValue || "close" };
}

function parseExpressionPayload(expression: unknown): AlertExpressionDraft | null {
  let parsed: AlertExpression;
  try {
    parsed = parseAlertExpression(expression);
  } catch {
    return null;
  }
  if ("op" in parsed) {
    if (parsed.op === "NOT") {
      const child = parseExpressionPayload(parsed.children[0]);
      return child ? { ...child, not: true } : null;
    }
    return createGroupNode({
      op: parsed.op,
      children: parsed.children.map(parseExpressionPayload).filter(isExpressionDraft),
    });
  }
  const right = parsed.right;
  const rightType = right.type === "field" || right.type === "indicator" ? right.type : "number";
  return createConditionNode({
    left: parsed.left,
    comparator: parsed.comparator,
    rightType,
    rightValue: "value" in right ? String(right.value) : "",
    rangeMin: right.type === "range" ? String(right.min) : "",
    rangeMax: right.type === "range" ? String(right.max) : "",
    percentValue: right.type === "percent" ? String(right.value) : "",
  });
}

function isExpressionDraft(value: AlertExpressionDraft | null): value is AlertExpressionDraft {
  return value !== null;
}

function messageTemplateFromActions(actions: AlertAction[]): string {
  for (const action of actions) {
    if (typeof action.config.template === "string") return action.config.template;
  }
  return "";
}

function webhookUrlFromActions(actions: AlertAction[]): string {
  for (const action of actions) {
    if (action.type === "webhook" && typeof action.config.url === "string") {
      return action.config.url;
    }
  }
  return "";
}

function applyDraftPatch(
  target: AlertExpressionDraft,
  patch: Partial<AlertExpressionDraft>,
): AlertExpressionDraft {
  if (target.type === "group") {
    const op = "op" in patch && (patch.op === "AND" || patch.op === "OR") ? patch.op : target.op;
    return {
      ...target,
      op,
      not: typeof patch.not === "boolean" ? patch.not : target.not,
    };
  }
  return {
    ...target,
    not: typeof patch.not === "boolean" ? patch.not : target.not,
    left: "left" in patch && typeof patch.left === "string" ? patch.left : target.left,
    comparator: "comparator" in patch && patch.comparator ? patch.comparator : target.comparator,
    rightType: "rightType" in patch && patch.rightType ? patch.rightType : target.rightType,
    rightValue: "rightValue" in patch && typeof patch.rightValue === "string" ? patch.rightValue : target.rightValue,
    rangeMin: "rangeMin" in patch && typeof patch.rangeMin === "string" ? patch.rangeMin : target.rangeMin,
    rangeMax: "rangeMax" in patch && typeof patch.rangeMax === "string" ? patch.rangeMax : target.rangeMax,
    percentValue: "percentValue" in patch && typeof patch.percentValue === "string"
      ? patch.percentValue
      : target.percentValue,
  };
}

function buildActionsPayload(draft: AlertDraft): AlertAction[] {
  const channels = draft.channels;
  return [
    { type: "in_app", enabled: channels.in_app !== false, config: { template: draft.messageTemplate || "" } },
    { type: "browser", enabled: Boolean(channels.browser), config: { template: draft.messageTemplate || "" } },
    { type: "sound", enabled: Boolean(channels.sound), config: {} },
    { type: "webhook", enabled: Boolean(channels.webhook), config: { url: draft.webhookUrl.trim() } },
  ];
}

function actionsToChannelState(actions: AlertAction[] = []): AlertChannelState {
  const state: AlertChannelState = {
    in_app: false,
    browser: false,
    sound: false,
    webhook: false,
    history: true,
  };
  for (const action of actions) {
    if (
      action.type === "in_app"
      || action.type === "browser"
      || action.type === "sound"
      || action.type === "webhook"
    ) {
      state[action.type] = action.enabled !== false;
    }
  }
  return state;
}

function resolveMaxTriggers(draft: AlertDraft): number | null {
  if (draft.afterTrigger === "keep") return null;
  if (draft.afterTrigger === "pause") return 1;
  const mode = draft.maxTriggerMode;
  const customValue = draft.customMaxTriggers;
  if (mode === "unlimited") return null;
  if (mode === "3") return 3;
  if (mode === "custom") {
    const value = Math.max(1, Math.floor(Number(customValue) || 1));
    return value;
  }
  return 1;
}

export function describeAlertDraftExpression(expression: AlertExpressionDraft): string {
  try {
    return describeExpression(buildExpressionPayload(expression));
  } catch {
    return t("alert.noCondition");
  }
}

export function describeAlertDispatch(event: AlertHistoryEvent): string {
  if (!event.dispatch || event.dispatch.length === 0) return t("alert.historyOnly");
  return event.dispatch.map((outcome) => {
    const channel = outcome.type === "in_app"
      ? t("alert.channelShort.inApp")
      : (outcome.type === "browser"
        ? t("alert.channelShort.browser")
        : (outcome.type === "sound" ? t("alert.channelShort.sound") : (outcome.type === "webhook" ? "Webhook" : outcome.type)));
    const status = outcome.status === "delivered"
      ? t("alert.dispatch.delivered")
      : (outcome.status === "published"
        ? t("alert.dispatch.published")
        : (outcome.status === "queued"
          ? t("alert.dispatch.queued")
          : (outcome.status === "retrying"
            ? t("alert.dispatch.retrying")
            : (outcome.status === "unavailable" ? t("alert.dispatch.unavailable") : outcome.status))));
    return `${channel}: ${status}`;
  }).join(" / ");
}

function normalizeAfterTrigger(value: AlertDraft["afterTrigger"]): "auto_disable" | "keep" | "pause" {
  if (value === "keep" || value === "pause") return value;
  return "auto_disable";
}

function resolveCooldownMs(draft: AlertDraft): number {
  if (draft.cooldownMode === "always") return 0;
  if (draft.cooldownMode === "5m") return 300_000;
  if (draft.cooldownMode === "custom") {
    const seconds = Math.max(0, Math.floor(Number(draft.customCooldownSeconds) || 0));
    return seconds * 1000;
  }
  return 30_000;
}

function resolveExpiresAt(mode: AlertDraft["expiresMode"], customValue: string): number | null {
  if (mode === "1h") return Date.now() + 60 * 60 * 1000;
  if (mode === "today") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }
  if (mode === "7d") return Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (mode === "custom" && customValue) {
    const value = new Date(customValue).getTime();
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function toDatetimeLocalValue(timestampMs: number): string {
  const date = new Date(Number(timestampMs));
  if (!Number.isFinite(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function updateNode(
  node: AlertExpressionDraft,
  nodeId: string,
  updater: (node: AlertExpressionDraft) => AlertExpressionDraft,
): AlertExpressionDraft {
  if (node.id === nodeId) return updater(node);
  if (node.type !== "group") return node;
  return {
    ...node,
    children: (node.children || []).map((child) => updateNode(child, nodeId, updater)),
  };
}

function deleteNode(node: AlertExpressionDraft, nodeId: string): AlertExpressionDraft | null {
  if (node.id === nodeId) return null;
  if (node.type !== "group") return node;
  return {
    ...node,
    children: (node.children || [])
      .map((child) => deleteNode(child, nodeId))
      .filter(isExpressionDraft),
  };
}

function appendSibling(
  node: AlertExpressionDraft,
  nodeId: string,
  sibling: AlertExpressionDraft,
): AlertExpressionDraft {
  if (node.type !== "group") return node;
  const children = node.children || [];
  const index = children.findIndex((child) => child.id === nodeId);
  if (index >= 0) {
    return {
      ...node,
      children: [...children.slice(0, index + 1), sibling, ...children.slice(index + 1)],
    };
  }
  return {
    ...node,
    children: children.map((child) => appendSibling(child, nodeId, sibling)),
  };
}

function findNode(node: AlertExpressionDraft, nodeId: string): AlertExpressionDraft | null {
  if (node.id === nodeId) return node;
  if (node.type !== "group") return null;
  for (const child of node.children || []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function cloneExpressionDraftNode(node: AlertExpressionDraft): AlertExpressionDraft {
  if (node.type === "group") {
    return createGroupNode({
      op: node.op,
      not: node.not,
      children: (node.children || []).map(cloneExpressionDraftNode),
    });
  }
  return createConditionNode({
    not: node.not,
    left: node.left,
    comparator: node.comparator,
    rightType: node.rightType,
    rightValue: node.rightValue,
    rangeMin: node.rangeMin,
    rangeMax: node.rangeMax,
    percentValue: node.percentValue,
  });
}

function describeRight(right: AlertRight): string {
  if (right.type === "range") return t("alert.rangeTo", { min: String(right.min ?? "?"), max: String(right.max ?? "?") });
  if (right.type === "percent") return `${right.value ?? "?"}%`;
  if (right.type === "number") return String(right.value ?? "?");
  return `${labelForRightType(right.type)}:${labelForSource(right.value)}`;
}
