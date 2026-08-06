/**
 * CandleScope API transport layer.
 *
 * The low-level request boundary intentionally returns unknown. Endpoint
 * functions that have migrated consumers must validate their own payloads.
 */
import { API_BASE, httpBaseToWsBase } from "./apiConfig.js";
import {
  isJsonRecord,
  parseExchangeCapability,
  parseExchangeListResponse,
  parseKlineResponse,
  parseSubscription,
  parseSubscriptionListResponse,
  parseSubscriptionRemovalResponse,
  parseSubscriptionSyncResponse,
  type ExchangeCapabilityPayload,
  type ExchangeListPayload,
  type SubscriptionListPayload,
  type SubscriptionPayload,
  type SubscriptionRemovalPayload,
  type SubscriptionSyncPayload,
  type TransportKlineResponse,
} from "./apiPayloadParsers.js";
import { buildSubscriptionTierRequestBody } from "./subscriptionApiPolicy.js";
import type {
  SubscriptionRequestOptions,
  SubscriptionTier,
} from "../features/watchlist/watchlistTypes.js";

const CLIENT_INSTANCE_ID = Math.random().toString(36).slice(2, 10);

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequestOptions {
  method?: HttpMethod;
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
}

export interface ApiErrorInit {
  status: number;
  detail?: string | null;
  code?: string | null;
  url: string;
}

export interface RequestSignalOptions {
  signal?: AbortSignal;
  demandScope?: string;
  demandGeneration?: number;
}

export interface KlineHistoryOptions extends RequestSignalOptions {
  countBack?: number | null;
  maxWaitMs?: number;
  intent?: "viewport" | "active_hydration";
}

export interface KlineBeforeOptions extends RequestSignalOptions {
  maxWaitMs?: number;
}

export interface KlineRangeOptions extends RequestSignalOptions {
  repair?: string;
  waitMs?: number;
  strict?: boolean;
}

function requestSignalOptions(signal: AbortSignal | undefined): RequestSignalOptions {
  return signal === undefined ? {} : { signal };
}

type UrlParams = Record<string, unknown>;
type UnknownRecord = Record<string, unknown>;

export function getClientInstanceId(): string {
  return CLIENT_INSTANCE_ID;
}

export class ApiError extends Error {
  status: number;
  detail: string;
  code: string | null;
  url: string;

  constructor({ status, detail, code, url }: ApiErrorInit) {
    const resolvedDetail = detail || `HTTP ${status}`;
    super(resolvedDetail);
    this.name = "ApiError";
    this.status = status;
    this.detail = resolvedDetail;
    this.code = code || null;
    this.url = url;
  }
}

function buildUrl(path: string, params: UrlParams = {}): string {
  return buildUrlWithBase(API_BASE, path, params);
}

function buildWsUrl(path: string, params: UrlParams = {}): string {
  return buildUrlWithBase(httpBaseToWsBase(API_BASE), path, params);
}

function buildUrlWithBase(base: string, path: string, params: UrlParams = {}): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return `${base}${path}${query ? `?${query}` : ""}`;
}

