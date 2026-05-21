import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPreset } from "../../services/indicatorApi";

const ACTIVE_INDICATORS_KEY = "candlescope-active-indicators";
const VOL_INIT_KEY = "candlescope-vol-initialized";

export function loadActiveIndicators() {
  try {
    const raw = localStorage.getItem(ACTIVE_INDICATORS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveActiveIndicators(list) {
  localStorage.setItem(ACTIVE_INDICATORS_KEY, JSON.stringify(list));
}

export function stripIndicatorRuntimeFields(indicator) {
  const rest = { ...indicator };
  delete rest.lines;
  delete rest.error;
  return rest;
}

export function useActiveIndicatorStore({ onRequireCompute } = {}) {
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

  const addIndicator = useCallback((indicator) => {
    setActiveIndicators((prev) => {
      if (prev.some((item) => item.id === indicator.id)) return prev;
      return [...prev, { ...indicator, visible: true, lines: [] }];
    });
    onRequireCompute?.();
  }, [onRequireCompute]);

  const removeIndicator = useCallback((indicatorId) => {
    setActiveIndicators((prev) => prev.filter((indicator) => indicator.id !== indicatorId));
  }, []);

  const toggleVisibility = useCallback((indicatorId) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, visible: !indicator.visible }
          : indicator
      )
    );
  }, []);

  const updateIndicatorParams = useCallback((indicatorId, newParams) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, params: newParams }
          : indicator
      )
    );
    onRequireCompute?.();
  }, [onRequireCompute]);

  const updateIndicatorScript = useCallback((indicatorId, newScript) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? { ...indicator, script: newScript }
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
