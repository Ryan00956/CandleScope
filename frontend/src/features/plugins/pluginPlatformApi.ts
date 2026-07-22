import { API_BASE } from "../../services/apiConfig.js";
import {
  parsePluginCatalog,
  parsePluginManagementDetail,
  parsePluginUiSnapshot,
} from "./pluginPlatformParsers.js";
import type {
  JsonValue,
  PluginCatalog,
  PluginManagementDetail,
  PluginUiSnapshot,
} from "./pluginPlatformTypes.js";

interface PluginManagementBootstrapV1 {
  apiBase: string;
  sessionToken: string;
  csrfToken: string;
}

interface PluginManagementSession extends PluginManagementBootstrapV1 {
  apiBase: string;
}

declare global {
  interface Window {
    __CANDLESCOPE_PLUGIN_MANAGEMENT_V1__?: PluginManagementBootstrapV1;
  }
}

let managementSession: PluginManagementSession | null | undefined;

function publicPluginBase(): string {
  if (API_BASE.endsWith("/api/v1")) return `${API_BASE.slice(0, -"/api/v1".length)}/api/v2/plugins`;
  return `${API_BASE}/../v2/plugins`;
}

export function sandboxPluginAssetUrl(
  pluginId: string,
  bundleDigest: string,
  entry: string,
): string {
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(pluginId)
    || !/^sha256:[0-9a-f]{64}$/.test(bundleDigest)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\.html$/.test(entry)
    || entry.includes("..")
    || entry.includes("//")
    || entry.includes("\\")
    || entry.includes(":")
    || entry.includes("%")
  ) throw new PluginPlatformApiError("Sandbox plugin asset identity is invalid", 400);
  const digest = bundleDigest.slice("sha256:".length);
  const path = entry.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${publicPluginBase()}/assets/${encodeURIComponent(pluginId)}/${digest}/${path}`;
}

function loopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

function consumeManagementSession(): PluginManagementSession | null {
  if (managementSession !== undefined) return managementSession;
  if (typeof window === "undefined") {
    managementSession = null;
    return managementSession;
  }
  const bootstrap = window.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__;
  delete window.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__;
  managementSession = null;
  if (!bootstrap || typeof bootstrap !== "object") return managementSession;
  const { apiBase, sessionToken, csrfToken } = bootstrap;
  if (
    typeof apiBase !== "string"
    || typeof sessionToken !== "string"
    || typeof csrfToken !== "string"
    || sessionToken === csrfToken
    || sessionToken.length < 32
    || sessionToken.length > 256
    || csrfToken.length < 32
    || csrfToken.length > 256
    || !/^https?:\/\//.test(apiBase)
  ) return managementSession;
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return managementSession;
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !loopback(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.replace(/\/$/, "").endsWith("/api/v2/plugins")
  ) return managementSession;
  managementSession = {
    apiBase: url.toString().replace(/\/$/, ""),
    sessionToken,
    csrfToken,
  };
  return managementSession;
}

export function pluginManagementAvailable(): boolean {
  return consumeManagementSession() !== null;
}

export class PluginPlatformApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PluginPlatformApiError";
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload
      ? (payload as { detail?: unknown }).detail
      : null;
    const message = typeof detail === "string"
      ? detail
      : detail && typeof detail === "object" && "message" in detail && typeof (detail as { message?: unknown }).message === "string"
        ? String((detail as { message: string }).message)
        : `Plugin Platform request failed (${response.status})`;
    throw new PluginPlatformApiError(message, response.status);
  }
  return payload;
}

export async function fetchPluginCatalog(signal?: AbortSignal): Promise<PluginCatalog> {
  const response = await fetch(`${publicPluginBase()}/catalog`, { ...(signal ? { signal } : {}) });
  return parsePluginCatalog(await responseJson(response));
}

export async function fetchPluginUiSnapshot(signal?: AbortSignal): Promise<PluginUiSnapshot> {
  const response = await fetch(`${publicPluginBase()}/ui/snapshot`, { ...(signal ? { signal } : {}) });
  return parsePluginUiSnapshot(await responseJson(response));
}

function actionId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 96);
}

async function managementRequest(
  path: string,
  options: { method?: "GET" | "POST" | "PUT"; body?: unknown; action?: string } = {},
): Promise<unknown> {
  const session = consumeManagementSession();
  if (!session) throw new PluginPlatformApiError("Plugin management requires a trusted desktop session", 403);
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    "X-CandleScope-Plugin-Session": session.sessionToken,
  };
  if (method !== "GET") {
    headers["X-CandleScope-CSRF"] = session.csrfToken;
    headers["X-CandleScope-User-Action"] = actionId(options.action ?? "plugin-ui");
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${session.apiBase}${path}`, {
    method,
    headers,
    credentials: "omit",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return responseJson(response);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Plugin Platform response is invalid at ${path}`);
  }
  return value as Record<string, unknown>;
}

function safeJson(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 8) throw new Error(`Plugin Platform response is invalid at ${path}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 256) return value.map((item, index) => safeJson(item, `${path}[${index}]`, depth + 1));
  const data = object(value, path);
  if (Object.keys(data).length > 64) throw new Error(`Plugin Platform response is invalid at ${path}`);
  return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, safeJson(item, `${path}.${key}`, depth + 1)]));
}

