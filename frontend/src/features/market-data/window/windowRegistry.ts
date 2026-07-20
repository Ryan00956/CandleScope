import type { MarketSeries, SeriesKey } from "../marketDataTypes.js";
import { asSeriesKey } from "../marketDataTypes.js";
import { SeriesWindowStore } from "./seriesWindowStore.js";

interface SeriesWindowRegistryOptions {
  maxBars?: number;
}
interface StoreOptions {
  intervalSeconds?: number | null;
  meta?: Record<string, unknown>;
}

export function buildSeriesWindowKey({
  exchange = "binance",
  marketType = "spot",
  symbol = "",
  interval = "",
}: Partial<MarketSeries> = {}): SeriesKey {
  return asSeriesKey([
    String(exchange || "binance").trim().toLowerCase(),
    String(marketType || "spot").trim().toLowerCase(),
    String(symbol || "").trim(),
    String(interval || "").trim(),
  ].join("-"));
}

export class SeriesWindowRegistry {
  maxBars: number | undefined;
  private _stores: Map<string, SeriesWindowStore>;
  private _meta: Map<string, Record<string, unknown>>;

  constructor({ maxBars }: SeriesWindowRegistryOptions = {}) {
    this.maxBars = maxBars;
    this._stores = new Map();
    this._meta = new Map();
  }

  get(key: string): SeriesWindowStore | null {
    return this._stores.get(key) || null;
  }

  has(key: string): boolean {
    const store = this._stores.get(key);
    return Boolean(store && !store.isEmpty());
  }

  getOrCreate(key: string, options: StoreOptions = {}): SeriesWindowStore {
    let store = this._stores.get(key);
    if (!store) {
      store = new SeriesWindowStore({
        ...(this.maxBars === undefined ? {} : { maxBars: this.maxBars }),
        seriesKey: key,
        intervalSeconds: options.intervalSeconds ?? null,
      });
      this._stores.set(key, store);
    }
    if (options.meta) {
      this.touchMeta(key, options.meta);
    }
    return store;
  }

  touchMeta(key: string, patch: Record<string, unknown> = {}): void {
    const current = this._meta.get(key) || {};
    const currentMetaRevision = Number(current.metaRevision);
    this._meta.set(key, {
      ...current,
      ...patch,
      lastAccessMs: Date.now(),
      metaRevision:
        (Number.isSafeInteger(currentMetaRevision) && currentMetaRevision >= 0
          ? currentMetaRevision
          : 0) + 1,
    });
  }

  meta(key: string): Record<string, unknown> {
    return this._meta.get(key) || {};
  }

  entries(): Array<{
    key: string;
    store: SeriesWindowStore;
    meta: Record<string, unknown>;
  }> {
    return Array.from(this._stores.entries()).map(([key, store]) => ({
      key,
      store,
      meta: this.meta(key),
    }));
  }

  evict(key: string): ({ key: string } & ReturnType<SeriesWindowStore["describe"]>) | null {
    const store = this._stores.get(key);
    if (!store) return null;
    const description = store.describe();
    this._stores.delete(key);
    this._meta.delete(key);
    return { key, ...description };
  }

  clear(): string[] {
    const keys = Array.from(this._stores.keys());
    this._stores.clear();
    this._meta.clear();
    return keys;
  }
}
