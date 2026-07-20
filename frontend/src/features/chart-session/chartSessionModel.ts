import { canonicalizeIntervalValue } from "../../utils/intervals.js";
import { inferExchangeFromSymbol } from "../../utils/symbolKey.js";
import type { ChartSession, UserPrefs } from "./chartSessionTypes.js";

export const USER_PREFS_KEY = "candlescope-user-prefs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function loadUserPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem(USER_PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveUserPrefs(prefs: UserPrefs): void {
  localStorage.setItem(USER_PREFS_KEY, JSON.stringify(prefs));
}

export function updateUserPref(key: string, value: unknown): void {
  const prefs = loadUserPrefs();
  prefs[key] = value;
  saveUserPrefs(prefs);
}

export function loadInitialChartSession(): ChartSession {
  const prefs = loadUserPrefs();
  const symbol = nonEmptyString(prefs.lastSymbol) || "BTCUSDT";
  return {
    symbol,
    exchange: nonEmptyString(prefs.lastExchange)
      || inferExchangeFromSymbol(symbol, "binance"),
    marketType: nonEmptyString(prefs.lastMarketType) || "spot",
    interval: canonicalizeIntervalValue(prefs.lastInterval) || "1h",
  };
}
