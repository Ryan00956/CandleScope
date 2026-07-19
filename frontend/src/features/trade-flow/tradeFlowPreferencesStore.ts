import { useCallback, useMemo, useState } from "react";
import type {
  TradeFlowDockView,
  TradeFlowPreferenceActions,
  TradeFlowPreferences,
  TradeFlowSideFilter,
} from "./tradeFlowTypes.js";

const STORAGE_KEY = "candlescope-trade-flow-preferences-v1";

export const TRADE_FLOW_NOTIONAL_OPTIONS = [
  0, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
] as const;
export const TRADE_FLOW_BUBBLE_OPTIONS = [
  50_000, 100_000, 250_000, 500_000, 1_000_000,
] as const;

export const DEFAULT_TRADE_FLOW_PREFERENCES: TradeFlowPreferences = Object.freeze({
  enabled: false,
  dockView: "order-book",
  sideFilter: "all",
  minNotional: 0,
  largeTradeNotional: 100_000,
});

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function allowed<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback;
}

function notional(
  value: unknown,
  choices: readonly number[],
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && choices.includes(parsed) ? parsed : fallback;
}

export function loadTradeFlowPreferences(
  target: StorageLike | null = storage(),
): TradeFlowPreferences {
  if (!target) return { ...DEFAULT_TRADE_FLOW_PREFERENCES };
  try {
    const raw = JSON.parse(target.getItem(STORAGE_KEY) || "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { ...DEFAULT_TRADE_FLOW_PREFERENCES };
    return {
      enabled: raw.enabled === true,
      dockView: allowed<TradeFlowDockView>(
        raw.dockView,
        ["order-book", "tape", "profile"],
        DEFAULT_TRADE_FLOW_PREFERENCES.dockView,
      ),
      sideFilter: allowed<TradeFlowSideFilter>(
        raw.sideFilter,
        ["all", "buy", "sell"],
        DEFAULT_TRADE_FLOW_PREFERENCES.sideFilter,
      ),
      minNotional: notional(
        raw.minNotional,
        TRADE_FLOW_NOTIONAL_OPTIONS,
        DEFAULT_TRADE_FLOW_PREFERENCES.minNotional,
      ),
      largeTradeNotional: notional(
        raw.largeTradeNotional,
        TRADE_FLOW_BUBBLE_OPTIONS,
        DEFAULT_TRADE_FLOW_PREFERENCES.largeTradeNotional,
      ),
    };
  } catch {
    return { ...DEFAULT_TRADE_FLOW_PREFERENCES };
  }
}

export function useTradeFlowPreferences(): {
  preferences: TradeFlowPreferences;
  actions: TradeFlowPreferenceActions;
} {
  const [target] = useState(storage);
  const [preferences, setPreferences] = useState(() => loadTradeFlowPreferences(target));

  const update = useCallback((updater: (current: TradeFlowPreferences) => TradeFlowPreferences) => {
    setPreferences((current) => {
      const next = updater(current);
      try { target?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* memory state remains valid */ }
      return next;
    });
  }, [target]);

  const setEnabled = useCallback((enabled: boolean) => update((current) => ({
    ...current,
    enabled,
    dockView: enabled ? (current.dockView === "order-book" ? "tape" : current.dockView) : "order-book",
  })), [update]);
  const toggleEnabled = useCallback(() => update((current) => ({
    ...current,
    enabled: !current.enabled,
    dockView: current.enabled ? "order-book" : "tape",
  })), [update]);
  const setDockView = useCallback((dockView: TradeFlowDockView) => update((current) => ({
    ...current,
    dockView,
    enabled: dockView === "order-book" ? current.enabled : true,
  })), [update]);
  const setSideFilter = useCallback((sideFilter: TradeFlowSideFilter) => update((current) => ({
    ...current,
    sideFilter,
  })), [update]);
  const setMinNotional = useCallback((value: number) => update((current) => ({
    ...current,
    minNotional: notional(value, TRADE_FLOW_NOTIONAL_OPTIONS, current.minNotional),
  })), [update]);
  const setLargeTradeNotional = useCallback((value: number) => update((current) => ({
    ...current,
    largeTradeNotional: notional(value, TRADE_FLOW_BUBBLE_OPTIONS, current.largeTradeNotional),
  })), [update]);

  const actions = useMemo<TradeFlowPreferenceActions>(() => ({
    setEnabled,
    toggleEnabled,
    setDockView,
    setSideFilter,
    setMinNotional,
    setLargeTradeNotional,
  }), [
    setDockView,
    setEnabled,
    setLargeTradeNotional,
    setMinNotional,
    setSideFilter,
    toggleEnabled,
  ]);

  return { preferences, actions };
}
