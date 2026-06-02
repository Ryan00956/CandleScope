import { inferExchangeFromSymbol } from "../../utils/symbolKey";

export const USER_PREFS_KEY = "candlescope-user-prefs";

export function loadUserPrefs() {
  try {
    const raw = localStorage.getItem(USER_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveUserPrefs(prefs) {
  localStorage.setItem(USER_PREFS_KEY, JSON.stringify(prefs));
}

export function updateUserPref(key, value) {
  const prefs = loadUserPrefs();
  prefs[key] = value;
  saveUserPrefs(prefs);
}

export function loadInitialChartSession() {
  const prefs = loadUserPrefs();
  const symbol = prefs.lastSymbol || "BTCUSDT";
  return {
    symbol,
    exchange: prefs.lastExchange || inferExchangeFromSymbol(symbol, "binance"),
    marketType: prefs.lastMarketType || "spot",
    interval: prefs.lastInterval || "1h",
  };
}