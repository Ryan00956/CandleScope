import { useSyncExternalStore } from "react";

import {
  MARKET_METRIC_DEFINITIONS,
  createDefaultMarketMetricSelection,
  isMarketMetricId,
  type MarketMetricId,
  type MarketMetricSelectionItem,
  type MarketMetricSelectionSnapshot,
} from "./marketMetricSelectionTypes.js";

export const MARKET_METRIC_SELECTION_STORAGE_KEY =
  "candlescope-market-metric-selection-v1";

const MARKET_METRIC_SELECTION_SCHEMA_VERSION = 1;

export interface MarketMetricSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MarketMetricSelectionStoreOptions {
  storage?: MarketMetricSelectionStorage | null;
  storageKey?: string;
}

export interface MarketMetricSelectionController {
  readonly selections: MarketMetricSelectionSnapshot;
  add(id: MarketMetricId): void;
  remove(id: MarketMetricId): void;
  toggleVisibility(id: MarketMetricId): void;
}

type MarketMetricSelectionListener = () => void;

interface PersistedSelectionItem {
  id: MarketMetricId;
  added: boolean;
  visible: boolean;
}

interface PersistedSelectionPayload {
  version: typeof MARKET_METRIC_SELECTION_SCHEMA_VERSION;
  items: PersistedSelectionItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function freezeSelection(
  items: readonly MarketMetricSelectionItem[],
): MarketMetricSelectionSnapshot {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function resolveBrowserStorage(): MarketMetricSelectionStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function parseMarketMetricSelection(
  raw: string | null,
): MarketMetricSelectionSnapshot {
  const defaults = createDefaultMarketMetricSelection();
  if (!raw) return defaults;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)
      || parsed.version !== MARKET_METRIC_SELECTION_SCHEMA_VERSION
      || !Array.isArray(parsed.items)) {
      return defaults;
    }

    const persisted = new Map<MarketMetricId, PersistedSelectionItem>();
    for (const value of parsed.items) {
      if (!isRecord(value)
        || !isMarketMetricId(value.id)
        || typeof value.added !== "boolean"
        || typeof value.visible !== "boolean") {
        continue;
      }
      persisted.set(value.id, {
        id: value.id,
        added: value.added,
        visible: value.added && value.visible,
      });
    }

    return freezeSelection(MARKET_METRIC_DEFINITIONS.map((definition) => {
      const restored = persisted.get(definition.id);
      return {
        ...definition,
        added: restored?.added ?? false,
        visible: restored?.visible ?? false,
      };
    }));
  } catch {
    return defaults;
  }
}

function serializeMarketMetricSelection(
  snapshot: MarketMetricSelectionSnapshot,
): string {
  const payload: PersistedSelectionPayload = {
    version: MARKET_METRIC_SELECTION_SCHEMA_VERSION,
    items: snapshot.map(({ id, added, visible }) => ({ id, added, visible })),
  };
  return JSON.stringify(payload);
}

export class MarketMetricSelectionStore {
  private readonly listeners = new Set<MarketMetricSelectionListener>();
  private readonly storage: MarketMetricSelectionStorage | null;
  private readonly storageKey: string;
  private snapshot: MarketMetricSelectionSnapshot;

  constructor(options: MarketMetricSelectionStoreOptions = {}) {
    this.storage = options.storage === undefined
      ? resolveBrowserStorage()
      : options.storage;
    this.storageKey = options.storageKey ?? MARKET_METRIC_SELECTION_STORAGE_KEY;
    this.snapshot = parseMarketMetricSelection(this.readPersisted());
  }

  readonly subscribe = (listener: MarketMetricSelectionListener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): MarketMetricSelectionSnapshot => this.snapshot;

  readonly getServerSnapshot = (): MarketMetricSelectionSnapshot => this.snapshot;

  get(id: MarketMetricId): MarketMetricSelectionItem | undefined {
    return this.snapshot.find((item) => item.id === id);
  }

  readonly add = (id: MarketMetricId): void => {
    this.update(id, (item) => {
      if (item.added) return item;
      return { ...item, added: true, visible: true };
    });
  };

  readonly remove = (id: MarketMetricId): void => {
    this.update(id, (item) => {
      if (!item.added && !item.visible) return item;
      return { ...item, added: false, visible: false };
    });
  };

  readonly toggleVisibility = (id: MarketMetricId): void => {
    this.update(id, (item) => (
      item.added ? { ...item, visible: !item.visible } : item
    ));
  };

  private update(
    id: MarketMetricId,
    transform: (item: MarketMetricSelectionItem) => MarketMetricSelectionItem,
  ): void {
    const index = this.snapshot.findIndex((item) => item.id === id);
    if (index < 0) return;
    const current = this.snapshot[index];
    if (!current) return;
    const nextItem = transform(current);
    if (nextItem === current) return;

    const next = [...this.snapshot];
    next[index] = nextItem;
    this.snapshot = freezeSelection(next);
    this.persist();
    for (const listener of this.listeners) listener();
  }

  private readPersisted(): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(
        this.storageKey,
        serializeMarketMetricSelection(this.snapshot),
      );
    } catch {
      // Persistence is best-effort. Keep the in-memory selection usable when
      // storage is unavailable, blocked, or over quota.
    }
  }
}

export const marketMetricSelectionStore = new MarketMetricSelectionStore();

export function useMarketMetricSelection(
  store: MarketMetricSelectionStore = marketMetricSelectionStore,
): MarketMetricSelectionController {
  const selections = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return {
    selections,
    add: store.add,
    remove: store.remove,
    toggleVisibility: store.toggleVisibility,
  };
}
