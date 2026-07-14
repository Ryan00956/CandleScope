/** Shared helpers for composite symbol keys. */

export type ExchangeId = string;
export type MarketType = string;
export type SymbolCode = string;
export type CompositeSymbolKey = string;

export interface SymbolIdentity {
  exchange: ExchangeId;
  marketType: MarketType;
  symbol: SymbolCode;
}

export function inferExchangeFromSymbol(
  symbol: unknown,
  fallback: ExchangeId = "binance",
): ExchangeId {
  const normalized = String(symbol || "").toUpperCase().trim();
  if (!normalized) return fallback;
  if (normalized.includes("-")) return "okx";
  return fallback;
}

/** Build a composite key, keeping Binance keys backward-compatible. */
export function symbolKey(
  symbol: unknown,
  marketType: unknown = "spot",
  exchange: unknown = "binance",
): CompositeSymbolKey {
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
export function parseSymbolKey(key: unknown): SymbolIdentity {
  if (!key) return { symbol: "", marketType: "spot", exchange: "binance" };
  const parts = String(key)
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const [firstPart, secondPart] = parts;
  if (parts.length >= 3 && firstPart && secondPart) {
    return {
      exchange: firstPart.toLowerCase(),
      marketType: secondPart.toLowerCase(),
      symbol: parts.slice(2).join(":").toUpperCase(),
    };
  }
  if (parts.length === 2 && firstPart && secondPart) {
    const symbol = secondPart.toUpperCase();
    return {
      exchange: inferExchangeFromSymbol(symbol, "binance"),
      marketType: firstPart.toLowerCase(),
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
export function displayName(key: unknown): SymbolCode {
  return parseSymbolKey(key).symbol;
}
