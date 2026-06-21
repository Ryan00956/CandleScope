import { ApiError } from "./api";
import { API_BASE } from "./apiConfig";

function buildUrl(path, params = {}) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return `${API_BASE}${path}${query ? `?${query}` : ""}`;
}

async function request(path, { method = "GET", body, signal, params } = {}) {
  const url = buildUrl(path, params);
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new ApiError({
      status: response.status,
      detail: errorData.detail || `HTTP ${response.status}`,
      url,
    });
  }
  if (response.status === 204) return null;
  return response.json();
}

export function fetchAlertRules(options = {}) {
  return request("/alerts/rules", { signal: options.signal });
}

export function createAlertRule(payload, options = {}) {
  return request("/alerts/rules", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAlertRule(ruleId, payload, options = {}) {
  return request(`/alerts/rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    body: payload,
    signal: options.signal,
  });
}

export function setAlertRuleEnabled(ruleId, enabled, options = {}) {
  return request(`/alerts/rules/${encodeURIComponent(ruleId)}/enabled`, {
    method: "PATCH",
    body: { enabled },
    signal: options.signal,
  });
}

export function deleteAlertRule(ruleId, options = {}) {
  return request(`/alerts/rules/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function fetchAlertHistory({ limit = 100, ruleId = "" } = {}, options = {}) {
  return request("/alerts/history", {
    params: { limit, rule_id: ruleId },
    signal: options.signal,
  });
}

export function evaluateAlertExpression(payload, options = {}) {
  return request("/alerts/evaluate", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}
