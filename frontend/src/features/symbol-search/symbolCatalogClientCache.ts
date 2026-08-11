import type { SymbolSearchItem } from "./symbolSearchTypes.js";

export interface SymbolCatalogRequest {
  exchange: string;
  marketType: string;
}

type SymbolCatalogCacheValue = SymbolSearchItem[] | null;

export function symbolCatalogRequestKey({
  exchange,
  marketType,
}: SymbolCatalogRequest): string {
  return `${exchange.trim().toLowerCase()}:${marketType.trim().toLowerCase()}`;
}

export class SymbolCatalogClientCache {
  private readonly entries = new Map<string, SymbolCatalogCacheValue>();

  constructor(private readonly maximumEntries = 12) {}

  shouldBlock(requests: readonly SymbolCatalogRequest[]): boolean {
    return requests.some((request) => !this.entries.has(symbolCatalogRequestKey(request)));
  }

  read(requests: readonly SymbolCatalogRequest[]): SymbolSearchItem[] {
    return requests.flatMap((request) => (
      this.entries.get(symbolCatalogRequestKey(request)) || []
    ));
  }

  readAll(): SymbolSearchItem[] {
    return Array.from(this.entries.values()).flatMap((symbols) => symbols || []);
  }

  remember(request: SymbolCatalogRequest, symbols: readonly SymbolSearchItem[]): void {
    this.set(request, [...symbols]);
  }

  rememberAttempt(request: SymbolCatalogRequest): void {
    const key = symbolCatalogRequestKey(request);
    this.set(request, this.entries.get(key) || null);
  }

  reset(): void {
    this.entries.clear();
  }

  private set(request: SymbolCatalogRequest, value: SymbolCatalogCacheValue): void {
    const key = symbolCatalogRequestKey(request);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export const sharedSymbolCatalogClientCache = new SymbolCatalogClientCache();