export async function request(
  url: string,
  { method = "GET", headers, body, signal }: ApiRequestOptions = {},
): Promise<unknown> {
  const hasFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const requestHeaders = body != null && !hasFormData
    ? { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers).entries()) }
    : headers;
  let requestBody: BodyInit | null | undefined;
  if (body == null) requestBody = body;
  else if (typeof body === "string") requestBody = body;
  else if (typeof FormData !== "undefined" && body instanceof FormData) requestBody = body;
  else requestBody = JSON.stringify(body);
  const response = await fetch(url, {
    method,
    ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
    ...(requestBody === undefined ? {} : { body: requestBody }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const errorData: unknown = await response.json().catch(() => ({}));
    const rawDetail = isJsonRecord(errorData) ? errorData.detail : undefined;
    const detail = typeof rawDetail === "string"
      ? rawDetail
      : isJsonRecord(rawDetail)
        ? JSON.stringify(rawDetail)
      : `HTTP ${response.status}`;
    const code = isJsonRecord(rawDetail) && typeof rawDetail.code === "string"
      ? rawDetail.code
      : null;
    throw new ApiError({ status: response.status, detail, code, url });
  }
  if (response.status === 204) return null;
  const payload: unknown = await response.json();
  return payload;
}

export async function fetchKlines(
  symbol = "BTCUSDT",
  interval = "1m",
  limit = 500,
  marketType = "spot",
  exchange = "binance",
  options: RequestSignalOptions = {},
): Promise<TransportKlineResponse> {
  const payload = await request(buildUrl("/klines/", {
    symbol,
    interval,
    limit,
    exchange,
    market_type: marketType,
  }), requestSignalOptions(options.signal));
  return parseKlineResponse(payload, "GET /klines/");
}

export async function fetchKlinesHistory(
  symbol = "BTCUSDT",
  interval = "1h",
  days: number | null | undefined = 7,
  marketType = "spot",
  exchange = "binance",
  options: KlineHistoryOptions = {},
): Promise<TransportKlineResponse> {
  const payload = await request(buildUrl("/klines/history", {
    symbol,
    interval,
    days: options.countBack == null ? days : undefined,
    count_back: options.countBack,
    exchange,
    market_type: marketType,
    max_wait_ms: options.maxWaitMs,
    intent: options.intent,
    request_scope: options.demandScope,
    request_generation: options.demandGeneration,
  }), requestSignalOptions(options.signal));
  return parseKlineResponse(payload, "GET /klines/history");
}

export async function fetchKlinesBefore(
  symbol = "BTCUSDT",
  interval = "1h",
  before = 0,
  bars = 500,
  marketType = "spot",
  exchange = "binance",
  options: KlineBeforeOptions = {},
): Promise<TransportKlineResponse> {
  const payload = await request(buildUrl("/klines/history/before", {
    symbol,
    interval,
    before,
    bars,
    exchange,
    market_type: marketType,
    max_wait_ms: options.maxWaitMs,
    request_scope: options.demandScope,
    request_generation: options.demandGeneration,
  }), requestSignalOptions(options.signal));
  return parseKlineResponse(payload, "GET /klines/history/before");
}

export async function fetchLatestKlines(
  symbol = "BTCUSDT",
  interval = "1h",
  limit = 2,
  marketType = "spot",
  exchange = "binance",
  source = "",
  options: RequestSignalOptions = {},
): Promise<TransportKlineResponse> {
  const payload = await request(buildUrl("/klines/latest", {
    symbol,
    interval,
    limit,
    exchange,
    market_type: marketType,
    client_id: CLIENT_INSTANCE_ID,
    source,
  }), requestSignalOptions(options.signal));
  return parseKlineResponse(payload, "GET /klines/latest");
}

export async function fetchKlinesRange(
  symbol = "BTCUSDT",
  interval = "1h",
  startSec = Number.NaN,
  endSec = Number.NaN,
  marketType = "spot",
  exchange = "binance",
  options: KlineRangeOptions = {},
): Promise<TransportKlineResponse> {
  const payload = await request(buildUrl("/klines/range", {
    symbol,
    interval,
    start_ms: Math.max(0, Math.floor(startSec * 1000)),
    end_ms: Math.max(0, Math.floor(endSec * 1000)),
    exchange,
    market_type: marketType,
    repair: options.repair || "async",
    wait_ms: options.waitMs ?? 0,
    strict: options.strict ?? false,
    request_scope: options.demandScope,
    request_generation: options.demandGeneration,
  }), requestSignalOptions(options.signal));
  return parseKlineResponse(payload, "GET /klines/range");
}

export async function resolveInterval(
  interval = "1h",
  options: RequestSignalOptions = {},
): Promise<unknown> {
  return request(buildUrl("/klines/resolve", { interval }), requestSignalOptions(options.signal));
}

/** Single-interval WebSocket URL (legacy). */
export function getKlineStreamUrl(
  symbol = "BTCUSDT",
  interval = "1h",
  marketType = "spot",
  exchange = "binance",
): string {
  return buildWsUrl("/stream/klines", {
    symbol,
    interval,
    exchange,
    market_type: marketType,
  });
}

/** Multi-interval WebSocket URL — one connection for all intervals. */
export function getMultiStreamUrl(
  symbol = "BTCUSDT",
  marketType = "spot",
  exchange = "binance",
): string {
  return buildWsUrl("/stream/klines_multi", {
    symbol,
    exchange,
    market_type: marketType,
  });
}

/** Default-off multi-instrument K-line WebSocket URL. */
export function getBatchKlineStreamUrl(): string {
  return buildWsUrl("/stream/klines_batch");
}

// Exchange-info payloads remain unknown until their T10 symbol/settings owners migrate.
export async function fetchExchangeInfo(marketType = "", exchange = ""): Promise<unknown> {
  return request(buildUrl("/symbols/exchange-info", {
    market_type: marketType,
    exchange,
  }));
}

export async function fetchSupportedExchanges(): Promise<ExchangeListPayload> {
  const payload = await request(`${API_BASE}/exchanges/`);
  return parseExchangeListResponse(payload, "GET /exchanges/");
}

export async function refreshExchangeInfo(exchange = ""): Promise<unknown> {
  return request(buildUrl("/symbols/exchange-info/refresh", { exchange }), { method: "POST" });
}

interface ProxySettingsInput {
  mode: string;
  custom_proxy?: string | null;
}

export async function fetchProxySettings(): Promise<unknown> {
  return request(`${API_BASE}/settings/proxy`);
}

export async function updateProxySettings({ mode, custom_proxy }: ProxySettingsInput): Promise<unknown> {
  return request(`${API_BASE}/settings/proxy`, {
    method: "PUT",
    body: { mode, custom_proxy: custom_proxy || null },
  });
}

export async function testProxyConnection({ mode, custom_proxy }: ProxySettingsInput): Promise<unknown> {
  return request(`${API_BASE}/settings/proxy/test`, {
    method: "POST",
    body: { mode, custom_proxy: custom_proxy || null },
  });
}

export interface CacheLimitsInput {
  dbLimits?: unknown;
  ephemeralBars?: unknown;
  sqliteBudgetBytes?: number | null;
  storageRowLimitsEnabled?: boolean;
}

export function buildCacheLimitsRequestBody(input: CacheLimitsInput): UnknownRecord {
  const body: UnknownRecord = {};
  if (Object.hasOwn(input, "dbLimits")) body.db_limits = input.dbLimits;
  if (Object.hasOwn(input, "ephemeralBars")) body.ephemeral_bars = input.ephemeralBars;
  if (Object.hasOwn(input, "sqliteBudgetBytes")) {
    body.sqlite_budget_bytes = input.sqliteBudgetBytes;
  }
  if (Object.hasOwn(input, "storageRowLimitsEnabled")) {
    body.storage_row_limits_enabled = input.storageRowLimitsEnabled;
  }
  return body;
}

export async function updateCacheLimits(input: CacheLimitsInput): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-limits`, {
    method: "POST",
    body: buildCacheLimitsRequestBody(input),
  });
}

export async function fetchCacheDiagnostics(options: RequestSignalOptions = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-diagnostics`, requestSignalOptions(options.signal));
}

