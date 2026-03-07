/**
 * Indicator API service layer.
 */
const API_BASE = "http://localhost:8000/api/v1";

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}`);
  }
  return response.json();
}

/** Fetch built-in preset indicators list */
export async function fetchPresets() {
  return request(`${API_BASE}/indicators/presets`);
}

/** Fetch a single preset with full script */
export async function fetchPreset(presetId) {
  return request(`${API_BASE}/indicators/presets/${presetId}`);
}

/** Fetch user-saved custom indicators */
export async function fetchCustomIndicators() {
  return request(`${API_BASE}/indicators/custom`);
}

/** Save (create/update) a custom indicator */
export async function saveCustomIndicator({ id, name, script, description, params, paramSchema }) {
  return request(`${API_BASE}/indicators/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, script, description, params, paramSchema }),
  });
}

/** Delete a custom indicator */
export async function deleteCustomIndicator(indicatorId) {
  return request(`${API_BASE}/indicators/custom/${indicatorId}`, {
    method: "DELETE",
  });
}

/** Compute an indicator against OHLCV data */
export async function computeIndicator({ script, ohlcv, params }) {
  return request(`${API_BASE}/indicators/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, ohlcv, params }),
  });
}
