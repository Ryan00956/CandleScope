export const ALERT_EXPRESSION_MAX_DEPTH = 32;

export type AlertTriggerOn = "realtime" | "bar_update" | "bar_close";
export type AlertLogicalOperator = "AND" | "OR";
export type AlertComparator =
  | "crossesAbove"
  | "crossesBelow"
  | ">"
  | "<"
  | ">="
  | "<="
  | "=="
  | "!="
  | "between"
  | "outsideRange"
  | "percentChangeAbove"
  | "percentChangeBelow";
export type AlertRightType = "number" | "field" | "indicator" | "range" | "percent";

export interface AlertNumberRight {
  type: "number" | "percent";
  value: number;
}

export interface AlertReferenceRight {
  type: "field" | "indicator";
  value: string;
}

export interface AlertRangeRight {
  type: "range";
  min: number;
  max: number;
}

export type AlertRight = AlertNumberRight | AlertReferenceRight | AlertRangeRight;

export interface AlertConditionExpression {
  left: string;
  comparator: AlertComparator;
  right: AlertRight;
}

export interface AlertLogicalExpression {
  op: AlertLogicalOperator;
  children: AlertExpression[];
}

export interface AlertNotExpression {
  op: "NOT";
  children: [AlertExpression];
}

export type AlertExpression =
  | AlertConditionExpression
  | AlertLogicalExpression
  | AlertNotExpression;

export interface AlertTarget {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
}

