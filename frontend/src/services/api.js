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

export async function fetchKlines(symbol = "BTCUSDT", interval = "1m", limit = 500, marketType = "spot") {
    const url = `${API_BASE}/klines/?symbol=${symbol}&interval=${interval}&limit=${limit}&market_type=${marketType}`;
    return request(url);
}

export async function fetchKlinesHistory(symbol = "BTCUSDT", interval = "1h", days = 7, marketType = "spot") {
    const url = `${API_BASE}/klines/history?symbol=${symbol}&interval=${interval}&days=${days}&market_type=${marketType}`;
    return request(url);
}

export async function fetchKlinesBefore(
    symbol = "BTCUSDT",
    interval = "1h",
    before = 0,
    bars = 500,
    marketType = "spot",
) {
    const url = `${API_BASE}/klines/history/before?symbol=${symbol}&interval=${interval}&before=${before}&bars=${bars}&market_type=${marketType}`;
    return request(url);
}

export async function fetchLatestKlines(symbol = "BTCUSDT", interval = "1h", limit = 2, marketType = "spot") {
    const url = `${API_BASE}/klines/latest?symbol=${symbol}&interval=${interval}&limit=${limit}&market_type=${marketType}`;
    return request(url);
}

/**
 * Fetch klines for a specific time range by computing the necessary "days"
 * parameter from the range boundaries. Uses the /history endpoint internally.
 */
export async function fetchKlinesRange(symbol = "BTCUSDT", interval = "1h", startSec, endSec, marketType = "spot") {
    const nowSec = Math.floor(Date.now() / 1000);
    const daysFromNow = Math.ceil((nowSec - startSec) / 86400) + 1;
    const url = `${API_BASE}/klines/history?symbol=${symbol}&interval=${interval}&days=${Math.min(daysFromNow, 3650)}&market_type=${marketType}`;
    return request(url);
}

export async function resolveInterval(interval = "1h") {
    const url = `${API_BASE}/klines/resolve?interval=${interval}`;
    return request(url);
}

/** Single-interval WebSocket URL (legacy) */
export function getKlineStreamUrl(symbol = "BTCUSDT", interval = "1h", marketType = "spot") {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/klines?symbol=${symbol}&interval=${interval}&market_type=${marketType}`;
}

/** Multi-interval WebSocket URL — one connection for all intervals */
export function getMultiStreamUrl(symbol = "BTCUSDT", marketType = "spot") {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/klines_multi?symbol=${symbol}&market_type=${marketType}`;
}

// ── Exchange Info API ────────────────────────────────────────

export async function fetchExchangeInfo(marketType = "") {
    const params = marketType ? `?market_type=${marketType}` : "";
    const url = `${API_BASE}/symbols/exchange-info${params}`;
    return request(url);
}

export async function refreshExchangeInfo() {
    const url = `${API_BASE}/symbols/exchange-info/refresh`;
    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
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

export async function repairStoredCustomIntervals(marketType = "spot") {
    const url = `${API_BASE}/settings/storage/repair?market_type=${marketType}`;
    const response = await fetch(url, {
        method: "POST",
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function scanAndFillGaps(marketType = "spot") {
    const url = `${API_BASE}/settings/storage/gap-scan?market_type=${marketType}`;
    const response = await fetch(url, {
        method: "POST",
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

// ── Subscription API ────────────────────────────────────────

export async function fetchSubscriptions() {
    const url = `${API_BASE}/subscriptions/`;
    return request(url);
}

export async function fetchSubscription(symbol) {
    const url = `${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`;
    return request(url);
}

export async function updateSubscriptionTier(symbol, tier) {
    const url = `${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`;
    const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function removeSubscription(symbol) {
    const url = `${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * Sync all watchlist symbols to the backend.
 * New symbols auto-register as PRICE_ONLY; removed symbols downgrade to NONE.
 */
export async function syncWatchlistSymbols(symbols) {
    const url = `${API_BASE}/subscriptions/sync`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function fetchPricesSnapshot() {
    const url = `${API_BASE}/subscriptions/prices`;
    return request(url);
}

/** WebSocket URL for real-time price updates */
export function getPriceStreamUrl() {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/prices`;
}
