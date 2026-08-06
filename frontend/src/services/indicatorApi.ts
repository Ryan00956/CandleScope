/**
 * Indicator API service layer.
 *
 * Supports both the new Indicator Engine (built-in indicators computed
 * server-side via optimized incremental algorithms) and legacy custom
 * script execution.
 *
 * API endpoints:
 *   GET  /indicators/presets          → list built-in indicator presets
 *   GET  /indicators/presets/{id}     → get single preset with script
 *   GET  /indicators/registry         → list raw indicator specs (advanced)
 *   POST /indicators/compute          → compute indicator (engine or script)
 */
import { API_BASE, httpBaseToWsBase } from "./apiConfig.js";
import { sharedControlRead } from "./sharedControlRead.js";
import {
  isIndicatorRecord,
  parseCustomIndicatorList,
  parseCustomIndicatorRecord,
  parseIndicatorDeleteResponse,
  parseIndicatorComputeBatchResponse,
  parseIndicatorPayloadEnvelope,
  parseIndicatorPreset,
  parseIndicatorPresetList,
  parseIndicatorRangeBatchResponse,
  parseIndicatorRegistryList,
  parseIndicatorRegistrySpec,
  parsePyneSecurityPolicy,
  parseScriptRuntimeCatalog,
} from "../features/indicators/indicatorContracts.js";
import type {
  CustomIndicatorRecord,
  CustomIndicatorSaveInput,
  IndicatorComputeRequest,
  IndicatorComputeBatchJob,
  IndicatorComputeBatchResponse,
  IndicatorDeleteResponse,
  IndicatorPayloadEnvelope,
  IndicatorPreset,
  IndicatorRangeBatchResponse,
  IndicatorRangeRequest,
  IndicatorRegistrySpec,
  PyneSecurityPolicy,
  ScriptRuntimeCatalog,
} from "../features/indicators/indicatorTypes.js";

interface IndicatorRequestOptions extends RequestInit {
  includeHttpStatus?: boolean;
}

function indicatorSignalOptions(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal };
}

