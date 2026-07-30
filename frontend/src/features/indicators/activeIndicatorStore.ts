import { useCallback, useEffect, useRef, useState } from "react";
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
  const [activeIndicators, setActiveIndicators] = useState<IndicatorDefinition[]>(() => (
    (persistence?.load() ?? []).flatMap((indicator) => {
      const prepared = normalizeIndicator ? normalizeIndicator(indicator) : indicator;
      return prepared === null ? [] : [prepared];
    })
  ));
  const volInitRef = useRef(false);

  useEffect(() => {
    persistence?.save(activeIndicators.map(stripIndicatorRuntimeFields));
  }, [activeIndicators, persistence]);

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
  ]);

  const addIndicator = useCallback((indicator: IndicatorDefinition) => {
    const prepared = prepareIndicator(indicator);
    if (prepared === null) return;
    setActiveIndicators((prev) => {
      if (prev.some((item) => item.id === prepared.id)) return prev;
      return [...prev, { ...prepared, visible: true, lines: [] }];
    });
    onRequireCompute?.();
  }, [onRequireCompute, prepareIndicator]);

  const removeIndicator = useCallback((indicatorId: string) => {
    setActiveIndicators((prev) => prev.filter((indicator) => indicator.id !== indicatorId));
  }, []);

  const toggleVisibility = useCallback((indicatorId: string) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, visible: !indicator.visible }
          : indicator
      )
    );
  }, []);

  const updateIndicatorParams = useCallback((indicatorId: string, newParams: IndicatorParams) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, params: newParams }
          : indicator
      )
    );
    onRequireCompute?.();
  }, [onRequireCompute]);

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
  }, [normalizeIndicator, onRequireCompute]);

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
