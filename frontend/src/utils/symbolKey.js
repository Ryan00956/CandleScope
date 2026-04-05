/**
 * Shared helpers for composite symbol keys.
 *
 * A composite key uniquely identifies a symbol across markets:
 *   "spot:BTCUSDT"  /  "futures:ETHUSDT" / "okx:spot:BTC-USDT"
 *
 * This avoids collisions when spot and futures share the same
 * symbol string (e.g. both have "BTCUSDT").
 */

export function inferExchangeFromSymbol(symbol, fallback = "binance") {
  const normalized = String(symbol || "").toUpperCase().trim();
  if (!normalized) return fallback;
  if (normalized.includes("-")) return "okx";
  return fallback;
}

/** Build a composite key, keeping Binance keys backward-compatible. */
export function symbolKey(symbol, marketType = "spot", exchange = "binance") {
  const normalizedSymbol = String(symbol || "").toUpperCase().trim();
  const normalizedMarketType = String(marketType || "spot").toLowerCase().trim();
  const normalizedExchange = String(
    exchange || inferExchangeFromSymbol(normalizedSymbol, "binance"),
  ).toLowerCase().trim();
  if (normalizedExchange === "binance") {
    return `${normalizedMarketType}:${normalizedSymbol}`;
  }
  return `${normalizedExchange}:${normalizedMarketType}:${normalizedSymbol}`;
}

/** Parse a composite key back into { symbol, marketType, exchange }. */
export function parseSymbolKey(key) {
  if (!key) return { symbol: "", marketType: "spot", exchange: "binance" };
  const parts = String(key)
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    return {
      exchange: parts[0].toLowerCase(),
      marketType: parts[1].toLowerCase(),
      symbol: parts.slice(2).join(":").toUpperCase(),
    };
  }
  if (parts.length === 2) {
    const symbol = parts[1].toUpperCase();
    return {
      exchange: inferExchangeFromSymbol(symbol, "binance"),
      marketType: parts[0].toLowerCase(),
      symbol,
    };
  }
  const symbol = String(key).toUpperCase().trim();
  return {
    exchange: inferExchangeFromSymbol(symbol, "binance"),
    marketType: "spot",
    symbol,
  };
}

/** Extract just the display name (symbol) from a composite key. */
export function displayName(key) {
  return parseSymbolKey(key).symbol;
}
