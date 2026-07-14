import { useEffect } from "react";
import { updateCacheLimits } from "../../services/api";
import type { CacheRowLimits } from "./chartAppearanceSettings.js";

export function useCacheLimitsSync({
  cacheLimits,
  ephemeralCacheBars,
  sqliteStorageBudgetBytes,
  storageRowLimitsEnabled,
}: {
  cacheLimits: CacheRowLimits | null | undefined;
  ephemeralCacheBars: number | null | undefined;
  sqliteStorageBudgetBytes: number | null | undefined;
  storageRowLimitsEnabled: boolean;
}): void {
  useEffect(() => {
    if (!cacheLimits) return;
    updateCacheLimits({
      dbLimits: cacheLimits,
      ephemeralBars: ephemeralCacheBars ?? 86400,
      ...(sqliteStorageBudgetBytes === undefined ? {} : {
        sqliteBudgetBytes: sqliteStorageBudgetBytes,
      }),
      storageRowLimitsEnabled,
    }).catch(() => {});
  }, [cacheLimits, ephemeralCacheBars, sqliteStorageBudgetBytes, storageRowLimitsEnabled]);
}
