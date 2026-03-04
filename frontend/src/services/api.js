/**
 * CandleScope API service layer.
 */
const API_BASE = "http://localhost:8000/api/v1";

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