export interface AlertAction {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface AlertRulePayload {
  schemaVersion?: number;
  name: string;
  description: string;
  enabled: boolean;
  target: AlertTarget;
  triggerOn: AlertTriggerOn;
  expression: AlertExpression;
  actions: AlertAction[];
  cooldownMs: number;
  expiresAt: number | null;
  maxTriggers: number | null;
  tags: string[];
}

export interface AlertRule extends AlertRulePayload {
  schemaVersion: number;
  id: string;
  triggerCount: number;
  lastTriggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AlertHistoryEvent {
  id: string;
  ruleId: string;
  eventType: string;
  target: Partial<AlertTarget>;
  message: string;
  values: Record<string, unknown>;
  actions: AlertAction[];
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface AlertEvaluationContext {
  previous?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export interface AlertEvaluatePayload {
  expression: AlertExpression;
  context: AlertEvaluationContext;
}

export interface AlertTraceNode {
  path: string;
  kind: string;
  result: boolean;
  status: string;
  summary: string;
  children: AlertTraceNode[];
  details?: Record<string, unknown>;
  op?: "AND" | "OR" | "NOT";
}

export interface AlertEvaluateResult {
  result: boolean;
  trace: AlertTraceNode;
}

export interface DeleteAlertRuleResponse {
  ok: true;
  id: string;
}

export interface AlertConditionDraft {
  id: string;
  type: "condition";
  not: boolean;
  left: string;
  comparator: AlertComparator;
  rightType: "number" | "field" | "indicator";
  rightValue: string;
  rangeMin: string;
  rangeMax: string;
  percentValue: string;
}

export interface AlertGroupDraft {
  id: string;
  type: "group";
  op: AlertLogicalOperator;
  not: boolean;
  children: AlertExpressionDraft[];
}

export type AlertExpressionDraft = AlertConditionDraft | AlertGroupDraft;

export interface AlertChannelState {
  in_app: boolean;
  browser: boolean;
  sound: boolean;
  history: boolean;
}

export interface AlertDraft {
  name: string;
  description: string;
  enabled: boolean;
  triggerOn: AlertTriggerOn;
  expression: AlertExpressionDraft;
  maxTriggerMode: "unlimited" | "once" | "3" | "custom";
  customMaxTriggers: string | number;
  expiresMode: "never" | "1h" | "today" | "7d" | "custom";
  customExpiresAt: string;
  afterTrigger: "auto-disable" | string;
  cooldownMode: "always" | "30s" | "5m" | "custom";
  customCooldownSeconds: string | number;
  messageTemplate: string;
  channels: AlertChannelState;
}

export type AlertExpressionDraftAction =
  | { type: "update-node"; nodeId: string; patch: Partial<AlertExpressionDraft> }
  | { type: "add-condition"; nodeId: string; initial?: Partial<AlertConditionDraft> }
  | { type: "add-group"; nodeId: string }
  | { type: "delete-node"; nodeId: string }
  | { type: "duplicate-node"; nodeId: string };

export interface AlertProductInput {
  symbol?: string;
  marketType?: string;
  exchange?: string;
}

export interface AlertPayloadBuildInput {
  draft: AlertDraft;
  product?: AlertProductInput | null;
  fallbackSymbol?: string;
  fallbackMarketType?: string;
  fallbackExchange?: string;
  interval?: string;
}

export interface AlertDefaultPayloadInput extends Omit<AlertPayloadBuildInput, "draft"> {
  price?: unknown;
}

export interface AlertRequestOptions {
  signal?: AbortSignal;
}

export interface AlertHistoryQuery {
  limit?: number;
  ruleId?: string;
}

export class AlertPayloadError extends TypeError {
  path: string;

  constructor(path: string, message: string) {
    super(`Invalid alert payload at ${path}: ${message}`);
    this.name = "AlertPayloadError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AlertPayloadError(path, "expected an object");
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new AlertPayloadError(path, "expected a string");
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const parsed = expectString(value, path);
  if (!parsed.trim()) throw new AlertPayloadError(path, "expected a non-empty string");
  return parsed;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new AlertPayloadError(path, "expected a boolean");
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AlertPayloadError(path, "expected a finite number");
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AlertPayloadError(path, "expected a non-negative integer");
  }
  return parsed;
}

function expectNullableTimestamp(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return expectNonNegativeInteger(value, path);
}

function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new AlertPayloadError(path, "expected an array");
  return value.map((item, index) => expectString(item, `${path}[${index}]`));
}

function parseTarget(value: unknown, path: string): AlertTarget {
  const record = expectRecord(value, path);
  return {
    exchange: expectString(record.exchange, `${path}.exchange`),
    marketType: expectString(record.marketType, `${path}.marketType`),
    symbol: expectString(record.symbol, `${path}.symbol`),
    interval: expectString(record.interval, `${path}.interval`),
  };
}

function parsePartialTarget(value: unknown, path: string): Partial<AlertTarget> {
  const record = expectRecord(value, path);
  const target: Partial<AlertTarget> = {};
  for (const key of ["exchange", "marketType", "symbol", "interval"] as const) {
    if (record[key] !== undefined) target[key] = expectString(record[key], `${path}.${key}`);
  }
  return target;
}

function parseAction(value: unknown, path: string): AlertAction {
  const record = expectRecord(value, path);
  return {
    type: expectNonEmptyString(record.type, `${path}.type`),
    enabled: expectBoolean(record.enabled, `${path}.enabled`),
    config: expectRecord(record.config, `${path}.config`),
  };
}

function parseActions(value: unknown, path: string): AlertAction[] {
  if (!Array.isArray(value)) throw new AlertPayloadError(path, "expected an array");
  return value.map((item, index) => parseAction(item, `${path}[${index}]`));
}

function parseComparator(value: unknown, path: string): AlertComparator {
  const comparators: readonly string[] = [
    "crossesAbove", "crossesBelow", ">", "<", ">=", "<=", "==", "!=",
    "between", "outsideRange", "percentChangeAbove", "percentChangeBelow",
  ];
  if (typeof value !== "string" || !comparators.includes(value)) {
    throw new AlertPayloadError(path, "unsupported comparator");
  }
  return value as AlertComparator;
}

function parseRight(value: unknown, path: string): AlertRight {
  const record = expectRecord(value, path);
  if (record.type === "range") {
    return {
      type: "range",
      min: expectFiniteNumber(record.min, `${path}.min`),
      max: expectFiniteNumber(record.max, `${path}.max`),
    };
  }
  if (record.type === "field" || record.type === "indicator") {
    return {
      type: record.type,
      value: expectNonEmptyString(record.value ?? record.field, `${path}.value`),
    };
  }
  if (record.type === "number" || record.type === "percent") {
    return {
      type: record.type,
      value: expectFiniteNumber(record.value, `${path}.value`),
    };
  }
  throw new AlertPayloadError(`${path}.type`, "unsupported right-hand value type");
}

function parseExpressionNode(
  value: unknown,
  path: string,
  depth: number,
  ancestors: WeakSet<object>,
): AlertExpression {
  if (depth > ALERT_EXPRESSION_MAX_DEPTH) {
    throw new AlertPayloadError(path, `expression exceeds ${ALERT_EXPRESSION_MAX_DEPTH} levels`);
  }
  const record = expectRecord(value, path);
  if (ancestors.has(record)) throw new AlertPayloadError(path, "cyclic expression");
  ancestors.add(record);
  try {
    const rawOp = record.op;
    if (rawOp === "AND" || rawOp === "OR") {
      if (!Array.isArray(record.children) || record.children.length === 0) {
        throw new AlertPayloadError(`${path}.children`, "expected a non-empty array");
      }
      return {
        op: rawOp,
        children: record.children.map((child, index) => (
          parseExpressionNode(child, `${path}.children[${index}]`, depth + 1, ancestors)
        )),
      };
    }
    if (rawOp === "NOT") {
      if (!Array.isArray(record.children) || record.children.length !== 1) {
        throw new AlertPayloadError(`${path}.children`, "NOT expects exactly one child");
      }
      return {
        op: "NOT",
        children: [parseExpressionNode(record.children[0], `${path}.children[0]`, depth + 1, ancestors)],
      };
    }
    if (rawOp !== undefined) throw new AlertPayloadError(`${path}.op`, "unsupported operator");
    return {
      left: expectNonEmptyString(record.left, `${path}.left`),
      comparator: parseComparator(record.comparator ?? record.operator, `${path}.comparator`),
      right: parseRight(record.right, `${path}.right`),
    };
  } finally {
    ancestors.delete(record);
  }
}

export function parseAlertExpression(value: unknown, path = "expression"): AlertExpression {
  return parseExpressionNode(value, path, 0, new WeakSet());
}

function parseTriggerOn(value: unknown, path: string): AlertTriggerOn {
  if (value === "realtime" || value === "bar_update" || value === "bar_close") return value;
  throw new AlertPayloadError(path, "unsupported trigger mode");
}

export function parseAlertRule(value: unknown, path = "rule"): AlertRule {
  const record = expectRecord(value, path);
  return {
    schemaVersion: expectNonNegativeInteger(record.schemaVersion, `${path}.schemaVersion`),
    id: expectNonEmptyString(record.id, `${path}.id`),
    name: expectString(record.name, `${path}.name`),
    description: expectString(record.description, `${path}.description`),
    enabled: expectBoolean(record.enabled, `${path}.enabled`),
    target: parseTarget(record.target, `${path}.target`),
    triggerOn: parseTriggerOn(record.triggerOn, `${path}.triggerOn`),
    expression: parseAlertExpression(record.expression, `${path}.expression`),
    actions: parseActions(record.actions, `${path}.actions`),
    cooldownMs: expectNonNegativeInteger(record.cooldownMs, `${path}.cooldownMs`),
    expiresAt: expectNullableTimestamp(record.expiresAt, `${path}.expiresAt`),
    maxTriggers: record.maxTriggers === null
      ? null
      : expectNonNegativeInteger(record.maxTriggers, `${path}.maxTriggers`),
    tags: parseStringArray(record.tags, `${path}.tags`),
    triggerCount: expectNonNegativeInteger(record.triggerCount, `${path}.triggerCount`),
    lastTriggeredAt: expectNullableTimestamp(record.lastTriggeredAt, `${path}.lastTriggeredAt`),
    createdAt: expectNonNegativeInteger(record.createdAt, `${path}.createdAt`),
    updatedAt: expectNonNegativeInteger(record.updatedAt, `${path}.updatedAt`),
  };
}

export function parseAlertRules(value: unknown, path = "rules"): AlertRule[] {
  if (!Array.isArray(value)) throw new AlertPayloadError(path, "expected an array");
  return value.map((item, index) => parseAlertRule(item, `${path}[${index}]`));
}

export function parseAlertHistoryEvent(value: unknown, path = "history"): AlertHistoryEvent {
  const record = expectRecord(value, path);
  return {
    id: expectNonEmptyString(record.id, `${path}.id`),
    ruleId: expectNonEmptyString(record.ruleId, `${path}.ruleId`),
    eventType: expectString(record.eventType, `${path}.eventType`),
    target: parsePartialTarget(record.target, `${path}.target`),
    message: expectString(record.message, `${path}.message`),
    values: expectRecord(record.values, `${path}.values`),
    actions: parseActions(record.actions, `${path}.actions`),
    createdAt: expectNonNegativeInteger(record.createdAt, `${path}.createdAt`),
    acknowledgedAt: expectNullableTimestamp(record.acknowledgedAt, `${path}.acknowledgedAt`),
  };
}

export function parseAlertHistory(value: unknown, path = "history"): AlertHistoryEvent[] {
  if (!Array.isArray(value)) throw new AlertPayloadError(path, "expected an array");
  return value.map((item, index) => parseAlertHistoryEvent(item, `${path}[${index}]`));
}

function parseTraceNode(value: unknown, path: string, depth: number): AlertTraceNode {
  if (depth > ALERT_EXPRESSION_MAX_DEPTH) {
    throw new AlertPayloadError(path, `trace exceeds ${ALERT_EXPRESSION_MAX_DEPTH} levels`);
  }
  const record = expectRecord(value, path);
  if (!Array.isArray(record.children)) {
    throw new AlertPayloadError(`${path}.children`, "expected an array");
  }
  const op = record.op === "AND" || record.op === "OR" || record.op === "NOT" ? record.op : undefined;
  return {
    path: expectString(record.path, `${path}.path`),
    kind: expectString(record.kind, `${path}.kind`),
    result: expectBoolean(record.result, `${path}.result`),
    status: expectString(record.status, `${path}.status`),
    summary: expectString(record.summary, `${path}.summary`),
    children: record.children.map((child, index) => parseTraceNode(child, `${path}.children[${index}]`, depth + 1)),
    ...(isRecord(record.details) ? { details: record.details } : {}),
    ...(op ? { op } : {}),
  };
}

export function parseAlertEvaluateResult(value: unknown, path = "evaluation"): AlertEvaluateResult {
  const record = expectRecord(value, path);
  return {
    result: expectBoolean(record.result, `${path}.result`),
    trace: parseTraceNode(record.trace, `${path}.trace`, 0),
  };
}

export function parseDeleteAlertRuleResponse(
  value: unknown,
  path = "deleteAlertRule",
): DeleteAlertRuleResponse {
  const record = expectRecord(value, path);
  if (record.ok !== true) throw new AlertPayloadError(`${path}.ok`, "expected true");
  return { ok: true, id: expectNonEmptyString(record.id, `${path}.id`) };
}
