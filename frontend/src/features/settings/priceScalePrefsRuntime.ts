import { useCallback, useState } from "react";

interface UserPreferences extends Record<string, unknown> {
  invertScale?: unknown;
  priceScaleMode?: unknown;
}

export interface PriceScalePrefsRuntime {
  invertScale: boolean;
  handleInvertScaleChange(value: boolean): void;
  priceScaleMode: number;
  handlePriceScaleModeChange(mode: number): void;
}

export function usePriceScalePrefs({
  loadUserPrefs,
  updateUserPref,
}: {
  loadUserPrefs(): UserPreferences;
  updateUserPref(key: string, value: unknown): void;
}): PriceScalePrefsRuntime {
  const [invertScale, setInvertScale] = useState(() => {
    const prefs = loadUserPrefs();
    return !!prefs.invertScale;
  });
  const [priceScaleMode, setPriceScaleMode] = useState(() => {
    const prefs = loadUserPrefs();
    return typeof prefs.priceScaleMode === "number" ? prefs.priceScaleMode : 0;
  });

  const handleInvertScaleChange = useCallback((value: boolean) => {
    setInvertScale(value);
    updateUserPref("invertScale", value);
  }, [updateUserPref]);

  const handlePriceScaleModeChange = useCallback((mode: number) => {
    setPriceScaleMode(mode);
    updateUserPref("priceScaleMode", mode);
  }, [updateUserPref]);

  return {
    invertScale,
    handleInvertScaleChange,
    priceScaleMode,
    handlePriceScaleModeChange,
  };
}
