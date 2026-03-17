/**
 * CandleScope API service layer.
 */
const API_BASE = "http://localhost:8000/api/v1";

function httpBaseToWsBase(httpBase) {
    if (httpBase.startsWith("https://")) return `wss://${httpBase.slice("https://".length)}`;
    if (httpBase.startsWith("http://")) return `ws://${httpBase.slice("http://".length)}`;
    return httpBase;
}

async function request(url) {
    const response = await fetch(url);
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function fetchKlines(symbol = "BTCUSDT", interval = "1m", limit = 500) {
    const url = `${API_BASE}/klines/?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    return request(url);
}

export async function fetchKlinesHistory(symbol = "BTCUSDT", interval = "1h", days = 7) {
    const url = `${API_BASE}/klines/history?symbol=${symbol}&interval=${interval}&days=${days}`;
    return request(url);
}

export async function fetchKlinesBefore(
    symbol = "BTCUSDT",
    interval = "1h",
    before = 0,
    bars = 500,
) {
    const url = `${API_BASE}/klines/history/before?symbol=${symbol}&interval=${interval}&before=${before}&bars=${bars}`;
    return request(url);
}

export async function fetchLatestKlines(symbol = "BTCUSDT", interval = "1h", limit = 2) {
    const url = `${API_BASE}/klines/latest?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    return request(url);
}

/**
 * Fetch klines for a specific time range by computing the necessary "days"
 * parameter from the range boundaries. Uses the /history endpoint internally.
 */
export async function fetchKlinesRange(symbol = "BTCUSDT", interval = "1h", startSec, endSec) {
    const nowSec = Math.floor(Date.now() / 1000);
    const daysFromNow = Math.ceil((nowSec - startSec) / 86400) + 1;
    const url = `${API_BASE}/klines/history?symbol=${symbol}&interval=${interval}&days=${Math.min(daysFromNow, 3650)}`;
    return request(url);
}

export async function resolveInterval(interval = "1h") {
    const url = `${API_BASE}/klines/resolve?interval=${interval}`;
    return request(url);
}

/** Single-interval WebSocket URL (legacy) */
export function getKlineStreamUrl(symbol = "BTCUSDT", interval = "1h") {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/klines?symbol=${symbol}&interval=${interval}`;
}

/** Multi-interval WebSocket URL — one connection for all intervals */
export function getMultiStreamUrl(symbol = "BTCUSDT") {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/klines_multi?symbol=${symbol}`;
}

// ── Proxy Settings API ──────────────────────────────────────

export async function fetchProxySettings() {
    const url = `${API_BASE}/settings/proxy`;
    return request(url);
}

export async function updateProxySettings({ mode, custom_proxy }) {
    const url = `${API_BASE}/settings/proxy`;
    const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, custom_proxy: custom_proxy || null }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function testProxyConnection({ mode, custom_proxy }) {
    const url = `${API_BASE}/settings/proxy/test`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, custom_proxy: custom_proxy || null }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function repairStoredCustomIntervals() {
    const url = `${API_BASE}/settings/storage/repair`;
    const response = await fetch(url, {
        method: "POST",
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function scanAndFillGaps() {
    const url = `${API_BASE}/settings/storage/gap-scan`;
    const response = await fetch(url, {
        method: "POST",
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}
