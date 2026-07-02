import { SeriesWindowStore } from "./seriesWindowStore.js";

export function buildSeriesWindowKey({
  exchange = "binance",
  marketType = "spot",
  symbol = "",
  interval = "",
} = {}) {
  return [
    String(exchange || "binance").trim().toLowerCase(),
    String(marketType || "spot").trim().toLowerCase(),
    String(symbol || "").trim(),
    String(interval || "").trim(),
  ].join("-");
}

export class SeriesWindowRegistry {
  constructor({ maxBars } = {}) {
    this.maxBars = maxBars;
    this._stores = new Map();
    this._meta = new Map();
  }

  get(key) {
    return this._stores.get(key) || null;
  }

  has(key) {
    return this._stores.has(key) && !this._stores.get(key).isEmpty();
  }

  getOrCreate(key, options = {}) {
    let store = this._stores.get(key);
    if (!store) {
      store = new SeriesWindowStore({
        maxBars: this.maxBars,
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

  touchMeta(key, patch = {}) {
    const current = this._meta.get(key) || {};
    this._meta.set(key, {
      ...current,
      ...patch,
      lastAccessMs: Date.now(),
    });
  }

  meta(key) {
    return this._meta.get(key) || {};
  }

  entries() {
    return Array.from(this._stores.entries()).map(([key, store]) => ({
      key,
      store,
      meta: this.meta(key),
    }));
  }

  evict(key) {
    const store = this._stores.get(key);
    if (!store) return null;
    const description = store.describe();
    this._stores.delete(key);
    this._meta.delete(key);
    return { key, ...description };
  }

  clear() {
    const keys = Array.from(this._stores.keys());
    this._stores.clear();
    this._meta.clear();
    return keys;
  }
}
