import { useEffect } from "react";
import { collectFrontendCacheDiagnosticsAsync } from "./cacheDiagnostics.js";
import { FRONTEND_AUTO_GC_DEFAULT_POLICY, runAutoFrontendGc } from "./autoGcPolicy.js";

export function useFrontendAutoGcRuntime({
  chartDataCacheDiagnostics = null,
  policy = {},
  trimChartDataCacheEntries = null,
} = {}) {
  useEffect(() => {
    if (!FRONTEND_AUTO_GC_DEFAULT_POLICY.enabled) return undefined;

    let cancelled = false;
    let running = false;

    const tick = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        const diagnostics = await collectFrontendCacheDiagnosticsAsync({
          chartDataCache: chartDataCacheDiagnostics,
        });
        if (!cancelled) {
          runAutoFrontendGc(diagnostics, { policy, trimChartDataCacheEntries });
        }
      } catch {
        // Automatic cache cleanup must never interrupt chart interaction.
      } finally {
        running = false;
      }
    };

    const timer = setInterval(tick, FRONTEND_AUTO_GC_DEFAULT_POLICY.cooldownMs);
    tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chartDataCacheDiagnostics, policy, trimChartDataCacheEntries]);
}
