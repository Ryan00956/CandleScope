/**
 * CandleScope API service layer.
 */
import { API_BASE, httpBaseToWsBase } from "./apiConfig";

const CLIENT_INSTANCE_ID = Math.random().toString(36).slice(2, 10);

export class ApiError extends Error {
    constructor({ status, detail, url }) {
        super(detail || `HTTP ${status}`);
        this.name = "ApiError";
        this.status = status;
        this.detail = detail || `HTTP ${status}`;
        this.url = url;
    }
}

function buildUrl(path, params = {}) {
    return buildUrlWithBase(API_BASE, path, params);
}

function buildWsUrl(path, params = {}) {
    return buildUrlWithBase(httpBaseToWsBase(API_BASE), path, params);
}

function buildUrlWithBase(base, path, params = {}) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        searchParams.set(key, String(value));
    }
    const query = searchParams.toString();
    return `${base}${path}${query ? `?${query}` : ""}`;
}

async function request(url, { method = "GET", headers, body, signal } = {}) {
    const requestHeaders = body && !(body instanceof FormData)
        ? { "Content-Type": "application/json", ...headers }
        : headers;
    const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body && !(typeof body === "string" || body instanceof FormData)
            ? JSON.stringify(body)
            : body,
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

export async function fetchKlines(
    symbol = "BTCUSDT",
    interval = "1m",
    limit = 500,
    marketType = "spot",
    exchange = "binance",
    options = {},
) {
    return request(buildUrl("/klines/", {
        symbol,
        interval,
        limit,
        exchange,
        market_type: marketType,
    }), { signal: options.signal });
}

export async function fetchKlinesHistory(
    symbol = "BTCUSDT",
    interval = "1h",
    days = 7,
    marketType = "spot",
    exchange = "binance",
    options = {},
) {
    return request(buildUrl("/klines/history", {
        symbol,
        interval,
        days,
        exchange,
        market_type: marketType,
    }), { signal: options.signal });
}

export async function fetchKlinesBefore(
    symbol = "BTCUSDT",
    interval = "1h",
    before = 0,
    bars = 500,
    marketType = "spot",
    exchange = "binance",
    options = {},
) {
    return request(buildUrl("/klines/history/before", {
        symbol,
        interval,
        before,
        bars,
        exchange,
        market_type: marketType,
    }), { signal: options.signal });
}

export async function fetchLatestKlines(
    symbol = "BTCUSDT",
    interval = "1h",
    limit = 2,
    marketType = "spot",
    exchange = "binance",
    source = "",
    options = {},
) {
    const params = {
        symbol,
        interval,
        limit,
        exchange,
        market_type: marketType,
        client_id: CLIENT_INSTANCE_ID,
        source,
    };
    return request(buildUrl("/klines/latest", params), { signal: options.signal });
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
    const params = {
        symbol,
        interval,
        start_ms: Math.max(0, Math.floor(startSec * 1000)),
        end_ms: Math.max(0, Math.floor(endSec * 1000)),
        exchange,
        market_type: marketType,
        repair: options.repair || "async",
        wait_ms: options.waitMs ?? 0,
        strict: options.strict ?? false,
    };
    return request(buildUrl("/klines/range", params), { signal: options.signal });
}

export async function resolveInterval(interval = "1h", options = {}) {
    return request(buildUrl("/klines/resolve", { interval }), { signal: options.signal });
}

/** Single-interval WebSocket URL (legacy) */
export function getKlineStreamUrl(symbol = "BTCUSDT", interval = "1h", marketType = "spot", exchange = "binance") {
    return buildWsUrl("/stream/klines", {
        symbol,
        interval,
        exchange,
        market_type: marketType,
    });
}

/** Multi-interval WebSocket URL — one connection for all intervals */
export function getMultiStreamUrl(symbol = "BTCUSDT", marketType = "spot", exchange = "binance") {
    return buildWsUrl("/stream/klines_multi", {
        symbol,
        exchange,
        market_type: marketType,
    });
}

// ── Exchange Info API ────────────────────────────────────────

export async function fetchExchangeInfo(marketType = "", exchange = "") {
    return request(buildUrl("/symbols/exchange-info", {
        market_type: marketType,
        exchange,
    }));
}

export async function fetchSupportedExchanges() {
    const url = `${API_BASE}/exchanges/`;
    return request(url);
}

export async function refreshExchangeInfo(exchange = "") {
    return request(buildUrl("/symbols/exchange-info/refresh", { exchange }), { method: "POST" });
}

// ── Proxy Settings API ──────────────────────────────────────

export async function fetchProxySettings() {
    const url = `${API_BASE}/settings/proxy`;
    return request(url);
}

export async function updateProxySettings({ mode, custom_proxy }) {
    const url = `${API_BASE}/settings/proxy`;
    return request(url, {
        method: "PUT",
        body: { mode, custom_proxy: custom_proxy || null },
    });
}

export async function testProxyConnection({ mode, custom_proxy }) {
    const url = `${API_BASE}/settings/proxy/test`;
    return request(url, {
        method: "POST",
        body: { mode, custom_proxy: custom_proxy || null },
    });
}

export async function updateCacheLimits({ dbLimits, ephemeralBars }) {
    const url = `${API_BASE}/settings/cache-limits`;
    return request(url, {
        method: "POST",
        body: {
            db_limits: dbLimits,
            ephemeral_bars: ephemeralBars,
        },
    });
}

export async function repairStoredCustomIntervals({ marketType = "spot", exchange = "binance", symbols = [] } = {}) {
    return request(buildUrl("/settings/storage/repair", {
        market_type: marketType,
        exchange,
    }), {
        method: "POST",
        body: { symbols },
    });
}

export async function scanAndFillGaps({ marketType = "spot", exchange = "binance", symbols = [] } = {}) {
    return request(buildUrl("/settings/storage/gap-scan", {
        market_type: marketType,
        exchange,
    }), {
        method: "POST",
        body: { symbols },
    });
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
    return request(url, {
        method: "PUT",
        body: { tier },
    });
}

export async function removeSubscription(symbol) {
    const url = `${API_BASE}/subscriptions/${encodeURIComponent(symbol)}`;
    return request(url, { method: "DELETE" });
}

/**
 * Sync all watchlist symbols to the backend.
 * New symbols auto-register as PRICE_ONLY; removed symbols downgrade to NONE.
 */
export async function syncWatchlistSymbols(symbols) {
    const url = `${API_BASE}/subscriptions/sync`;
    return request(url, {
        method: "POST",
        body: { symbols },
    });
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
