import { API_BASE } from "../../services/apiConfig.js";
import { sharedControlRead } from "../../services/sharedControlRead.js";
import {
  parsePluginCatalog,
  parsePluginLiveConfirmationPreview,
  parsePluginLiveConfirmationReceipt,
  parsePluginLiveControlStatus,
  parsePluginLiveExecutionRecord,
  parsePluginLocalInstallCandidate,
  parsePluginManagementDetail,
  parsePluginMarketplaceCatalog,
  parsePluginMarketplaceStatus,
  parsePluginUiSnapshot,
  parsePluginV1CompatibilityPreview,
  parsePluginTrustChangeReview,
  parsePluginTrustReview,
} from "./pluginPlatformParsers.js";
import type {
  JsonValue,
  PluginCatalog,
  PluginChartContextSnapshot,
  PluginFileSelection,
  PluginLiveConfirmationPreview,
  PluginLiveConfirmationReceipt,
  PluginLiveControlStatus,
  PluginLiveExecutionRecord,
  PluginLocalInstallCandidate,
  PluginManagementDetail,
  PluginMarketplaceCatalog,
  PluginMarketplaceStatus,
  PluginUiSnapshot,
  PluginV1CompatibilityPreview,
  PluginTrustChangeReview,
  PluginTrustReview,
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
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
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
    const code = detail && typeof detail === "object" && "code" in detail
      && typeof (detail as { code?: unknown }).code === "string"
      ? String((detail as { code: string }).code)
      : null;
    throw new PluginPlatformApiError(message, response.status, code);
  }
  return payload;
}

export async function fetchPluginCatalog(signal?: AbortSignal): Promise<PluginCatalog> {
  const url = `${publicPluginBase()}/catalog`;
  return sharedControlRead("control:plugin-catalog", 5_000, async () => {
    const response = await fetch(url);
    return parsePluginCatalog(await responseJson(response));
  }, signal);
}

export async function fetchPluginMarketplaceCatalog(
  signal?: AbortSignal,
): Promise<PluginMarketplaceCatalog> {
  const response = await fetch(
    `${publicPluginBase()}/marketplace/catalog`,
    { ...(signal ? { signal } : {}) },
  );
  return parsePluginMarketplaceCatalog(await responseJson(response));
}

export async function fetchPluginUiSnapshot(signal?: AbortSignal): Promise<PluginUiSnapshot> {
  const url = `${publicPluginBase()}/ui/snapshot`;
  return sharedControlRead("control:plugin-ui-snapshot", 1_000, async () => {
    const response = await fetch(url);
    return parsePluginUiSnapshot(await responseJson(response));
  }, signal);
}

export async function fetchPluginLiveControlStatus(
  signal?: AbortSignal,
): Promise<PluginLiveControlStatus> {
  const url = `${publicPluginBase()}/live/control/status`;
  return sharedControlRead("control:plugin-live-status", 1_000, async () => {
    const response = await fetch(url);
    return parsePluginLiveControlStatus(await responseJson(response));
  }, signal);
}

export async function syncPluginChartContext(
  identity: {
    exchange: string;
    marketType: string;
    symbol: string;
    interval: string;
  } | null,
): Promise<PluginChartContextSnapshot> {
  const value = await backgroundManagementRequest(
    "/manage/chart-context",
    identity === null
      ? {
        chartId: "main-chart",
        active: false,
        context: null,
        series: null,
      }
      : {
        chartId: "main-chart",
        active: true,
        context: {
          mode: "live",
          exchange: identity.exchange,
          marketType: identity.marketType,
        },
        series: {
          symbol: identity.symbol,
          interval: identity.interval,
        },
      },
  );
  const payload = object(value, "chart context");
  if (
    Object.keys(payload).sort().join(",")
      !== "active,chartId,context,revision,schemaVersion,series,updatedAtMs"
    || payload.schemaVersion !== "candlescope.chart-context/1"
    || payload.chartId !== "main-chart"
    || typeof payload.active !== "boolean"
    || !Number.isSafeInteger(payload.revision)
    || Number(payload.revision) < 0
    || (
      payload.updatedAtMs !== null
      && (!Number.isSafeInteger(payload.updatedAtMs) || Number(payload.updatedAtMs) < 0)
    )
  ) throw new Error("Plugin chart context response is invalid");
  let context: PluginChartContextSnapshot["context"] = null;
  let series: PluginChartContextSnapshot["series"] = null;
  if (payload.active) {
    const rawContext = object(payload.context, "chart context.context");
    const rawSeries = object(payload.series, "chart context.series");
    if (
      Object.keys(rawContext).sort().join(",") !== "exchange,marketType,mode"
      || Object.keys(rawSeries).sort().join(",") !== "interval,symbol"
      || rawContext.mode !== "live"
      || typeof rawContext.exchange !== "string"
      || typeof rawContext.marketType !== "string"
      || typeof rawSeries.symbol !== "string"
      || typeof rawSeries.interval !== "string"
    ) throw new Error("Plugin chart context response is invalid");
    context = {
      mode: "live",
      exchange: rawContext.exchange,
      marketType: rawContext.marketType,
    };
    series = {
      symbol: rawSeries.symbol,
      interval: rawSeries.interval,
    };
  } else if (payload.context !== null || payload.series !== null) {
    throw new Error("Plugin chart context response is invalid");
  }
  return {
    schemaVersion: "candlescope.chart-context/1",
    chartId: "main-chart",
    revision: Number(payload.revision),
    active: payload.active,
    context,
    series,
    updatedAtMs: payload.updatedAtMs === null ? null : Number(payload.updatedAtMs),
  };
}