async function request(
  url: string,
  options: IndicatorRequestOptions = {},
): Promise<unknown> {
  const { includeHttpStatus = false, ...fetchOptions } = options;
  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    const errorData: unknown = await response.json().catch(() => ({}));
    const detail = isIndicatorRecord(errorData) ? errorData.detail : undefined;
    throw new Error(
      typeof detail === "string" ? detail : `HTTP ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  if (
    includeHttpStatus &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    return { ...payload, __httpStatus: response.status };
  }
  return payload;
}

// ═══════════════════════════════════════════════════════════════
//  Preset / Registry endpoints
// ═══════════════════════════════════════════════════════════════

/** Fetch built-in preset indicators list */
export async function fetchPresets(): Promise<IndicatorPreset[]> {
  return parseIndicatorPresetList(
    await request(`${API_BASE}/indicators/presets`),
  );
}

/** Fetch a single preset with full script */
export async function fetchPreset(presetId: string): Promise<IndicatorPreset> {
  return sharedControlRead(`control:indicator-preset:${presetId}`, 5_000, async () => {
    const payload = await request(
      `${API_BASE}/indicators/presets/${encodeURIComponent(presetId)}`,
    );
    return parseIndicatorPreset(payload);
  });
}

/** Fetch raw indicator specs from registry (advanced) */
export async function fetchRegistry(): Promise<IndicatorRegistrySpec[]> {
  return parseIndicatorRegistryList(
    await request(`${API_BASE}/indicators/registry`),
  );
}

/** Fetch a single indicator spec from registry */
export async function fetchRegistrySpec(
  name: string,
): Promise<IndicatorRegistrySpec> {
  const payload = await request(
    `${API_BASE}/indicators/registry/${encodeURIComponent(name)}`,
  );
  return parseIndicatorRegistrySpec(payload);
}

/** Discover the script languages currently routed through ready runtime plugins. */
export async function fetchScriptRuntimes(
  signal?: AbortSignal,
): Promise<ScriptRuntimeCatalog> {
  return parseScriptRuntimeCatalog(
    await request(`${API_BASE}/indicators/runtimes`, indicatorSignalOptions(signal)),
  );
}

// ═══════════════════════════════════════════════════════════════
//  Compute endpoint
// ═══════════════════════════════════════════════════════════════

/**
 * Compute an indicator against OHLCV data.
 *
 * Supports two modes:
 *   1. Engine mode: provide `name` (e.g. "MA") + `params` → server-side engine
 *   2. Script mode: provide `script` + `params` → server-side Python exec
 *
 * The `script` field from presets starts with "# __ENGINE__:MA" which tells
 * the backend to route to the engine instead of exec.
 *
 * @param {Object} options
 * @param {string} [options.mode]    - "builtin" or "script"
 * @param {string} [options.securityMode] - "safe", "research", or "unsafe" for script mode
 * @param {string} [options.name]    - Indicator engine name (e.g. "MA", "MACD")
 * @param {string} [options.script]  - Python script (for custom indicators)
 * @param {Array}  options.ohlcv     - OHLCV bar data array
 * @param {Object} [options.params]  - Indicator parameters
 * @param {string} [options.symbol]  - Symbol context (default "UNKNOWN")
 * @param {string} [options.interval] - Interval context (default "1m")
 * @param {string} [options.exchange] - Exchange context (default "binance")
 * @returns {Promise<{ok: boolean, error: string|null, lines: Array, result: Object|null}>}
 */
export async function computeIndicator({
  mode,
  language,
  securityMode,
  name,
  script,
  ohlcv,
  params,
  symbol,
  interval,
  marketType,
  exchange,
}: IndicatorComputeRequest): Promise<IndicatorPayloadEnvelope> {
  const body: Record<string, unknown> = { ohlcv, params: params || {} };

  if (mode) {
    body.mode = mode;
  }
  if (language) {
    body.language = language;
  }
  if (securityMode) {
    body.securityMode = securityMode;
  }
  // Prefer engine name if available
  if (name) {
    body.name = name;
  }
  if (script) {
    body.script = script;
  }
  if (symbol) {
    body.symbol = symbol;
  }
  if (exchange) {
    body.exchange = exchange;
  }
  if (interval) {
    body.interval = interval;
  }
  if (marketType) {
    body.market_type = marketType;
  }

  const payload = await request(`${API_BASE}/indicators/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseIndicatorPayloadEnvelope(payload, "indicator.compute");
}

/** Compute explicit local indicators in one request with one shared OHLCV payload. */
export async function computeIndicatorBatch({
  jobs = [],
  signal,
}: {
  jobs?: IndicatorComputeBatchJob[];
  signal?: AbortSignal;
} = {}): Promise<IndicatorComputeBatchResponse> {
  if (jobs.length < 1 || jobs.length > 32) {
    throw new RangeError("Indicator compute batch requires between 1 and 32 jobs");
  }
  const first = jobs[0];
  if (!first) throw new RangeError("Indicator compute batch is empty");
  const shared = first.request;
  const seenClientIds = new Set<string>();
  const seenJobKeys = new Set<string>();
  const requests = jobs.map(({ clientId, jobKey, request: item }) => {
    if (
      !clientId.trim()
      || clientId !== clientId.trim()
      || clientId.length > 256
      || seenClientIds.has(clientId)
    ) {
      throw new TypeError(
        "Indicator compute batch client ids must be trimmed, non-empty, unique, and at most 256 characters",
      );
    }
    if (
      !jobKey.trim()
      || jobKey !== jobKey.trim()
      || jobKey.length > 256
      || seenJobKeys.has(jobKey)
    ) {
      throw new TypeError(
        "Indicator compute batch job keys must be trimmed, non-empty, unique, and at most 256 characters",
      );
    }
    if (
      item.ohlcv !== shared.ohlcv
      || item.exchange !== shared.exchange
      || item.marketType !== shared.marketType
      || item.symbol !== shared.symbol
      || item.interval !== shared.interval
    ) {
      throw new TypeError("Indicator compute batch jobs must share one chart context and OHLCV array");
    }
    seenClientIds.add(clientId);
    seenJobKeys.add(jobKey);
    return {
      clientId,
      jobKey,
      mode: item.mode,
      language: item.language,
      securityMode: item.securityMode,
      name: item.name,
      script: item.script,
      params: item.params || {},
    };
  });
  const payload = await request(`${API_BASE}/indicators/compute/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...indicatorSignalOptions(signal),
    body: JSON.stringify({
      schemaVersion: 1,
      context: {
        exchange: shared.exchange || "binance",
        marketType: shared.marketType || "spot",
        symbol: shared.symbol || "UNKNOWN",
        interval: shared.interval || "1m",
      },
      ohlcv: shared.ohlcv,
      requests,
    }),
  });
  const parsed = parseIndicatorComputeBatchResponse(payload);
  if (parsed.results.length !== jobs.length) {
    throw new Error(
      `Indicator compute batch returned ${parsed.results.length} results for ${jobs.length} jobs`,
    );
  }
  const expectedByKey = new Map(jobs.map((job) => [job.jobKey, job.clientId]));
  for (const result of parsed.results) {
    if (expectedByKey.get(result.jobKey) !== result.clientId) {
      throw new Error("Indicator compute batch returned an unexpected job identity");
    }
  }
  return parsed;
}

/** Compute server-hosted indicator output for a K-line history range. */
export async function computeIndicatorRange({
  clientId,
  kind,
  language,
  securityMode,
  name,
  customId,
  script,
  params,
  symbol,
  interval,
  marketType,
  exchange,
  start,
  end,
  reason,
  requestScope,
  requestGeneration,
  signal,
}: IndicatorRangeRequest): Promise<IndicatorPayloadEnvelope> {
  const payload = await request(`${API_BASE}/indicators/range`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...indicatorSignalOptions(signal),
    includeHttpStatus: true,
    body: JSON.stringify({
      clientId,
      kind,
      language,
      exchange,
      marketType,
      symbol,
      interval,
      name,
      customId,
      script,
      securityMode,
      params: params || {},
      start,
      end,
      reason,
      requestScope,
      requestGeneration,
    }),
  });
  return parseIndicatorPayloadEnvelope(payload, "indicator.range");
}

/** Compute multiple same-series indicator ranges using one shared backend K-line query. */
export async function computeIndicatorRangeBatch({
  requests = [],
  signal,
}: {
  requests?: IndicatorRangeRequest[];
  signal?: AbortSignal;
} = {}): Promise<IndicatorRangeBatchResponse> {
  const payload = await request(`${API_BASE}/indicators/range/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...indicatorSignalOptions(signal),
    body: JSON.stringify({ requests }),
  });
  return parseIndicatorRangeBatchResponse(payload);
}