export function parsePluginSettingsValue(response: unknown): Record<string, JsonValue> {
  const payload = object(response, "settings response");
  const settings = object(payload.settings, "settings response.settings");
  const value = safeJson(settings.value, "settings response.settings.value");
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin settings response is invalid");
  }
  return value;
}

export async function invokePluginCommand(id: string, input: Record<string, JsonValue>): Promise<JsonValue> {
  const payload = object(await managementRequest(`/manage/commands/${encodeURIComponent(id)}/invoke`, {
    method: "POST",
    body: { input },
    action: "invoke-command",
  }), "command");
  return safeJson(payload.result, "command.result");
}

export async function readPluginSettings(id: string): Promise<Record<string, JsonValue>> {
  return parsePluginSettingsValue(await managementRequest(`/manage/settings/${encodeURIComponent(id)}`));
}

export async function writePluginSettings(id: string, value: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
  return parsePluginSettingsValue(await managementRequest(`/manage/settings/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { value },
    action: "save-settings",
  }));
}

export async function fetchPluginManagementDetail(pluginId: string): Promise<PluginManagementDetail> {
  return parsePluginManagementDetail(await managementRequest(`/manage/${encodeURIComponent(pluginId)}/detail`));
}

export async function installPluginBundle(file: File): Promise<void> {
  const session = consumeManagementSession();
  if (!session) throw new PluginPlatformApiError("Plugin management requires a trusted desktop session", 403);
  if (!file.name.toLowerCase().endsWith(".cspkg") || file.size < 1 || file.size > 16 * 1024 * 1024) {
    throw new PluginPlatformApiError("Select a .cspkg bundle no larger than 16 MiB", 400);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  const expectedSha256 = `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  const response = await fetch(`${session.apiBase}/manage/install`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.candlescope.plugin+zip",
      "X-CandleScope-Plugin-Session": session.sessionToken,
      "X-CandleScope-CSRF": session.csrfToken,
      "X-CandleScope-User-Action": actionId("install-bundle"),
      "X-CandleScope-Bundle-SHA256": expectedSha256,
    },
    credentials: "omit",
    body: file,
  });
  await responseJson(response);
}

export async function mutatePluginState(
  pluginId: string,
  action: "enable" | "disable" | "rollback" | "uninstall",
): Promise<void> {
  await managementRequest(`/manage/${encodeURIComponent(pluginId)}/${action}`, {
    method: "POST",
    action: `plugin-${action}`,
  });
}

export async function mutatePluginPermission(
  pluginId: string,
  permissionId: string,
  decision: "grant" | "deny" | "revoke",
  scope?: Record<string, JsonValue>,
): Promise<void> {
  await managementRequest(
    `/manage/${encodeURIComponent(pluginId)}/permissions/${encodeURIComponent(permissionId)}/${decision}`,
    {
      method: "POST",
      ...(decision === "grant" ? { body: { scope: scope ?? null } } : {}),
      action: `permission-${decision}`,
    },
  );
}
