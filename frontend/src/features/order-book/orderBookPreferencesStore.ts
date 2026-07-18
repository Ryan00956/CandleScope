import { useCallback, useMemo, useState } from "react";
import type {
  FullOutputLimit,
  OrderBookMode,
  OrderBookPreferenceActions,
  OrderBookPreferences,
  OrderBookUpdateIntervalMs,
  PartialDepthLevel,
  PriceGrouping,
} from "./orderBookTypes.js";
import {
  FULL_OUTPUT_LIMITS,
  FULL_PRICE_GROUPINGS,
  PARTIAL_DEPTH_LEVELS,
  PARTIAL_PRICE_GROUPINGS,
  UPDATE_INTERVALS_MS,
} from "./orderBookTypes.js";

export const DEFAULT_ORDER_BOOK_HEIGHT = 360;
export const MIN_ORDER_BOOK_HEIGHT = 220;
export const MAX_ORDER_BOOK_HEIGHT = 640;
export const MIN_WATCHLIST_PANE_HEIGHT = 180;
export const COLLAPSED_ORDER_BOOK_HEIGHT = 36;

const STORAGE_PREFIX = "candlescope-order-book";
const STORAGE_KEYS = {
  height: `${STORAGE_PREFIX}-height`,
  collapsed: `${STORAGE_PREFIX}-collapsed`,
  mode: `${STORAGE_PREFIX}-mode`,
  partialDepth: `${STORAGE_PREFIX}-partial-depth`,
  updateIntervalMs: `${STORAGE_PREFIX}-interval-ms`,
  fullOutputLimit: `${STORAGE_PREFIX}-full-output-limit`,
  partialPriceGrouping: `${STORAGE_PREFIX}-partial-price-grouping`,
  fullPriceGrouping: `${STORAGE_PREFIX}-full-price-grouping`,
} as const;

export const DEFAULT_ORDER_BOOK_PREFERENCES: OrderBookPreferences = Object.freeze({
  height: DEFAULT_ORDER_BOOK_HEIGHT,
  collapsed: false,
  mode: "partial",
  partialDepth: 20,
  updateIntervalMs: 250,
  fullOutputLimit: 100,
  partialPriceGrouping: "auto",
  fullPriceGrouping: "auto",
});

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function oneOf<T extends string | number>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return choices.includes(value as T) ? value as T : fallback;
}