let actionSequence = 0;

function actionId(prefix: string): string {
  actionSequence = actionSequence >= Number.MAX_SAFE_INTEGER ? 1 : actionSequence + 1;
  return `${prefix}-${Date.now().toString(36)}-${actionSequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 96);
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

async function backgroundManagementRequest(
  path: string,
  body: unknown,
): Promise<unknown> {
  const session = consumeManagementSession();
  if (!session) {
    throw new PluginPlatformApiError(
      "Plugin management requires a trusted desktop session",
      403,
    );
  }
  const response = await fetch(`${session.apiBase}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-CandleScope-Plugin-Session": session.sessionToken,
      "X-CandleScope-CSRF": session.csrfToken,
    },
    credentials: "omit",
    body: JSON.stringify(body),
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

function parseFileSelection(value: unknown): PluginFileSelection {
  const payload = object(value, "file selection");
  const selection = object(payload.fileSelection, "file selection.fileSelection");
  if (
    Object.keys(selection).sort().join(",") !== "expiresInSeconds,handle,maxBytes,mediaType,name"
    || typeof selection.handle !== "string"
    || !/^ufh_[A-Za-z0-9_-]{40,128}$/.test(selection.handle)
    || typeof selection.name !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(selection.name)
    || typeof selection.mediaType !== "string"
    || !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(selection.mediaType)
    || !Number.isSafeInteger(selection.maxBytes)
    || Number(selection.maxBytes) < 1
    || Number(selection.maxBytes) > 128 * 1024
    || !Number.isSafeInteger(selection.expiresInSeconds)
    || Number(selection.expiresInSeconds) < 1
    || Number(selection.expiresInSeconds) > 600
  ) throw new Error("Plugin file selection response is invalid");
  return {
    handle: selection.handle,
    name: selection.name,
    mediaType: selection.mediaType,
    maxBytes: Number(selection.maxBytes),
    expiresInSeconds: Number(selection.expiresInSeconds),
  };
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

export async function invokePluginCommand(id: string, input: Record<string, JsonValue>, locale: string): Promise<JsonValue> {
  const payload = object(await managementRequest(`/manage/commands/${encodeURIComponent(id)}/invoke`, {
    method: "POST",
    body: { input, locale },
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

export async function fetchPluginMarketplaceStatus(): Promise<PluginMarketplaceStatus> {
  return parsePluginMarketplaceStatus(await managementRequest("/manage/marketplace/status"));
}

export async function previewV1CompatibilityImport(): Promise<PluginV1CompatibilityPreview> {
  return parsePluginV1CompatibilityPreview(
    await managementRequest("/manage/compatibility/v1/import-preview"),
  );
}

export async function applyV1CompatibilityImport(previewSha256: string): Promise<void> {
  await managementRequest("/manage/compatibility/v1/import", {
    method: "POST",
    body: { previewSha256 },
    action: "v1-compatibility-import",
  });
}

export async function previewV1CompatibilityRollback(): Promise<PluginV1CompatibilityPreview> {
  return parsePluginV1CompatibilityPreview(
    await managementRequest("/manage/compatibility/v1/rollback-preview"),
  );
}

export async function applyV1CompatibilityRollback(previewSha256: string): Promise<void> {
  await managementRequest("/manage/compatibility/v1/rollback", {
    method: "POST",
    body: { previewSha256 },
    action: "v1-compatibility-rollback",
  });
}

export async function refreshPluginMarketplace(marketplaceId: string): Promise<void> {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(marketplaceId)) {
    throw new PluginPlatformApiError("Marketplace identity is invalid", 400);
  }
  await managementRequest(`/manage/marketplace/${encodeURIComponent(marketplaceId)}/refresh`, {
    method: "POST",
    action: "marketplace-refresh",
  });
}

export async function preparePluginMarketplaceRelease(
  pluginId: string,
  version: string,
): Promise<void> {
  await managementRequest(`/manage/marketplace/${encodeURIComponent(pluginId)}/prepare`, {
    method: "POST",
    body: { version },
    action: "marketplace-prepare",
  });
}

export async function applyPluginMarketplaceRelease(pluginId: string): Promise<void> {
  await managementRequest(`/manage/marketplace/${encodeURIComponent(pluginId)}/apply`, {
    method: "POST",
    action: "marketplace-apply",
  });
}

export async function activatePluginMarketplaceRelease(pluginId: string): Promise<void> {
  await managementRequest(`/manage/marketplace/${encodeURIComponent(pluginId)}/activate`, {
    method: "POST",
    action: "marketplace-activate",
  });
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

async function pluginBundleUploadIdentity(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".cspkg") || file.size < 1 || file.size > 16 * 1024 * 1024) {
    throw new PluginPlatformApiError("Select a .cspkg bundle no larger than 16 MiB", 400);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export async function prepareLocalPluginInstall(file: File): Promise<PluginLocalInstallCandidate> {
  const session = consumeManagementSession();
  if (!session) throw new PluginPlatformApiError("Plugin management requires a trusted desktop session", 403);
  const expectedSha256 = await pluginBundleUploadIdentity(file);
  const response = await fetch(`${session.apiBase}/manage/install/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.candlescope.plugin+zip",
      "X-CandleScope-Plugin-Session": session.sessionToken,
      "X-CandleScope-CSRF": session.csrfToken,
      "X-CandleScope-User-Action": actionId("install-prepare"),
      "X-CandleScope-Bundle-SHA256": expectedSha256,
    },
    credentials: "omit",
    body: file,
  });
  return parsePluginLocalInstallCandidate(await responseJson(response));
}

export async function reviewLocalPluginInstall(
  candidateId: string,
  previewSha256: string,
  reason: string,
  acknowledgements: string[],
): Promise<PluginTrustReview> {
  return parsePluginTrustReview(await managementRequest("/manage/install/review", {
    method: "POST",
    action: "install-review",
    body: { candidateId, previewSha256, reason, acknowledgements },
  }));
}

export async function confirmLocalPluginInstall(
  candidateId: string,
  previewSha256: string,
  confirmationToken: string,
): Promise<void> {
  await managementRequest("/manage/install/confirm", {
    method: "POST",
    action: "install-confirm",
    body: { candidateId, previewSha256, confirmationToken },
  });
}

export async function reviewPluginTrustChange(
  pluginId: string,
  targetMode: "marketplace-sandboxed" | "trusted-local",
  reason: string,
  acknowledgements: string[],
): Promise<PluginTrustChangeReview> {
  return parsePluginTrustChangeReview(await managementRequest(
    `/manage/${encodeURIComponent(pluginId)}/trust/review`,
    {
      method: "POST",
      action: "trust-change-review",
      body: { targetMode, reason, acknowledgements },
    },
  ));
}

export async function confirmPluginTrustChange(
  pluginId: string,
  changeId: string,
  previewSha256: string,
  confirmationToken: string,
): Promise<void> {
  await managementRequest(`/manage/${encodeURIComponent(pluginId)}/trust/confirm`, {
    method: "POST",
    action: "trust-change-confirm",
    body: { changeId, previewSha256, confirmationToken },
  });
}

export async function stagePluginUserFile(
  contributionId: string,
  field: string,
  file: File,
): Promise<PluginFileSelection> {
  const session = consumeManagementSession();
  if (!session) throw new PluginPlatformApiError("Plugin management requires a trusted desktop session", 403);
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(contributionId)
    || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(field)
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(file.name)
    || !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(file.type)
    || file.size < 1
    || file.size > 128 * 1024
  ) throw new PluginPlatformApiError("Selected plugin file is invalid or too large", 400);
  const query = new URLSearchParams({ contributionId, field });
  const response = await fetch(`${session.apiBase}/manage/files/open?${query}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "X-CandleScope-Plugin-Session": session.sessionToken,
      "X-CandleScope-CSRF": session.csrfToken,
      "X-CandleScope-User-Action": actionId("select-plugin-file"),
      "X-CandleScope-File-Name": file.name,
    },
    credentials: "omit",
    body: file,
  });
  return parseFileSelection(await responseJson(response));
}

export async function preparePluginUserFileSave(
  contributionId: string,
  field: string,
): Promise<PluginFileSelection> {
  return parseFileSelection(await managementRequest("/manage/files/save", {
    method: "POST",
    body: { contributionId, field },
    action: "select-plugin-save-destination",
  }));
}

export async function downloadPluginUserFile(
  pluginId: string,
  downloadId: string,
): Promise<Blob> {
  const session = consumeManagementSession();
  if (!session) throw new PluginPlatformApiError("Plugin management requires a trusted desktop session", 403);
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(pluginId)
    || !/^ufd_[A-Za-z0-9_-]{40,128}$/.test(downloadId)
  ) throw new PluginPlatformApiError("Plugin file download identity is invalid", 400);
  const response = await fetch(`${session.apiBase}/manage/files/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CandleScope-Plugin-Session": session.sessionToken,
      "X-CandleScope-CSRF": session.csrfToken,
      "X-CandleScope-User-Action": actionId("download-plugin-file"),
    },
    credentials: "omit",
    body: JSON.stringify({ pluginId, downloadId }),
  });
  if (!response.ok) {
    await responseJson(response);
    throw new PluginPlatformApiError("Plugin file download failed", response.status);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > 128 * 1024) {
    throw new PluginPlatformApiError("Plugin file download exceeds its byte limit", 413);
  }
  const blob = await response.blob();
  if (blob.size > 128 * 1024) throw new PluginPlatformApiError("Plugin file download exceeds its byte limit", 413);
  return blob;
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

export async function setPaperKillSwitch(enabled: boolean): Promise<void> {
  await managementRequest("/manage/paper/kill-switch", {
    method: "POST",
    body: { enabled },
    action: enabled ? "paper-kill-switch" : "paper-resume",
  });
}

export async function setLiveControlMode(
  mode: "armed" | "disarmed",
  reason: string,
  acknowledgeKill: boolean,
): Promise<PluginLiveControlStatus> {
  return parsePluginLiveControlStatus(
    await managementRequest("/manage/live/control", {
      method: "POST",
      body: { mode, reason, acknowledgeKill },
      action: mode === "armed" ? "live-control-arm" : "live-control-disarm",
    }),
  );
}

const LIVE_CONTROL_STATUS_FIELDS = [
  "schemaVersion", "available", "mode", "generation", "policyEpoch",
  "updatedAt", "outstandingConfirmationCount", "confirmationCounts",
  "eventSequence", "eventSha256", "liveSubmitAvailable",
  "liveCancelAvailable", "liveTransferAvailable",
] as const;

function controlProjection(value: unknown, path: string): PluginLiveControlStatus {
  const payload = object(value, path);
  return parsePluginLiveControlStatus(
    Object.fromEntries(
      LIVE_CONTROL_STATUS_FIELDS.map((field) => [field, payload[field]]),
    ),
  );
}

export async function killLiveControl(
  reason: string,
): Promise<PluginLiveControlStatus> {
  const payload = await managementRequest("/manage/live/kill", {
    method: "POST",
    body: { reason },
    action: "live-control-kill",
  });
  return controlProjection(payload, "Live kill");
}

export async function revokeLiveAuthority(
  scopeType: "grant" | "plugin" | "publisher" | "credential",
  subject: string,
  reason: string,
): Promise<PluginLiveControlStatus> {
  const payload = await managementRequest("/manage/live/revoke", {
    method: "POST",
    body: { scopeType, subject, reason },
    action: `live-${scopeType}-revoke`,
  });
  return controlProjection(payload, "Live revoke");
}

export async function previewLiveConfirmation(
  accountRef: string,
  shadowRef: string,
): Promise<PluginLiveConfirmationPreview> {
  return parsePluginLiveConfirmationPreview(
    await managementRequest("/manage/live/confirmations/preview", {
      method: "POST",
      body: { accountRef, shadowRef },
      action: "live-confirmation-preview",
    }),
  );
}

export async function issueLiveConfirmation(
  accountRef: string,
  shadowRef: string,
  preview: PluginLiveConfirmationPreview,
  ttlSeconds = 60,
): Promise<PluginLiveConfirmationReceipt> {
  return parsePluginLiveConfirmationReceipt(
    await managementRequest("/manage/live/confirmations/issue", {
      method: "POST",
      body: {
        accountRef,
        shadowRef,
        expectedIntentSha256: preview.intentSha256,
        expectedPolicyEpoch: preview.policyEpoch,
        expectedControlGeneration: preview.controlGeneration,
        ttlSeconds,
      },
      action: "live-confirmation-issue",
    }),
  );
}

export async function revokeLiveConfirmation(
  receiptRef: string,
  reason: string,
): Promise<void> {
  await managementRequest("/manage/live/confirmations/revoke", {
    method: "POST",
    body: { receiptRef, reason },
    action: "live-confirmation-revoke",
  });
}

function liveExecutionBody(
  accountRef: string,
  shadowRef: string,
  receipt: PluginLiveConfirmationReceipt,
): Record<string, unknown> {
  if (
    receipt.schemaVersion !== "candlescope.live-confirmation/2"
    || !receipt.action
  ) throw new PluginPlatformApiError("Demo execution requires an action-bound receipt", 400);
  return {
    accountRef,
    shadowRef,
    receiptRef: receipt.receiptRef,
    expectedConfirmationSha256: receipt.intentSha256,
    expectedPolicyEpoch: receipt.policyEpoch,
    expectedControlGeneration: receipt.controlGeneration,
  };
}

export async function submitLiveExecution(
  accountRef: string,
  shadowRef: string,
  receipt: PluginLiveConfirmationReceipt,
): Promise<PluginLiveExecutionRecord> {
  if (receipt.action !== "submit") {
    throw new PluginPlatformApiError("Receipt is not bound to Demo submit", 400);
  }
  return parsePluginLiveExecutionRecord(
    await managementRequest("/manage/live/execution/submit", {
      method: "POST",
      body: liveExecutionBody(accountRef, shadowRef, receipt),
      action: "live-demo-submit",
    }),
  );
}

export async function cancelLiveExecution(
  accountRef: string,
  shadowRef: string,
  receipt: PluginLiveConfirmationReceipt,
): Promise<PluginLiveExecutionRecord> {
  if (receipt.action !== "cancel") {
    throw new PluginPlatformApiError("Receipt is not bound to Demo cancel", 400);
  }
  return parsePluginLiveExecutionRecord(
    await managementRequest("/manage/live/execution/cancel", {
      method: "POST",
      body: liveExecutionBody(accountRef, shadowRef, receipt),
      action: "live-demo-cancel",
    }),
  );
}

export async function reconcileLiveExecution(
  accountRef: string,
  shadowRef: string,
): Promise<PluginLiveExecutionRecord> {
  const payload = object(
    await managementRequest("/manage/live/execution/reconcile", {
      method: "POST",
      body: { accountRef, shadowRef },
      action: "live-demo-reconcile",
    }),
    "Live execution reconciliation",
  );
  if (
    Object.keys(payload).sort().join(",") !== "execution,schemaVersion,shadow"
    || payload.schemaVersion !== "candlescope.live-execution-reconcile/1"
  ) throw new PluginPlatformApiError("Live execution reconciliation response is invalid", 502);
  return parsePluginLiveExecutionRecord(payload.execution);
}

export async function fetchLiveAuditExport(): Promise<Blob> {
  const session = consumeManagementSession();
  if (!session) throw new PluginPlatformApiError("Live audit export requires a trusted desktop session", 403);
  const response = await fetch(`${session.apiBase}/manage/live/audit-export`, {
    method: "GET",
    headers: {
      "X-CandleScope-Plugin-Session": session.sessionToken,
    },
    credentials: "omit",
  });
  if (!response.ok) {
    await responseJson(response);
    throw new PluginPlatformApiError("Live audit export failed", response.status);
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = Number(response.headers.get("Content-Length") ?? "0");
  if (
    contentType !== "application/json"
    || !Number.isSafeInteger(contentLength)
    || contentLength < 0
    || contentLength > 16 * 1024 * 1024
  ) throw new PluginPlatformApiError("Live audit export response is invalid", 502);
  const blob = await response.blob();
  if (
    blob.size === 0
    || blob.size > 16 * 1024 * 1024
    || (contentLength > 0 && blob.size !== contentLength)
  ) throw new PluginPlatformApiError("Live audit export length is invalid", 502);
  return blob;
}