interface CacheAccessEvent extends UnknownRecord {
  exchange?: string;
  marketType?: string;
  market_type?: string;
  symbol?: string;
  interval?: string;
  action?: string;
  source?: string;
  owner?: string;
  weight?: unknown;
  detail?: unknown;
  key?: string;
  occurredAtMs?: number | null;
  occurred_at_ms?: number | null;
}

export async function recordCacheAccess(event: CacheAccessEvent = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-access`, {
    method: "POST",
    body: {
      exchange: event.exchange || "binance",
      market_type: event.marketType || event.market_type || "spot",
      symbol: event.symbol,
      interval: event.interval || "*",
      action: event.action || "frontend-access",
      source: event.source || event.owner || "frontend",
      weight: event.weight ?? null,
      detail: event.detail || { key: event.key, owner: event.owner },
      occurred_at_ms: event.occurredAtMs || event.occurred_at_ms || null,
    },
  });
}

export async function planBackendMemoryGc(policy: UnknownRecord = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-gc/backend-memory/dry-run`, { method: "POST", body: policy });
}

export async function runBackendMemoryGc(policy: UnknownRecord = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-gc/backend-memory/run`, { method: "POST", body: policy });
}

export async function runAutoGc(policy: UnknownRecord = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-gc/auto/run`, { method: "POST", body: policy });
}

