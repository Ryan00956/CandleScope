/**
 * Shared helpers for composite symbol keys.
 *
 * A composite key uniquely identifies a symbol across markets:
 *   "spot:BTCUSDT"  /  "futures:ETHUSDT"
 *
 * This avoids collisions when spot and futures share the same
 * symbol string (e.g. both have "BTCUSDT").
 */

/** Build a composite key: "spot:BTCUSDT" */
export function symbolKey(symbol, marketType) {
  return `${marketType || "spot"}:${symbol}`;
}

/** Parse a composite key back into { symbol, marketType }. */
export function parseSymbolKey(key) {
  if (!key) return { symbol: "", marketType: "spot" };
  const idx = key.indexOf(":");
  if (idx === -1) return { symbol: key, marketType: "spot" };
  return { symbol: key.slice(idx + 1), marketType: key.slice(0, idx) };
}

/** Extract just the display name (symbol) from a composite key. */
export function displayName(key) {
  return parseSymbolKey(key).symbol;
}
