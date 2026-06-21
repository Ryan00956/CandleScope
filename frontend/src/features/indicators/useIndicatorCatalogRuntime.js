import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteCustomIndicator as deleteCustomIndicatorRequest,
  fetchCustomIndicators,
  fetchPreset,
  fetchPresets,
  saveCustomIndicator as saveCustomIndicatorRequest,
} from "../../services/indicatorApi";

function normalizeCustomIndicator(item) {
  return {
    ...item,
    category: item.category || "custom",
    is_builtin: false,
    isPreset: false,
    paneTarget: item.renderHints?.paneTarget || item.paneTarget || "sub",
    securityMode: item.securityMode || "safe",
  };
}

function buildCustomIndicatorForChart(preset) {
  return {
    id: preset.id,
    name: preset.name,
    engineName: null,
    script: preset.script,
    params: preset.params || {},
    description: preset.description || "",
    category: preset.category || "custom",
    paneTarget: preset.paneTarget || preset.renderHints?.paneTarget || "sub",
    securityMode: preset.securityMode || "safe",
    kind: "script",
    isPreset: false,
  };
}

function buildBuiltinIndicatorForChart(fullPreset) {
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

function isCustomPreset(preset) {
  return preset.is_builtin === false || preset.isPreset === false || preset.kind === "script";
}

export function useIndicatorCatalogRuntime({ isOpen }) {
  const [presets, setPresets] = useState([]);
  const [customIndicators, setCustomIndicators] = useState([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!isOpen || loadedRef.current) return undefined;

    let cancelled = false;
    const loadIndicators = async () => {
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

    loadIndicators();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const resolvePresetForChart = useCallback(async (preset) => {
    if (isCustomPreset(preset)) {
      return buildCustomIndicatorForChart(preset);
    }
    const fullPreset = await fetchPreset(preset.id);
    return buildBuiltinIndicatorForChart(fullPreset);
  }, []);

  const removeCustomIndicator = useCallback((id) => {
    setCustomIndicators((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const upsertCustomIndicator = useCallback((saved, fallback = {}) => {
    const item = normalizeCustomIndicator({
      ...fallback,
      ...saved,
      paneTarget: saved.renderHints?.paneTarget || fallback.paneTarget || "sub",
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

  const deleteCustomIndicator = useCallback(async (id) => {
    await deleteCustomIndicatorRequest(id);
    removeCustomIndicator(id);
  }, [removeCustomIndicator]);

  const saveCustomIndicator = useCallback(async (draft) => {
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
