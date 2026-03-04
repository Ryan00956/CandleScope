/**
 * CandleScope API 服务层
 * 封装所有与后端的通信
 */

const API_BASE = "http://localhost:8000/api/v1";

/**
 * 获取最新K线数据
 * @param {string} symbol - 交易对，如 "BTCUSDT"
 * @param {string} interval - 时间周期，如 "1m", "1h"
 * @param {number} limit - K线数量
 * @returns {Promise<{symbol, interval, count, data}>}
 */
export async function fetchKlines(symbol = "BTCUSDT", interval = "1m", limit = 500) {
    const url = `${API_BASE}/klines/?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * 获取历史K线数据（多天）
 * @param {string} symbol
 * @param {string} interval
 * @param {number} days
 * @returns {Promise<{symbol, interval, days, count, data}>}
 */
export async function fetchKlinesHistory(symbol = "BTCUSDT", interval = "1h", days = 7) {
    const url = `${API_BASE}/klines/history?symbol=${symbol}&interval=${interval}&days=${days}`;
    const response = await fetch(url);

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
    }

    return response.json();
}
