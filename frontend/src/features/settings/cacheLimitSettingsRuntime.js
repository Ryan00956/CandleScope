import { useEffect } from "react";
import { updateCacheLimits } from "../../services/api";

export function useCacheLimitsSync({
  cacheLimits,
  ephemeralCacheBars,
  sqliteStorageBudgetBytes,
  storageRowLimitsEnabled,
}) {
  useEffect(() => {
    if (!cacheLimits) return;
    updateCacheLimits({
      dbLimits: cacheLimits,
      ephemeralBars: ephemeralCacheBars ?? 86400,
      sqliteBudgetBytes: sqliteStorageBudgetBytes,
      storageRowLimitsEnabled,
    }).catch(() => {});
  }, [cacheLimits, ephemeralCacheBars, sqliteStorageBudgetBytes, storageRowLimitsEnabled]);
}