// ═══════════════════════════════════════════════════════════════
//  Custom indicator endpoints (placeholder for future)
// ═══════════════════════════════════════════════════════════════

/** Fetch user-saved custom indicators */
export async function fetchCustomIndicators(): Promise<
  CustomIndicatorRecord[]
> {
  let payload: unknown;
  try {
    payload = await request(`${API_BASE}/indicators/custom`);
  } catch {
    // Endpoint may not exist yet — return empty list
    return [];
  }
  return parseCustomIndicatorList(payload);
}

/** Save (create/update) a custom indicator */
export async function saveCustomIndicator({
  id,
  kind,
  language,
  name,
  script,
  description,
  params,
  paramSchema,
  renderHints,
  schemaVersion,
  securityMode,
}: CustomIndicatorSaveInput): Promise<CustomIndicatorRecord> {
  const payload = await request(`${API_BASE}/indicators/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: schemaVersion || 1,
      id,
      kind: kind || "script",
      language,
      name,
      script,
      description,
      params,
      paramSchema,
      renderHints: renderHints || {},
      securityMode,
    }),
  });
  return parseCustomIndicatorRecord(payload);
}

/** Fetch current Pyne security defaults */
export async function fetchPyneSecurityPolicy(): Promise<PyneSecurityPolicy> {
  return parsePyneSecurityPolicy(
    await request(`${API_BASE}/indicators/pyne/security`),
  );
}

/** WebSocket URL for backend-managed builtin indicator updates */
export function getIndicatorStreamUrl(): string {
  return `${httpBaseToWsBase(API_BASE)}/stream/indicators`;
}

export interface IndicatorWebSocketLimits {
  maxSubscriptions: number;
}

/** Read the server-owned per-socket limit used by the window indicator broker. */
export async function fetchIndicatorWebSocketLimits(
  signal?: AbortSignal,
): Promise<IndicatorWebSocketLimits> {
  const payload = await request(
    `${API_BASE}/indicators/diagnostics`,
    indicatorSignalOptions(signal),
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Indicator diagnostics must be an object");
  }
  const websocket = (payload as Record<string, unknown>).websocket;
  if (!websocket || typeof websocket !== "object" || Array.isArray(websocket)) {
    throw new TypeError("Indicator diagnostics.websocket must be an object");
  }
  const maxSubscriptions = (websocket as Record<string, unknown>).maxSubscriptions;
  if (!Number.isSafeInteger(maxSubscriptions) || Number(maxSubscriptions) < 1) {
    throw new TypeError("Indicator diagnostics.websocket.maxSubscriptions must be a positive integer");
  }
  return { maxSubscriptions: Number(maxSubscriptions) };
}

/** Delete a custom indicator */
export async function deleteCustomIndicator(
  indicatorId: string,
): Promise<IndicatorDeleteResponse> {
  const payload = await request(
    `${API_BASE}/indicators/custom/${encodeURIComponent(indicatorId)}`,
    {
      method: "DELETE",
    },
  );
  return parseIndicatorDeleteResponse(payload);
}
