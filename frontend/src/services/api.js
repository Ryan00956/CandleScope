/**
 * CandleScope API service layer.
 */
const API_BASE = "http://localhost:8000/api/v1";
const CLIENT_INSTANCE_ID = Math.random().toString(36).slice(2, 10);

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

export async function fetchKlines(
    symbol = "BTCUSDT",
    interval = "1m",
    limit = 500,
    marketType = "spot",
    exchange = "binance",
) {
    const url = `${API_BASE}/klines/?symbol=${symbol}&interval=${interval}&limit=${limit}&exchange=${exchange}&market_type=${marketType}`;
    return request(url);
}

export async function fetchKlinesHistory(
    symbol = "BTCUSDT",
    interval = "1h",
    days = 7,
    marketType = "spot",
    exchange = "binance",
) {
    const url = `${API_BASE}/klines/history?symbol=${symbol}&interval=${interval}&days=${days}&exchange=${exchange}&market_type=${marketType}`;
    return request(url);
}

export async function fetchKlinesBefore(
    symbol = "BTCUSDT",
    interval = "1h",
    before = 0,
    bars = 500,
    marketType = "spot",
    exchange = "binance",
) {
    const url = `${API_BASE}/klines/history/before?symbol=${symbol}&interval=${interval}&before=${before}&bars=${bars}&exchange=${exchange}&market_type=${marketType}`;
    return request(url);
}

export async function fetchLatestKlines(
    symbol = "BTCUSDT",
    interval = "1h",
    limit = 2,
    marketType = "spot",
    exchange = "binance",
    source = "",
) {
    const params = new URLSearchParams({
        symbol,
        interval,
        limit: String(limit),
        exchange,
        market_type: marketType,
        client_id: CLIENT_INSTANCE_ID,
    });
    if (source) params.set("source", source);
    const url = `${API_BASE}/klines/latest?${params.toString()}`;
    return request(url);
}

export async function fetchKlinesRange(
    symbol = "BTCUSDT",
    interval = "1h",
    startSec,
    endSec,
    marketType = "spot",
    exchange = "binance",
    options = {},
) {
    const params = new URLSearchParams({
        symbol,
        interval,
        start_ms: String(Math.max(0, Math.floor(startSec * 1000))),
        end_ms: String(Math.max(0, Math.floor(endSec * 1000))),
        exchange,
        market_type: marketType,
        repair: options.repair || "async",
        wait_ms: String(options.waitMs ?? 0),
        strict: String(options.strict ?? false),
    });
    const url = `${API_BASE}/klines/range?${params.toString()}`;
    return request(url);
}

export async function resolveInterval(interval = "1h") {
    const url = `${API_BASE}/klines/resolve?interval=${interval}`;
    return request(url);
}

/** Single-interval WebSocket URL (legacy) */
export function getKlineStreamUrl(symbol = "BTCUSDT", interval = "1h", marketType = "spot", exchange = "binance") {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/klines?symbol=${symbol}&interval=${interval}&exchange=${exchange}&market_type=${marketType}`;
}

/** Multi-interval WebSocket URL — one connection for all intervals */
export function getMultiStreamUrl(symbol = "BTCUSDT", marketType = "spot", exchange = "binance") {
    const wsBase = httpBaseToWsBase(API_BASE);
    return `${wsBase}/stream/klines_multi?symbol=${symbol}&exchange=${exchange}&market_type=${marketType}`;
}

// ── Exchange Info API ────────────────────────────────────────

export async function fetchExchangeInfo(marketType = "", exchange = "") {
    const searchParams = new URLSearchParams();
    if (marketType) searchParams.set("market_type", marketType);
    if (exchange) searchParams.set("exchange", exchange);
    const params = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const url = `${API_BASE}/symbols/exchange-info${params}`;
    return request(url);
}

export async function refreshExchangeInfo(exchange = "") {
    const params = exchange ? `?exchange=${encodeURIComponent(exchange)}` : "";
    const url = `${API_BASE}/symbols/exchange-info/refresh${params}`;
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

export async function updateCacheLimits({ dbLimits, ephemeralBars }) {
    const url = `${API_BASE}/settings/cache-limits`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            db_limits: dbLimits,
            ephemeral_bars: ephemeralBars,
        }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function repairStoredCustomIntervals({ marketType = "spot", exchange = "binance", symbols = [] } = {}) {
    const url = `${API_BASE}/settings/storage/repair?market_type=${marketType}&exchange=${exchange}`;
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

export async function scanAndFillGaps({ marketType = "spot", exchange = "binance", symbols = [] } = {}) {
    const url = `${API_BASE}/settings/storage/gap-scan?market_type=${marketType}&exchange=${exchange}`;
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

export async function fetchExchanges() {
    return request(`${API_BASE}/exchanges/`);
}

export async function fetchExchangeCapabilities(exchange = "binance") {
    return request(`${API_BASE}/exchanges/${encodeURIComponent(exchange)}/capabilities`);
}
