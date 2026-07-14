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
} from "./alertTypes.js";
import { parseAlertExpression } from "./alertTypes.js";

let nodeCounter = 0;

function createNodeId(prefix = "alert-node"): string {
  nodeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nodeCounter.toString(36)}`;
}

export const ALERT_SOURCE_OPTIONS = [
  { value: "close", label: "收盘价" },
  { value: "last", label: "最新价" },
  { value: "open", label: "开盘价" },
  { value: "high", label: "最高价" },
  { value: "low", label: "最低价" },
  { value: "volume", label: "成交量" },
  { value: "rsi", label: "RSI(14)" },
  { value: "macdHist", label: "MACD Histogram" },
  { value: "ma20", label: "MA(20)" },
] as const;

export const ALERT_COMPARATOR_OPTIONS = [
  { value: "crossesAbove", label: "上穿" },
  { value: "crossesBelow", label: "下穿" },
  { value: ">", label: "大于" },
  { value: "<", label: "小于" },
  { value: ">=", label: "大于等于" },
  { value: "<=", label: "小于等于" },
  { value: "==", label: "等于" },
  { value: "!=", label: "不等于" },
  { value: "between", label: "介于区间" },
  { value: "outsideRange", label: "离开区间" },
  { value: "percentChangeAbove", label: "涨跌幅大于" },
  { value: "percentChangeBelow", label: "涨跌幅小于" },
] as const;

export const ALERT_RIGHT_TYPE_OPTIONS = [
  { value: "number", label: "固定数值" },
  { value: "field", label: "价格/成交量字段" },
  { value: "indicator", label: "另一指标" },
] as const;

const SOURCE_LABELS = Object.fromEntries(ALERT_SOURCE_OPTIONS.map((item) => [item.value, item.label]));
const COMPARATOR_LABELS = Object.fromEntries(ALERT_COMPARATOR_OPTIONS.map((item) => [item.value, item.label]));
const RIGHT_TYPE_LABELS = Object.fromEntries(ALERT_RIGHT_TYPE_OPTIONS.map((item) => [item.value, item.label]));
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
      createGroupNode({
        op: "OR",
        children: [
          createConditionNode({
            left: "rsi",
            comparator: ">",
            rightType: "number",
            rightValue: "70",
          }),
          createConditionNode({
            left: "macdHist",
            comparator: "crossesAbove",
            rightType: "number",
            rightValue: "0",
          }),
        ],
      }),
    ],
  });
}

export function createDefaultAlertDraft({
  symbol = "",
  price,
}: { symbol?: string; interval?: string; price?: unknown } = {}): AlertDraft {
  return {
    name: `${symbol || "未选商品"} 价格 + 指标组合警报`,
    description: "由警报面板创建的组合规则。",
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
    messageTemplate: "{{symbol}} {{interval}} 命中警报：{{condition}}，当前值 {{value}}",
    channels: {
      in_app: true,
      browser: false,
      sound: false,
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
    name: draft.name?.trim() || `${symbol || "未选商品"} 警报`,
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
    maxTriggers: resolveMaxTriggers(draft.maxTriggerMode, draft.customMaxTriggers),
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
    afterTrigger: "auto-disable",
    cooldownMode: cooldownMs === 0 ? "always" : (cooldownMs === 30_000 ? "30s" : (cooldownMs === 300_000 ? "5m" : "custom")),
    customCooldownSeconds: Number.isFinite(cooldownMs) && cooldownMs > 0 ? Math.round(cooldownMs / 1000) : 60,
    messageTemplate: messageTemplateFromActions(rule.actions)
      || "{{symbol}} {{interval}} 命中警报：{{condition}}，当前值 {{value}}",
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
    return "未配置触发条件";
  }
  if ("op" in parsed) {
    if (parsed.op === "NOT") {
      return `非 (${describeExpression(parsed.children[0])})`;
    }
    const glue = parsed.op === "AND" ? " 且 " : " 或 ";
    const text = parsed.children.map(describeExpression).filter(Boolean).join(glue);
    return parsed.children.length > 1 ? `(${text})` : text || "空条件组";
  }
  const left = labelForSource(parsed.left);
  const comparator = COMPARATOR_LABELS[parsed.comparator] || parsed.comparator;
  const right = describeRight(parsed.right);
  return `${left} ${comparator} ${right}`;
}

export function describeAlertChannels(rule: AlertRule | null | undefined): string {
  const channels = (rule?.actions || [])
    .filter((action) => action.enabled !== false)
    .map((action) => {
      if (action.type === "in_app") return "应用内";
      if (action.type === "browser") return "浏览器";
      if (action.type === "sound") return "声音";
      if (action.type === "telegram") return "Telegram";
      if (action.type === "email") return "邮件";
      if (action.type === "trading_signal") return "交易信号";
      return action.type;
    });
  return channels.length > 0 ? channels.join(" / ") : "无启用渠道";
}

export function formatAlertTime(timestampMs: unknown): string {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return "--";
  return new Date(ts).toLocaleString();
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
  ];
}

function actionsToChannelState(actions: AlertAction[] = []): AlertChannelState {
  const state: AlertChannelState = { in_app: false, browser: false, sound: false, history: true };
  for (const action of actions) {
    if (action.type === "in_app" || action.type === "browser" || action.type === "sound") {
      state[action.type] = action.enabled !== false;
    }
  }
  return state;
}

function resolveMaxTriggers(mode: AlertDraft["maxTriggerMode"], customValue: string | number): number | null {
  if (mode === "unlimited") return null;
  if (mode === "3") return 3;
  if (mode === "custom") {
    const value = Math.max(1, Math.floor(Number(customValue) || 1));
    return value;
  }
  return 1;
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
  if (right.type === "range") return `${right.min ?? "?"} 到 ${right.max ?? "?"}`;
  if (right.type === "percent") return `${right.value ?? "?"}%`;
  if (right.type === "number") return String(right.value ?? "?");
  return `${RIGHT_TYPE_LABELS[right.type] || right.type}:${labelForSource(right.value)}`;
}

function labelForSource(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  return SOURCE_LABELS[key] || key || "?";
}
