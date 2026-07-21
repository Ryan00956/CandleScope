import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { fetchPreset } from "../../services/indicatorApi.js";
import type { IndicatorDefinition, IndicatorParams } from "./indicatorTypes.js";

const ACTIVE_INDICATORS_KEY = "candlescope-active-indicators";
const VOL_INIT_KEY = "candlescope-vol-initialized";

export function loadActiveIndicators(): IndicatorDefinition[] {
  try {
    const raw = localStorage.getItem(ACTIVE_INDICATORS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is IndicatorDefinition => (
          Boolean(item)
          && typeof item === "object"
          && !Array.isArray(item)
          && typeof (item as Record<string, unknown>).id === "string"
        ))
      : [];
  } catch {
    return [];
  }
}

export function saveActiveIndicators(list: IndicatorDefinition[]): void {
  localStorage.setItem(ACTIVE_INDICATORS_KEY, JSON.stringify(list));
}

export function stripIndicatorRuntimeFields(indicator: IndicatorDefinition): IndicatorDefinition {
  const rest = { ...indicator };
  delete rest.lines;
  delete rest.error;
  return rest;
}

export interface UseActiveIndicatorStoreOptions {
  onRequireCompute?: () => void;
}

export interface ActiveIndicatorStore {
  activeIndicators: IndicatorDefinition[];
  setActiveIndicators: Dispatch<SetStateAction<IndicatorDefinition[]>>;
  addIndicator(indicator: IndicatorDefinition): void;
  removeIndicator(indicatorId: string): void;
  toggleVisibility(indicatorId: string): void;
  updateIndicatorParams(indicatorId: string, newParams: IndicatorParams): void;
  updateIndicatorScript(indicatorId: string, newScript: string, language?: string): void;
}

export function useActiveIndicatorStore({
  onRequireCompute,
}: UseActiveIndicatorStoreOptions = {}): ActiveIndicatorStore {
  const [activeIndicators, setActiveIndicators] = useState(loadActiveIndicators);
  const volInitRef = useRef(false);

  useEffect(() => {
    saveActiveIndicators(activeIndicators.map(stripIndicatorRuntimeFields));
  }, [activeIndicators]);

  useEffect(() => {
    if (volInitRef.current) return;
    volInitRef.current = true;

    const current = loadActiveIndicators();
    if (current.some((indicator) => indicator.id === "vol")) return;

    fetchPreset("vol")
      .then((full) => {
        if (!full) return;
        localStorage.setItem(VOL_INIT_KEY, "1");
        setActiveIndicators((prev) => {
          if (prev.some((indicator) => indicator.id === "vol")) return prev;
          return [
            ...prev,
            {
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
            },
          ];
        });
        onRequireCompute?.();
      })
      .catch((err) => console.warn("Failed to auto-add vol indicator:", err));
  }, [onRequireCompute]);

  const addIndicator = useCallback((indicator: IndicatorDefinition) => {
    setActiveIndicators((prev) => {
      if (prev.some((item) => item.id === indicator.id)) return prev;
      return [...prev, { ...indicator, visible: true, lines: [] }];
    });
    onRequireCompute?.();
  }, [onRequireCompute]);

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
  ) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? {
              ...indicator,
              script: newScript,
              ...(language ? { language } : {}),
            }
          : indicator
      )
    );
    onRequireCompute?.();
  }, [onRequireCompute]);

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
