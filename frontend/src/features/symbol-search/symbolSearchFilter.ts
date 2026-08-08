import type { WatchlistGroup } from "../watchlist/watchlistTypes.js";
import type {
  ExchangeCatalog,
  SymbolFilterOptions,
  SymbolSearchItem,
} from "./symbolSearchTypes.js";

export const QUOTE_CHIPS = ["USDT", "BTC", "ETH", "BNB", "FDUSD", "ALL"] as const;

export interface MarketTab {
  key: string;
  label: string;
  icon: string;
}

export const MARKET_TABS: MarketTab[] = [
  { key: "favorites", label: "★ 收藏", icon: "⭐" },
  { key: "spot", label: "现货", icon: "💱" },
  { key: "futures", label: "合约", icon: "📄" },
];

export const ROW_HEIGHT = 42;
export const VISIBLE_ROWS = 14;

export function formatExchangeLabel(
  exchangeKey: string,
  exchangeCatalog: ExchangeCatalog | null | undefined,
): string {
  return exchangeCatalog?.[exchangeKey]?.label || exchangeKey.charAt(0).toUpperCase() + exchangeKey.slice(1);
}

export function buildExchangeChips({
  allSymbols,
  currentExchange,
  exchangeCatalog,
}: {
  allSymbols: SymbolSearchItem[];
  currentExchange?: string | null;
  exchangeCatalog?: ExchangeCatalog | null;
}): Array<{ key: string; label: string; disabled: boolean }> {
  const exchanges = new Set<string>([currentExchange || "binance"]);
  for (const exchange of Object.keys(exchangeCatalog || {})) {
    exchanges.add(exchange);
  }
  for (const item of allSymbols) {
    if (item.exchange) exchanges.add(item.exchange);
  }
  return Array.from(exchanges)
    .filter(Boolean)
    .sort()
    .map((key) => ({
      key,
      label: formatExchangeLabel(key, exchangeCatalog),
      disabled: Array.isArray(exchangeCatalog?.[key]?.markets)
        && exchangeCatalog[key].markets?.length === 0,
    }));
}

export function buildMarketTabs({
  allSymbols,
  exchangeCatalog,
  exchangeFilter,
}: {
  allSymbols: SymbolSearchItem[];
  exchangeCatalog?: ExchangeCatalog | null;
  exchangeFilter: Set<string>;
}): MarketTab[] {
  const available = new Set<string>(["favorites"]);
  const labels = new Map<string, string>();
  for (const selectedExchange of exchangeFilter) {
    const markets = exchangeCatalog?.[selectedExchange]?.markets || [];
    for (const market of markets) {
      if (market.market_type) {
        available.add(market.market_type);
        if (market.label) labels.set(market.market_type, market.label);
      }
    }
  }
  if (available.size === 1) {
    for (const item of allSymbols) {
      if (!exchangeFilter.size || exchangeFilter.has(item.exchange)) {
        available.add(item.marketType || "spot");
      }
    }
  }
  const known = new Map(MARKET_TABS.map((tab) => [tab.key, tab]));
  const order = ["favorites", "spot", "futures"];
  const marketTypes = [...available].sort((left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex < 0 ? order.length : leftIndex)
        - (rightIndex < 0 ? order.length : rightIndex);
    }
    return left.localeCompare(right);
  });
  return marketTypes.map((key) => known.get(key) || {
    key,
    label: labels.get(key) || key,
    icon: key.startsWith("spot") ? "💱" : key.startsWith("option") ? "◈" : "📄",
  });
}

function marketTypeFamily(marketType: string): string {
  const normalized = marketType.trim().toLowerCase();
  if (normalized === "spot" || normalized.startsWith("spot.")) return "spot";
  if (normalized === "option" || normalized.startsWith("option.")) return "option";
  if (
    normalized === "futures"
    || normalized === "future"
    || normalized === "swap"
    || normalized === "perpetual"
    || normalized.startsWith("future.")
    || normalized.startsWith("swap.")
    || normalized.startsWith("perpetual.")
  ) return "derivatives";
  return normalized;
}

function derivativePreference(marketType: string): number {
  const normalized = marketType.trim().toLowerCase();
  return [
    "futures",
    "swap.linear",
    "swap",
    "perpetual.linear",
    "perpetual",
    "future.linear",
    "future",
    "swap.inverse",
    "future.inverse",
  ].indexOf(normalized);
}

export function resolveExchangeMarketType(
  currentMarketType: string,
  marketTabs: readonly MarketTab[],
): string {
  const available = marketTabs.filter((tab) => tab.key !== "favorites");
  const normalizedCurrent = currentMarketType.trim().toLowerCase();
  const exact = available.find((tab) => tab.key.trim().toLowerCase() === normalizedCurrent);
  if (exact) return exact.key;

  const currentFamily = marketTypeFamily(normalizedCurrent);
  const sameFamily = available.filter((tab) => marketTypeFamily(tab.key) === currentFamily);
  if (sameFamily.length > 0) {
    if (currentFamily === "derivatives") {
      return [...sameFamily].sort((left, right) => {
        const leftPreference = derivativePreference(left.key);
        const rightPreference = derivativePreference(right.key);
        return (leftPreference < 0 ? Number.MAX_SAFE_INTEGER : leftPreference)
          - (rightPreference < 0 ? Number.MAX_SAFE_INTEGER : rightPreference);
      })[0]?.key || sameFamily[0]!.key;
    }
    return sameFamily[0]!.key;
  }
  return available[0]?.key || "favorites";
}

export function filterSymbols({
  allSymbols,
  marketType,
  exchangeFilter,
  quoteFilter,
  search,
  favorites,
}: SymbolFilterOptions): SymbolSearchItem[] {
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

export function isSameSymbolEntry(
  entry: SymbolSearchItem,
  currentSymbol: string,
  currentMarketType?: string | null,
  currentExchange?: string | null,
): boolean {
  return (
    entry.symbol === currentSymbol
    && entry.marketType === (currentMarketType || "spot")
    && (entry.exchange || "binance") === (currentExchange || "binance")
  );
}

export function getSymbolWatchlists(
  watchlists: WatchlistGroup[] | null | undefined,
  symbolKey: string,
): WatchlistGroup[] {
  if (!watchlists) return [];
  return watchlists.filter((watchlist) => watchlist.symbols.includes(symbolKey));
}
