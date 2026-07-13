import { useEffect } from "react";
import { collectFrontendCacheDiagnosticsAsync } from "./cacheDiagnostics.js";
import {
  FRONTEND_AUTO_GC_DEFAULT_POLICY,
  runAutoFrontendGc,
} from "./autoGcPolicy.js";
import type { AutoGcPolicyPatch, ChartTrimFunction } from "./autoGcPolicy.js";

export interface UseFrontendAutoGcRuntimeOptions {
  chartDataCacheDiagnostics?: (() => unknown) | unknown | null;
  policy?: AutoGcPolicyPatch;
  trimChartDataCacheEntries?: ChartTrimFunction | null;
}

export function useFrontendAutoGcRuntime({
  chartDataCacheDiagnostics = null,
  policy = {},
  trimChartDataCacheEntries = null,
}: UseFrontendAutoGcRuntimeOptions = {}): void {
  useEffect(() => {
    if (!FRONTEND_AUTO_GC_DEFAULT_POLICY.enabled) return undefined;

    let cancelled = false;
    let running = false;

    const tick = async (): Promise<void> => {
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

    const timer: ReturnType<typeof setInterval> = setInterval(
      tick,
      FRONTEND_AUTO_GC_DEFAULT_POLICY.cooldownMs,
    );
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chartDataCacheDiagnostics, policy, trimChartDataCacheEntries]);
}
