import { useCallback, useState } from "react";

export function usePriceScalePrefs({ loadUserPrefs, updateUserPref }) {
  const [invertScale, setInvertScale] = useState(() => {
    const prefs = loadUserPrefs();
    return !!prefs.invertScale;
  });
  const [priceScaleMode, setPriceScaleMode] = useState(() => {
    const prefs = loadUserPrefs();
    return typeof prefs.priceScaleMode === "number" ? prefs.priceScaleMode : 0;
  });

  const handleInvertScaleChange = useCallback((value) => {
    setInvertScale(value);
    updateUserPref("invertScale", value);
  }, [updateUserPref]);

  const handlePriceScaleModeChange = useCallback((mode) => {
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
