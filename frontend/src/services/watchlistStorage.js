import { parseSymbolKey, symbolKey } from "../utils/symbolKey";

export const WATCHLISTS_KEY = "candlescope-watchlists";

export function loadWatchlists() {
  try {
    const raw = localStorage.getItem(WATCHLISTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((wl) => ({
          ...wl,
          symbols: Array.isArray(wl.symbols)
            ? wl.symbols.map((item) => {
                const { symbol, marketType, exchange } = parseSymbolKey(item);
                return symbolKey(symbol, marketType, exchange);
              })
            : [],
        }));
      }
    }
  } catch { /* ignore */ }
  return [{ id: "default", name: "Watchlist", symbols: [], color: "#3b82f6" }];
}

export function saveWatchlists(lists) {
  localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(lists));
}
