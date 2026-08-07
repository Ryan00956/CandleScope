import { ApiError } from "./api.js";
import { API_BASE } from "./apiConfig.js";
import {
  parseAlertEvaluateResult,
  parseAlertHistory,
  parseAlertHistoryEvent,
  parseAlertRule,
  parseAlertRules,
  parseAlertSystemStatus,
  parseDeleteAlertRuleResponse,
} from "../features/alerts/alertTypes.js";
import type {
  AlertEvaluatePayload,
  AlertEvaluateResult,
  AlertHistoryEvent,
  AlertHistoryQuery,
  AlertSystemStatus,
  AlertRequestOptions,
  AlertRule,
  AlertRulePayload,
  DeleteAlertRuleResponse,
} from "../features/alerts/alertTypes.js";

type AlertHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type AlertUrlParams = Record<string, unknown>;

interface AlertTransportOptions {
  method?: AlertHttpMethod;
  body?: unknown;
  signal?: AbortSignal;
  params?: AlertUrlParams;
}

function alertSignalOptions(signal: AbortSignal | undefined): AlertTransportOptions {
  return signal === undefined ? {} : { signal };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildUrl(path: string, params: AlertUrlParams = {}): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return `${API_BASE}${path}${query ? `?${query}` : ""}`;
}

async function request<T>(
  path: string,
  parser: (value: unknown) => T,
  { method = "GET", body, signal, params }: AlertTransportOptions = {},
): Promise<T> {
  const url = buildUrl(path, params);
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const errorData: unknown = await response.json().catch(() => ({}));
    const detail = isRecord(errorData) && typeof errorData.detail === "string"
      ? errorData.detail
      : `HTTP ${response.status}`;
    throw new ApiError({ status: response.status, detail, url });
  }
  const payload: unknown = await response.json();
  return parser(payload);
}

export function fetchAlertRules(options: AlertRequestOptions = {}): Promise<AlertRule[]> {
  return request("/alerts/rules", parseAlertRules, alertSignalOptions(options.signal));
}

export function createAlertRule(
  payload: AlertRulePayload,
  options: AlertRequestOptions = {},
): Promise<AlertRule> {
  return request("/alerts/rules", parseAlertRule, {
    method: "POST",
    body: payload,
    ...alertSignalOptions(options.signal),
  });
}

export function updateAlertRule(
  ruleId: string,
  payload: AlertRulePayload,
  options: AlertRequestOptions = {},
): Promise<AlertRule> {
  return request(`/alerts/rules/${encodeURIComponent(ruleId)}`, parseAlertRule, {
    method: "PUT",
    body: payload,
    ...alertSignalOptions(options.signal),
  });
}

export function setAlertRuleEnabled(
  ruleId: string,
  enabled: boolean,
  options: AlertRequestOptions = {},
): Promise<AlertRule> {
  return request(`/alerts/rules/${encodeURIComponent(ruleId)}/enabled`, parseAlertRule, {
    method: "PATCH",
    body: { enabled },
    ...alertSignalOptions(options.signal),
  });
}

export function deleteAlertRule(
  ruleId: string,
  options: AlertRequestOptions = {},
): Promise<DeleteAlertRuleResponse> {
  return request(
    `/alerts/rules/${encodeURIComponent(ruleId)}`,
    parseDeleteAlertRuleResponse,
    { method: "DELETE", ...alertSignalOptions(options.signal) },
  );
}

export function fetchAlertHistory(
  { limit = 100, ruleId = "", sinceMs, acknowledged }: AlertHistoryQuery = {},
  options: AlertRequestOptions = {},
): Promise<AlertHistoryEvent[]> {
  return request("/alerts/history", parseAlertHistory, {
    params: { limit, rule_id: ruleId, since_ms: sinceMs, acknowledged },
    ...alertSignalOptions(options.signal),
  });
}

export function setAlertHistoryAcknowledged(
  eventId: string,
  acknowledged: boolean,
  options: AlertRequestOptions = {},
): Promise<AlertHistoryEvent> {
  return request(
    `/alerts/history/${encodeURIComponent(eventId)}/acknowledged`,
    parseAlertHistoryEvent,
    {
      method: "PATCH",
      body: { acknowledged },
      ...alertSignalOptions(options.signal),
    },
  );
}

export function recordAlertDispatchReceipt(
  eventId: string,
  dispatchId: string,
  status: "delivered" | "denied" | "unsupported" | "error",
  detail = "",
  options: AlertRequestOptions = {},
): Promise<AlertHistoryEvent> {
  return request(
    `/alerts/events/${encodeURIComponent(eventId)}/dispatch/${encodeURIComponent(dispatchId)}/receipt`,
    parseAlertHistoryEvent,
    {
      method: "POST",
      body: { status, detail },
      ...alertSignalOptions(options.signal),
    },
  );
}

export function fetchAlertStatus(options: AlertRequestOptions = {}): Promise<AlertSystemStatus> {
  return request("/alerts/status", parseAlertSystemStatus, alertSignalOptions(options.signal));
}

export function buildAlertEventStreamUrl(): string {
  return buildUrl("/alerts/events/stream");
}

export function evaluateAlertExpression(
  payload: AlertEvaluatePayload,
  options: AlertRequestOptions = {},
): Promise<AlertEvaluateResult> {
  return request("/alerts/evaluate", parseAlertEvaluateResult, {
    method: "POST",
    body: payload,
    ...alertSignalOptions(options.signal),
  });
}
