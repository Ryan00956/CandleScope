export const QUOTE_CHIPS = ["USDT", "BTC", "ETH", "BNB", "FDUSD", "ALL"];

export const MARKET_TABS = [
  { key: "favorites", label: "★ 收藏", icon: "⭐" },
  { key: "spot", label: "现货", icon: "💱" },
  { key: "futures", label: "合约", icon: "📄" },
];

export const ROW_HEIGHT = 42;
export const VISIBLE_ROWS = 14;

export function formatExchangeLabel(exchangeKey, exchangeCatalog) {
  return exchangeCatalog?.[exchangeKey]?.label || exchangeKey.charAt(0).toUpperCase() + exchangeKey.slice(1);
}

export function buildExchangeChips({ allSymbols, currentExchange, exchangeCatalog }) {
  const exchanges = new Set([currentExchange || "binance"]);
  for (const item of allSymbols) {
    if (item.exchange) exchanges.add(item.exchange);
  }
  return Array.from(exchanges)
    .filter(Boolean)
    .sort()
    .map((key) => ({
      key,
      label: formatExchangeLabel(key, exchangeCatalog),
    }));
}

export function buildMarketTabs({ allSymbols, exchangeCatalog, exchangeFilter }) {
  const available = new Set(["favorites"]);
  for (const selectedExchange of exchangeFilter) {
    const markets = exchangeCatalog?.[selectedExchange]?.markets || [];
    for (const market of markets) {
      if (market.market_type) available.add(market.market_type);
    }
  }
  if (available.size === 1) {
    for (const item of allSymbols) {
      if (!exchangeFilter.size || exchangeFilter.has(item.exchange)) {
        available.add(item.marketType || "spot");
      }
    }
  }
  return MARKET_TABS.filter((tab) => available.has(tab.key));
}

export function filterSymbols({ allSymbols, marketType, exchangeFilter, quoteFilter, search, favorites }) {
  let list = allSymbols;

  if (marketType === "favorites") {
    const favoriteSet = new Set(favorites);
    list = list.filter((symbol) => favoriteSet.has(symbol._key));
  } else {
    list = list.filter((symbol) => symbol.marketType === marketType);
  }

  if (exchangeFilter.size > 0) {
    list = list.filter((symbol) => exchangeFilter.has(symbol.exchange));
  }

  if (quoteFilter && quoteFilter !== "ALL") {
    list = list.filter((symbol) => symbol.quoteAsset === quoteFilter);
  }

  if (search.trim()) {
    const query = search.trim().toUpperCase();
    list = list.filter((symbol) => (
      symbol.symbol.includes(query)
      || symbol.baseAsset.includes(query)
      || symbol.quoteAsset.includes(query)
    ));
  }

  return list;
}

export function isSameSymbolEntry(entry, currentSymbol, currentMarketType, currentExchange) {
  return (
    entry.symbol === currentSymbol
    && entry.marketType === (currentMarketType || "spot")
    && (entry.exchange || "binance") === (currentExchange || "binance")
  );
}

export function getSymbolWatchlists(watchlists, symbolKey) {
  if (!watchlists) return [];
  return watchlists.filter((watchlist) => watchlist.symbols.includes(symbolKey));
}