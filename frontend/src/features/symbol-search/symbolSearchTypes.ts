import type { WatchlistGroup } from "../watchlist/watchlistTypes.js";

export interface SymbolSearchItem extends Record<string, unknown> {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: string;
  marketType: string;
  _key: string;
}

export interface ExchangeMarketDescriptor {
  market_type?: string;
}

export interface ExchangeCatalogEntry {
  label?: string;
  markets?: ExchangeMarketDescriptor[];
}

export type ExchangeCatalog = Record<string, ExchangeCatalogEntry>;

export interface SymbolFilterOptions {
  allSymbols: SymbolSearchItem[];
  marketType: string;
  exchangeFilter: Set<string>;
  quoteFilter: string;
  search: string;
  favorites: string[];
}

export interface SymbolWatchlistLookup {
  watchlists?: WatchlistGroup[] | null;
  symbolKey: string;
}
