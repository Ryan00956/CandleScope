import { useEffect } from "react";
import { updateCacheLimits } from "../../services/api";

export function useCacheLimitsSync({ cacheLimits, ephemeralCacheBars }) {
  useEffect(() => {
    if (!cacheLimits) return;
    updateCacheLimits({
      dbLimits: cacheLimits,
      ephemeralBars: ephemeralCacheBars ?? 86400,
    }).catch(() => {});
  }, [cacheLimits, ephemeralCacheBars]);
}
