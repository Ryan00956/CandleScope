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
import { API_BASE, httpBaseToWsBase } from "./apiConfig";

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}`);
  }
  return response.json();
}

// ═══════════════════════════════════════════════════════════════
//  Preset / Registry endpoints
// ═══════════════════════════════════════════════════════════════

/** Fetch built-in preset indicators list */
export async function fetchPresets() {
  return request(`${API_BASE}/indicators/presets`);
}

/** Fetch a single preset with full script */
export async function fetchPreset(presetId) {
  return request(`${API_BASE}/indicators/presets/${presetId}`);
}

/** Fetch raw indicator specs from registry (advanced) */
export async function fetchRegistry() {
  return request(`${API_BASE}/indicators/registry`);
}

/** Fetch a single indicator spec from registry */
export async function fetchRegistrySpec(name) {
  return request(`${API_BASE}/indicators/registry/${name}`);
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
export async function computeIndicator({ mode, securityMode, name, script, ohlcv, params, symbol, interval, marketType, exchange }) {
  const body = { ohlcv, params: params || {} };

  if (mode) {
    body.mode = mode;
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

  return request(`${API_BASE}/indicators/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Compute server-hosted indicator output for a K-line history range. */
export async function computeIndicatorRange({
  clientId,
  kind,
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
}) {
  return request(`${API_BASE}/indicators/range`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      kind,
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
    }),
  });
}

// ═══════════════════════════════════════════════════════════════
//  Custom indicator endpoints (placeholder for future)
// ═══════════════════════════════════════════════════════════════

/** Fetch user-saved custom indicators */
export async function fetchCustomIndicators() {
  try {
    return await request(`${API_BASE}/indicators/custom`);
  } catch {
    // Endpoint may not exist yet — return empty list
    return [];
  }
}

/** Save (create/update) a custom indicator */
export async function saveCustomIndicator({ id, kind, name, script, description, params, paramSchema, renderHints, schemaVersion, securityMode }) {
  return request(`${API_BASE}/indicators/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: schemaVersion || 1,
      id,
      kind: kind || "script",
      name,
      script,
      description,
      params,
      paramSchema,
      renderHints: renderHints || {},
      securityMode,
    }),
  });
}

/** Fetch current Pyne security defaults */
export async function fetchPyneSecurityPolicy() {
  return request(`${API_BASE}/indicators/pyne/security`);
}

/** WebSocket URL for backend-managed builtin indicator updates */
export function getIndicatorStreamUrl() {
  return `${httpBaseToWsBase(API_BASE)}/stream/indicators`;
}

/** Delete a custom indicator */
export async function deleteCustomIndicator(indicatorId) {
  return request(`${API_BASE}/indicators/custom/${indicatorId}`, {
    method: "DELETE",
  });
}