function readNumber(storage: StorageLike, key: string): number | null {
  const raw = storage.getItem(key);
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadOrderBookPreferences(storage?: StorageLike | null): OrderBookPreferences {
  if (!storage) return { ...DEFAULT_ORDER_BOOK_PREFERENCES };
  try {
    const rawHeight = readNumber(storage, STORAGE_KEYS.height);
    const rawPartialDepth = readNumber(storage, STORAGE_KEYS.partialDepth);
    const rawInterval = readNumber(storage, STORAGE_KEYS.updateIntervalMs);
    const rawOutputLimit = readNumber(storage, STORAGE_KEYS.fullOutputLimit);
    const rawMode = storage.getItem(STORAGE_KEYS.mode);
    const rawCollapsed = storage.getItem(STORAGE_KEYS.collapsed);
    const rawPartialPriceGrouping = storage.getItem(STORAGE_KEYS.partialPriceGrouping);
    const rawFullPriceGrouping = storage.getItem(STORAGE_KEYS.fullPriceGrouping);
    return {
      height: rawHeight === null
        ? DEFAULT_ORDER_BOOK_HEIGHT
        : clamp(Math.round(rawHeight), MIN_ORDER_BOOK_HEIGHT, MAX_ORDER_BOOK_HEIGHT),
      collapsed: rawCollapsed === "true",
      mode: oneOf<OrderBookMode>(rawMode, ["partial", "full"], "partial"),
      partialDepth: oneOf<PartialDepthLevel>(
        rawPartialDepth,
        PARTIAL_DEPTH_LEVELS,
        DEFAULT_ORDER_BOOK_PREFERENCES.partialDepth,
      ),
      updateIntervalMs: oneOf<OrderBookUpdateIntervalMs>(
        rawInterval,
        UPDATE_INTERVALS_MS,
        DEFAULT_ORDER_BOOK_PREFERENCES.updateIntervalMs,
      ),
      fullOutputLimit: oneOf<FullOutputLimit>(
        rawOutputLimit,
        FULL_OUTPUT_LIMITS,
        DEFAULT_ORDER_BOOK_PREFERENCES.fullOutputLimit,
      ),
      partialPriceGrouping: oneOf<PriceGrouping>(
        rawPartialPriceGrouping,
        PARTIAL_PRICE_GROUPINGS,
        DEFAULT_ORDER_BOOK_PREFERENCES.partialPriceGrouping,
      ),
      fullPriceGrouping: oneOf<PriceGrouping>(
        rawFullPriceGrouping,
        FULL_PRICE_GROUPINGS,
        DEFAULT_ORDER_BOOK_PREFERENCES.fullPriceGrouping,
      ),
    };
  } catch {
    return { ...DEFAULT_ORDER_BOOK_PREFERENCES };
  }
}

function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function persist(storage: StorageLike | null, key: string, value: string | number | boolean): void {
  if (!storage) return;
  try {
    storage.setItem(key, String(value));
  } catch {
    // Preferences remain valid in memory when storage is unavailable or full.
  }
}

export function useOrderBookPreferences(): {
  preferences: OrderBookPreferences;
  actions: OrderBookPreferenceActions;
} {
  const [storage] = useState<StorageLike | null>(getBrowserStorage);
  const [preferences, setPreferences] = useState<OrderBookPreferences>(() => (
    loadOrderBookPreferences(storage)
  ));

  const setHeight = useCallback((height: number) => {
    const next = clamp(Math.round(height), MIN_ORDER_BOOK_HEIGHT, MAX_ORDER_BOOK_HEIGHT);
    setPreferences((current) => ({ ...current, height: next }));
    persist(storage, STORAGE_KEYS.height, next);
  }, [storage]);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setPreferences((current) => ({ ...current, collapsed }));
    persist(storage, STORAGE_KEYS.collapsed, collapsed);
  }, [storage]);

  const setMode = useCallback((mode: OrderBookMode) => {
    setPreferences((current) => ({ ...current, mode }));
    persist(storage, STORAGE_KEYS.mode, mode);
  }, [storage]);

  const setPartialDepth = useCallback((partialDepth: PartialDepthLevel) => {
    setPreferences((current) => ({ ...current, partialDepth }));
    persist(storage, STORAGE_KEYS.partialDepth, partialDepth);
  }, [storage]);

  const setUpdateIntervalMs = useCallback((updateIntervalMs: OrderBookUpdateIntervalMs) => {
    setPreferences((current) => ({ ...current, updateIntervalMs }));
    persist(storage, STORAGE_KEYS.updateIntervalMs, updateIntervalMs);
  }, [storage]);

  const setFullOutputLimit = useCallback((fullOutputLimit: FullOutputLimit) => {
    setPreferences((current) => ({ ...current, fullOutputLimit }));
    persist(storage, STORAGE_KEYS.fullOutputLimit, fullOutputLimit);
  }, [storage]);

  const setPriceGrouping = useCallback((mode: OrderBookMode, grouping: PriceGrouping) => {
    const key = mode === "partial"
      ? STORAGE_KEYS.partialPriceGrouping
      : STORAGE_KEYS.fullPriceGrouping;
    setPreferences((current) => ({
      ...current,
      [mode === "partial" ? "partialPriceGrouping" : "fullPriceGrouping"]: grouping,
    }));
    persist(storage, key, grouping);
  }, [storage]);

  const actions = useMemo<OrderBookPreferenceActions>(() => ({
    setHeight,
    setCollapsed,
    setMode,
    setPartialDepth,
    setUpdateIntervalMs,
    setFullOutputLimit,
    setPriceGrouping,
  }), [
    setCollapsed,
    setFullOutputLimit,
    setHeight,
    setMode,
    setPartialDepth,
    setPriceGrouping,
    setUpdateIntervalMs,
  ]);

  return { preferences, actions };
}