interface StoragePolicy extends UnknownRecord {
  dbLimits?: unknown;
  sqliteBudgetBytes?: number | null;
  storageRowLimitsEnabled?: boolean;
}

export async function planStorageGc(policy: StoragePolicy = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-gc/storage/dry-run`, {
    method: "POST",
    body: {
      db_limits: policy.dbLimits,
      sqlite_budget_bytes: policy.sqliteBudgetBytes ?? null,
      storage_row_limits_enabled: policy.storageRowLimitsEnabled,
    },
  });
}

export async function runStorageGc({
  batchSize = 1_000,
  policy = {},
}: { batchSize?: number; policy?: StoragePolicy } = {}): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-gc/storage/run`, {
    method: "POST",
    body: {
      db_limits: policy.dbLimits,
      sqlite_budget_bytes: policy.sqliteBudgetBytes ?? null,
      storage_row_limits_enabled: policy.storageRowLimitsEnabled,
      confirm: true,
      batch_size: batchSize,
    },
  });
}

export async function vacuumStorage(): Promise<unknown> {
  return request(`${API_BASE}/settings/cache-gc/storage/vacuum`, {
    method: "POST",
    body: { confirm: true },
  });
}

interface StorageMaintenanceInput {
  marketType?: string;
  exchange?: string;
  symbols?: string[];
}

export async function repairStoredCustomIntervals({
  marketType = "spot",
  exchange = "binance",
  symbols = [],
}: StorageMaintenanceInput = {}): Promise<unknown> {
  return request(buildUrl("/settings/storage/repair", {
    market_type: marketType,
    exchange,
  }), { method: "POST", body: { symbols } });
}

export async function scanAndFillGaps({
  marketType = "spot",
  exchange = "binance",
  symbols = [],
}: StorageMaintenanceInput = {}): Promise<unknown> {
  return request(buildUrl("/settings/storage/gap-scan", {
    market_type: marketType,
    exchange,
  }), { method: "POST", body: { symbols } });
}

export async function fetchSubscriptions(): Promise<SubscriptionListPayload> {
  const payload = await request(`${API_BASE}/subscriptions/`);
  return parseSubscriptionListResponse(payload, "GET /subscriptions/");
}

export async function fetchSubscription(symbol: string): Promise<SubscriptionPayload> {
  const payload = await request(`${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`);
  return parseSubscription(payload, "GET /subscriptions/{symbol}");
}

export async function updateSubscriptionTier(
  symbol: string,
  tier: SubscriptionTier,
  options: SubscriptionRequestOptions = {},
): Promise<SubscriptionPayload> {
  const payload = await request(`${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`, {
    method: "PUT",
    body: buildSubscriptionTierRequestBody(tier, options),
  });
  return parseSubscription(payload, "PUT /subscriptions/{symbol}");
}

export async function removeSubscription(symbol: string): Promise<SubscriptionRemovalPayload> {
  const payload = await request(`${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
  return parseSubscriptionRemovalResponse(payload, "DELETE /subscriptions/{symbol}");
}

export async function syncWatchlistSymbols(symbols: string[]): Promise<SubscriptionSyncPayload> {
  const payload = await request(`${API_BASE}/subscriptions/sync`, {
    method: "POST",
    body: { symbols },
  });
  return parseSubscriptionSyncResponse(payload, "POST /subscriptions/sync");
}

export async function fetchPricesSnapshot(): Promise<unknown> {
  return request(`${API_BASE}/subscriptions/prices`);
}

/** WebSocket URL for real-time price updates. */
export function getPriceStreamUrl(): string {
  return `${httpBaseToWsBase(API_BASE)}/stream/prices`;
}

export async function fetchExchanges(): Promise<ExchangeListPayload> {
  const payload = await request(`${API_BASE}/exchanges/`);
  return parseExchangeListResponse(payload, "GET /exchanges/");
}

export async function fetchExchangeCapabilities(exchange = "binance"): Promise<ExchangeCapabilityPayload> {
  const payload = await request(`${API_BASE}/exchanges/${encodeURIComponent(exchange)}/capabilities`);
  return parseExchangeCapability(payload, "GET /exchanges/{exchange}/capabilities");
}
