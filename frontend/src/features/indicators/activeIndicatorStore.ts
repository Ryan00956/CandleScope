import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { fetchPreset } from "../../services/indicatorApi.js";
import type { IndicatorDefinition, IndicatorParams } from "./indicatorTypes.js";

const ACTIVE_INDICATORS_KEY = "candlescope-active-indicators";
const VOL_INIT_KEY = "candlescope-vol-initialized";

export interface IndicatorStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ActiveIndicatorPersistence {
  controlled?: boolean;
  load(): IndicatorDefinition[];
  save(list: IndicatorDefinition[]): void;
}

function browserStorage(): IndicatorStorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isIndicatorDefinition(value: unknown): value is IndicatorDefinition {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).id === "string";
}

export function loadActiveIndicators(
  storageKey = ACTIVE_INDICATORS_KEY,
  storage: IndicatorStorageLike | null = browserStorage(),
): IndicatorDefinition[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isIndicatorDefinition) : [];
  } catch {
    return [];
  }
}

export function saveActiveIndicators(
  list: IndicatorDefinition[],
  storageKey = ACTIVE_INDICATORS_KEY,
  storage: IndicatorStorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(list));
  } catch {
    // Indicator preferences are best effort and must not break the chart.
  }
}

export function createActiveIndicatorPersistence(
  storageKey: string,
  storage: IndicatorStorageLike | null = browserStorage(),
): ActiveIndicatorPersistence {
  return {
    load: () => loadActiveIndicators(storageKey, storage),
    save: (list) => saveActiveIndicators(list, storageKey, storage),
  };
}

const LIVE_ACTIVE_INDICATOR_PERSISTENCE: ActiveIndicatorPersistence = {
  load: () => loadActiveIndicators(ACTIVE_INDICATORS_KEY, browserStorage()),
  save: (list) => saveActiveIndicators(
    list,
    ACTIVE_INDICATORS_KEY,
    browserStorage(),
  ),
};

export function stripIndicatorRuntimeFields(indicator: IndicatorDefinition): IndicatorDefinition {
  const rest = { ...indicator };
  delete rest.lines;
  delete rest.error;
  return rest;
}

function persistedIndicatorSignature(indicators: readonly IndicatorDefinition[]): string {
  return JSON.stringify(indicators.map(stripIndicatorRuntimeFields));
}

/**
 * Reconcile a durable owner (workspace v7, local storage, etc.) with the live
 * indicator store. Runtime-only fields are retained when the durable
 * definitions are semantically unchanged; a genuine external edit replaces
 * the live definitions so restored and peer-window state cannot drift.
 */
export function reconcilePersistedIndicatorDefinitions(
  current: IndicatorDefinition[],
  persisted: readonly IndicatorDefinition[],
  normalizeIndicator?: (
    indicator: IndicatorDefinition,
  ) => IndicatorDefinition | null,
): IndicatorDefinition[] {
  const prepared = persisted.flatMap((indicator) => {
    const normalized = normalizeIndicator ? normalizeIndicator(indicator) : indicator;
    return normalized === null ? [] : [normalized];
  });
  return persistedIndicatorSignature(current) === persistedIndicatorSignature(prepared)
    ? current
    : prepared;
}

export interface ActiveIndicatorUpdate {
  durableChanged: boolean;
  indicators: IndicatorDefinition[];
}

/**
 * Apply one live-store update without confusing computed lines/errors with a
 * durable workspace edit. Controlled chart cells still need to accept every
 * runtime update locally; only definition changes are sent back to the
 * workspace owner.
 */
export function applyActiveIndicatorUpdate(
  current: IndicatorDefinition[],
  action: SetStateAction<IndicatorDefinition[]>,
): ActiveIndicatorUpdate {
  const indicators = typeof action === "function" ? action(current) : action;
  return {
    durableChanged:
      persistedIndicatorSignature(indicators) !== persistedIndicatorSignature(current),
    indicators,
  };
}

export interface UseActiveIndicatorStoreOptions {
  autoAddVolume?: boolean;
  normalizeIndicator?: (
    indicator: IndicatorDefinition,
  ) => IndicatorDefinition | null;
  onRequireCompute?: () => void;
  persistence?: ActiveIndicatorPersistence | null;
}

export function applyIndicatorScriptUpdate(
  indicator: IndicatorDefinition,
  newScript: string,
  language?: string,
  securityMode?: string,
  normalizeIndicator?: (
    indicator: IndicatorDefinition,
  ) => IndicatorDefinition | null,
): IndicatorDefinition {
  const updated: IndicatorDefinition = {
    ...indicator,
    script: newScript,
    ...(language ? { language } : {}),
    ...(securityMode ? { securityMode } : {}),
  };
  return normalizeIndicator?.(updated) ?? (
    normalizeIndicator ? indicator : updated
  );
}

export interface ActiveIndicatorStore {
  activeIndicators: IndicatorDefinition[];
  setActiveIndicators: Dispatch<SetStateAction<IndicatorDefinition[]>>;
  addIndicator(indicator: IndicatorDefinition): void;
  removeIndicator(indicatorId: string): void;
  toggleVisibility(indicatorId: string): void;
  updateIndicatorParams(indicatorId: string, newParams: IndicatorParams): void;
  updateIndicatorScript(
    indicatorId: string,
    newScript: string,
    language?: string,
    securityMode?: string,
  ): void;
}

