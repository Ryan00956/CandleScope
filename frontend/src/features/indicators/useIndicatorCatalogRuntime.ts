import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteCustomIndicator as deleteCustomIndicatorRequest,
  fetchCustomIndicators,
  fetchPreset,
  fetchPresets,
  saveCustomIndicator as saveCustomIndicatorRequest,
} from "../../services/indicatorApi.js";
import type {
  CustomIndicatorRecord,
  CustomIndicatorSaveInput,
  IndicatorDefinition,
  IndicatorPreset,
} from "./indicatorTypes.js";

export type CatalogCustomIndicator = CustomIndicatorRecord
  & Omit<IndicatorDefinition, keyof CustomIndicatorRecord>
  & {
    category: string;
    is_builtin: false;
    isPreset: false;
    paneTarget: string;
    securityMode: string;
  };

export type CatalogIndicator = IndicatorPreset | CatalogCustomIndicator | IndicatorDefinition;
type CatalogFallback = Partial<CustomIndicatorRecord>
  & Partial<Pick<IndicatorDefinition, "category" | "paneTarget">>;

function renderPaneTarget(value: Record<string, unknown> | undefined): string | null {
  return typeof value?.paneTarget === "string" ? value.paneTarget : null;
}

function normalizeCustomIndicator(
  item: CustomIndicatorRecord & Partial<Pick<IndicatorDefinition, "category" | "paneTarget">>,
): CatalogCustomIndicator {
  return {
    ...item,
    category: item.category || "custom",
    is_builtin: false,
    isPreset: false,
    paneTarget: renderPaneTarget(item.renderHints) || item.paneTarget || "sub",
    securityMode: item.securityMode || "safe",
  };
}

function buildCustomIndicatorForChart(preset: CatalogCustomIndicator): IndicatorDefinition {
  return {
    id: preset.id,
    name: preset.name,
    engineName: null,
    script: preset.script,
    params: preset.params || {},
    description: preset.description || "",
    category: preset.category || "custom",
    paneTarget: preset.paneTarget || renderPaneTarget(preset.renderHints) || "sub",
    securityMode: preset.securityMode || "safe",
    kind: "script",
    isPreset: false,
  };
}

function buildBuiltinIndicatorForChart(fullPreset: IndicatorPreset): IndicatorDefinition {
  return {
    id: fullPreset.id,
    name: fullPreset.name,
    engineName: fullPreset.engineName || null,
    script: fullPreset.script,
    params: fullPreset.params || {},
    description: fullPreset.description || "",
    category: fullPreset.category || "",
    paneTarget: fullPreset.paneTarget || "sub",
    kind: "builtin",
    isPreset: true,
  };
}

function isCustomPreset(preset: CatalogIndicator): preset is CatalogCustomIndicator {
  return preset.is_builtin === false || preset.isPreset === false || preset.kind === "script";
}

export interface UseIndicatorCatalogRuntimeOptions {
  isOpen: boolean;
}

export interface IndicatorCatalogRuntime {
  customIndicators: CatalogCustomIndicator[];
  deleteCustomIndicator(id: string): Promise<void>;
  presets: IndicatorPreset[];
  presetsLoading: boolean;
  removeCustomIndicator(id: string): void;
  resolvePresetForChart(preset: CatalogIndicator): Promise<IndicatorDefinition>;
  saveCustomIndicator(draft: CustomIndicatorSaveInput): Promise<CustomIndicatorRecord>;
  upsertCustomIndicator(saved: CustomIndicatorRecord, fallback?: CatalogFallback): void;
}

export function useIndicatorCatalogRuntime({
  isOpen,
}: UseIndicatorCatalogRuntimeOptions): IndicatorCatalogRuntime {
  const [presets, setPresets] = useState<IndicatorPreset[]>([]);
  const [customIndicators, setCustomIndicators] = useState<CatalogCustomIndicator[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!isOpen || loadedRef.current) return undefined;

    let cancelled = false;
    const loadIndicators = async (): Promise<void> => {
      setPresetsLoading(true);
      try {
        const [presetData, customData] = await Promise.all([fetchPresets(), fetchCustomIndicators()]);
        if (cancelled) return;
        setPresets(presetData);
        setCustomIndicators((customData || []).map(normalizeCustomIndicator));
        loadedRef.current = true;
      } catch (error) {
        console.error("Failed to load presets:", error);
      } finally {
        if (!cancelled) setPresetsLoading(false);
      }
    };

    void loadIndicators();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const resolvePresetForChart = useCallback(async (preset: CatalogIndicator) => {
    if (isCustomPreset(preset)) {
      return buildCustomIndicatorForChart(preset);
    }
    const fullPreset = await fetchPreset(preset.id);
    return buildBuiltinIndicatorForChart(fullPreset);
  }, []);

  const removeCustomIndicator = useCallback((id: string) => {
    setCustomIndicators((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const upsertCustomIndicator = useCallback((
    saved: CustomIndicatorRecord,
    fallback: CatalogFallback = {},
  ) => {
    const item = normalizeCustomIndicator({
      ...fallback,
      ...saved,
      paneTarget: renderPaneTarget(saved.renderHints) || fallback.paneTarget || "sub",
      securityMode: saved.securityMode || fallback.securityMode || "safe",
    });
    setCustomIndicators((prev) => {
      const index = prev.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) return [...prev, item];
      const next = [...prev];
      next[index] = item;
      return next;
    });
  }, []);

  const deleteCustomIndicator = useCallback(async (id: string) => {
    await deleteCustomIndicatorRequest(id);
    removeCustomIndicator(id);
  }, [removeCustomIndicator]);

  const saveCustomIndicator = useCallback(async (draft: CustomIndicatorSaveInput) => {
    const saved = await saveCustomIndicatorRequest(draft);
    upsertCustomIndicator(saved, draft);
    return saved;
  }, [upsertCustomIndicator]);

  return {
    customIndicators,
    deleteCustomIndicator,
    presets,
    presetsLoading,
    removeCustomIndicator,
    resolvePresetForChart,
    saveCustomIndicator,
    upsertCustomIndicator,
  };
}
