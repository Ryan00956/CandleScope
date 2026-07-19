import { useCallback, useMemo, useState } from "react";
import type {
  TradeFlowDockView,
  TradeFlowIndicatorId,
  TradeFlowIndicatorKey,
  TradeFlowPreferenceActions,
  TradeFlowPreferences,
  TradeFlowSideFilter,
} from "./tradeFlowTypes.js";
import { tradeFlowIndicatorKey } from "./tradeFlowTypes.js";

const STORAGE_KEY = "candlescope-trade-flow-preferences-v1";

export const TRADE_FLOW_NOTIONAL_OPTIONS = [
  0, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
] as const;
export const TRADE_FLOW_BUBBLE_OPTIONS = [
  0, 50_000, 100_000, 250_000, 500_000, 1_000_000,
] as const;

export const DEFAULT_TRADE_FLOW_PREFERENCES: TradeFlowPreferences = Object.freeze({
  dockView: "order-book",
  indicators: Object.freeze({
    cvd: Object.freeze({ added: false, visible: false }),
    delta: Object.freeze({ added: false, visible: false }),
  }),
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

function indicatorPreference(
  value: unknown,
  legacyEnabled: boolean,
): TradeFlowPreferences["indicators"][TradeFlowIndicatorKey] {
  if (!value || typeof value !== "object") {
    return { added: legacyEnabled, visible: legacyEnabled };
  }
  const raw = value as Record<string, unknown>;
  const added = raw.added === true;
  return { added, visible: added && raw.visible !== false };
}

export function loadTradeFlowPreferences(
  target: StorageLike | null = storage(),
): TradeFlowPreferences {
  if (!target) return { ...DEFAULT_TRADE_FLOW_PREFERENCES };
  try {
    const raw = JSON.parse(target.getItem(STORAGE_KEY) || "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { ...DEFAULT_TRADE_FLOW_PREFERENCES };
    const rawIndicators = raw.indicators && typeof raw.indicators === "object"
      ? raw.indicators as Record<string, unknown>
      : null;
    const legacyEnabled = rawIndicators === null && raw.enabled === true;
    const dockView = allowed<TradeFlowDockView>(
      raw.dockView,
      ["order-book", "tape", "profile"],
      DEFAULT_TRADE_FLOW_PREFERENCES.dockView,
    );
    return {
      // Legacy v1 stored one global `enabled` bit. Preserve its two chart
      // panes during migration, while the right rail now follows dockView.
      dockView: rawIndicators === null && !legacyEnabled ? "order-book" : dockView,
      indicators: {
        cvd: indicatorPreference(rawIndicators?.cvd, legacyEnabled),
        delta: indicatorPreference(rawIndicators?.delta, legacyEnabled),
      },
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

  const setDockView = useCallback((dockView: TradeFlowDockView) => update((current) => ({
    ...current,
    dockView,
  })), [update]);
  const updateIndicator = useCallback((
    id: TradeFlowIndicatorId,
    updater: (
      current: TradeFlowPreferences["indicators"][TradeFlowIndicatorKey],
    ) => TradeFlowPreferences["indicators"][TradeFlowIndicatorKey],
  ) => update((current) => {
    const key = tradeFlowIndicatorKey(id);
    return {
      ...current,
      indicators: {
        ...current.indicators,
        [key]: updater(current.indicators[key]),
      },
    };
  }), [update]);
  const addIndicator = useCallback((id: TradeFlowIndicatorId) => updateIndicator(
    id,
    () => ({ added: true, visible: true }),
  ), [updateIndicator]);
  const removeIndicator = useCallback((id: TradeFlowIndicatorId) => updateIndicator(
    id,
    () => ({ added: false, visible: false }),
  ), [updateIndicator]);
  const toggleIndicatorVisibility = useCallback((id: TradeFlowIndicatorId) => updateIndicator(
    id,
    (current) => current.added
      ? { ...current, visible: !current.visible }
      : current,
  ), [updateIndicator]);
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
    setDockView,
    addIndicator,
    removeIndicator,
    toggleIndicatorVisibility,
    setSideFilter,
    setMinNotional,
    setLargeTradeNotional,
  }), [
    addIndicator,
    removeIndicator,
    setDockView,
    setLargeTradeNotional,
    setMinNotional,
    setSideFilter,
    toggleIndicatorVisibility,
  ]);

  return { preferences, actions };
}
