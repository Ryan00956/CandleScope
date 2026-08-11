import type { KlineBar, MarketSeries, SeriesKey } from "../marketDataTypes.js";
import { asSeriesKey } from "../marketDataTypes.js";
import { SeriesWindowStore } from "./seriesWindowStore.js";
import { canonicalizeIntervalValue } from "../../../utils/intervals.js";
import { WINDOW_DELTA_TYPES } from "../klineContracts.js";

const SHARED_SNAPSHOT_DELTA_TYPES: ReadonlySet<string> = new Set([
  WINDOW_DELTA_TYPES.REPLACE,
  WINDOW_DELTA_TYPES.APPEND,
  WINDOW_DELTA_TYPES.PREPEND,
  WINDOW_DELTA_TYPES.MID_MERGE,
]);

interface SeriesWindowRegistryOptions {
  maxBars?: number;
  sharedSnapshot?: {
    read(key: string): KlineBar[];
    publish(key: string, rows: readonly KlineBar[]): void;
  } | null;
}
interface StoreOptions {
  intervalSeconds?: number | null;
  meta?: Record<string, unknown>;
}

interface DetachedStoreOptions {
  intervalSeconds?: number | null;
  maxBars?: number;
}

export interface SeriesWindowActivation {
  rows: KlineBar[];
  store: SeriesWindowStore;
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
    String(symbol || "").trim().toUpperCase(),
    canonicalizeIntervalValue(interval) || String(interval || "").trim(),
  ].join("-"));
}

/**
 * Create an empty render owner without inserting it into a registry. This is
 * used to clear a cold transition frame while preserving every warm store.
 */
export function createDetachedSeriesWindowStore(
  key: SeriesKey | string,
  { intervalSeconds = null, maxBars }: DetachedStoreOptions = {},
): SeriesWindowStore {
  return new SeriesWindowStore({
    ...(maxBars === undefined ? {} : { maxBars }),
    intervalSeconds,
    seriesKey: key,
  });
}

export class SeriesWindowRegistry {
  maxBars: number | undefined;
  private readonly sharedSnapshot: SeriesWindowRegistryOptions["sharedSnapshot"];
  private readonly sharedCounts = { hydrations: 0, hydratedBars: 0, publishes: 0, publishErrors: 0 };
  private _stores: Map<string, SeriesWindowStore>;
  private _meta: Map<string, Record<string, unknown>>;

  constructor({ maxBars, sharedSnapshot = null }: SeriesWindowRegistryOptions = {}) {
    this.maxBars = maxBars;
    this.sharedSnapshot = sharedSnapshot;
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

  activate(key: string): SeriesWindowActivation | null {
    const store = this._stores.get(key);
    if (!store || store.isEmpty()) return null;
    return { rows: store.snapshot(), store };
  }

  getOrCreate(key: string, options: StoreOptions = {}): SeriesWindowStore {
    let store = this._stores.get(key);
    if (!store) {
      store = new SeriesWindowStore({
        ...(this.maxBars === undefined ? {} : { maxBars: this.maxBars }),
        seriesKey: key,
        intervalSeconds: options.intervalSeconds ?? null,
      });
      const sharedRows = this.sharedSnapshot?.read(key) || [];
      if (sharedRows.length > 0) {
        store.replace(sharedRows, { source: "desktop-shared-snapshot" });
        this.sharedCounts.hydrations += 1;
        this.sharedCounts.hydratedBars += sharedRows.length;
      }
      store.subscribe((delta, current) => {
        if (!this.sharedSnapshot
          || !delta.changed
          || !SHARED_SNAPSHOT_DELTA_TYPES.has(delta.type)) return;
        try {
          this.sharedSnapshot.publish(key, current.snapshot().slice(-256));
          this.sharedCounts.publishes += 1;
        } catch {
          this.sharedCounts.publishErrors += 1;
        }
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

  sharedSnapshotDiagnostics(): typeof this.sharedCounts {
    return { ...this.sharedCounts };
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