export function useActiveIndicatorStore({
  autoAddVolume = true,
  normalizeIndicator,
  onRequireCompute,
  persistence = LIVE_ACTIVE_INDICATOR_PERSISTENCE,
}: UseActiveIndicatorStoreOptions = {}): ActiveIndicatorStore {
  const prepareIndicator = useCallback((indicator: IndicatorDefinition) => (
    normalizeIndicator ? normalizeIndicator(indicator) : indicator
  ), [normalizeIndicator]);
  const [ownedIndicators, setOwnedIndicators] = useState<IndicatorDefinition[]>(() => (
    (persistence?.load() ?? []).flatMap((indicator) => {
      const prepared = normalizeIndicator ? normalizeIndicator(indicator) : indicator;
      return prepared === null ? [] : [prepared];
    })
  ));
  const ownedIndicatorsRef = useRef(ownedIndicators);
  const volInitRef = useRef(false);
  const controlled = persistence?.controlled === true;
  const controlledIndicators = useMemo(() => (
    controlled
      ? (persistence?.load() ?? []).flatMap((indicator) => {
          const prepared = normalizeIndicator ? normalizeIndicator(indicator) : indicator;
          return prepared === null ? [] : [prepared];
        })
      : []
  ), [controlled, normalizeIndicator, persistence]);
  const activeIndicators = ownedIndicators;
  const setActiveIndicators = useCallback<Dispatch<SetStateAction<IndicatorDefinition[]>>>(
    (action) => {
      const update = applyActiveIndicatorUpdate(ownedIndicatorsRef.current, action);
      if (update.indicators !== ownedIndicatorsRef.current) {
        ownedIndicatorsRef.current = update.indicators;
        setOwnedIndicators(update.indicators);
      }
      if (controlled && update.durableChanged) {
        persistence?.save(update.indicators.map(stripIndicatorRuntimeFields));
      }
    },
    [controlled, persistence],
  );

  useEffect(() => {
    if (!controlled) return;
    const reconciled = reconcilePersistedIndicatorDefinitions(
      ownedIndicatorsRef.current,
      controlledIndicators,
    );
    if (reconciled === ownedIndicatorsRef.current) return;
    ownedIndicatorsRef.current = reconciled;
    setOwnedIndicators(reconciled);
  }, [controlled, controlledIndicators]);

  useEffect(() => {
    if (!controlled) persistence?.save(ownedIndicators.map(stripIndicatorRuntimeFields));
  }, [controlled, ownedIndicators, persistence]);

  useEffect(() => {
    if (!autoAddVolume) return;
    if (volInitRef.current) return;
    volInitRef.current = true;

    if (activeIndicators.some((indicator) => indicator.id === "vol")) return;

    fetchPreset("vol")
      .then((full) => {
        if (!full) return;
        try {
          browserStorage()?.setItem(VOL_INIT_KEY, "1");
        } catch {
          // The indicator itself can still be added when storage is unavailable.
        }
        const prepared = prepareIndicator({
          id: full.id,
          name: full.name,
          engineName: full.engineName || null,
          script: full.script,
          params: full.params || {},
          description: full.description || "",
          category: full.category || "",
          paneTarget: full.paneTarget || "sub",
          isPreset: true,
          visible: true,
          lines: [],
        });
        if (prepared === null) return;
        setActiveIndicators((prev) => {
          if (prev.some((indicator) => indicator.id === "vol")) return prev;
          return [...prev, prepared];
        });
        onRequireCompute?.();
      })
      .catch((err) => console.warn("Failed to auto-add vol indicator:", err));
  }, [
    activeIndicators,
    autoAddVolume,
    onRequireCompute,
    prepareIndicator,
    setActiveIndicators,
  ]);

  const addIndicator = useCallback((indicator: IndicatorDefinition) => {
    const prepared = prepareIndicator(indicator);
    if (prepared === null) return;
    setActiveIndicators((prev) => {
      if (prev.some((item) => item.id === prepared.id)) return prev;
      return [...prev, { ...prepared, visible: true, lines: [] }];
    });
    onRequireCompute?.();
  }, [onRequireCompute, prepareIndicator, setActiveIndicators]);

  const removeIndicator = useCallback((indicatorId: string) => {
    setActiveIndicators((prev) => prev.filter((indicator) => indicator.id !== indicatorId));
  }, [setActiveIndicators]);

  const toggleVisibility = useCallback((indicatorId: string) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, visible: !indicator.visible }
          : indicator
      )
    );
  }, [setActiveIndicators]);

  const updateIndicatorParams = useCallback((indicatorId: string, newParams: IndicatorParams) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, params: newParams }
          : indicator
      )
    );
    onRequireCompute?.();
  }, [onRequireCompute, setActiveIndicators]);

  const updateIndicatorScript = useCallback((
    indicatorId: string,
    newScript: string,
    language?: string,
    securityMode?: string,
  ) => {
    setActiveIndicators((prev) => prev.map((indicator) => {
      if (indicator.id !== indicatorId) return indicator;
      return applyIndicatorScriptUpdate(
        indicator,
        newScript,
        language,
        securityMode,
        normalizeIndicator,
      );
    }));
    onRequireCompute?.();
  }, [normalizeIndicator, onRequireCompute, setActiveIndicators]);

  return {
    activeIndicators,
    setActiveIndicators,
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  };
}
