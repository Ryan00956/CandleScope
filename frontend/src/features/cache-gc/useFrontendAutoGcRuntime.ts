import { useEffect, useRef } from "react";
import { collectFrontendCacheDiagnosticsAsync } from "./cacheDiagnostics.js";
import { runAutoFrontendGc } from "./autoGcPolicy.js";
import type { AutoGcPolicyPatch, ChartTrimFunction } from "./autoGcPolicy.js";
import {
  createFrontendAutoGcScheduler,
  resolveFrontendAutoGcSchedule,
} from "./frontendAutoGcScheduler.js";
import type { FrontendAutoGcSchedulerSnapshot } from "./frontendAutoGcScheduler.js";
import type { CacheDiagnostics } from "./cacheGcTypes.js";

export interface UseFrontendAutoGcRuntimeOptions {
  chartDataCacheDiagnostics?: (() => unknown) | unknown | null;
  policy?: AutoGcPolicyPatch;
  trimChartDataCacheEntries?: ChartTrimFunction | null;
  onError?: (
    error: unknown,
    snapshot: FrontendAutoGcSchedulerSnapshot,
  ) => void;
  onStateChange?: (snapshot: FrontendAutoGcSchedulerSnapshot) => void;
}

export function useFrontendAutoGcRuntime({
  chartDataCacheDiagnostics = null,
  policy = {},
  trimChartDataCacheEntries = null,
  onError,
  onStateChange,
}: UseFrontendAutoGcRuntimeOptions = {}): void {
  const optionsRef = useRef({
    chartDataCacheDiagnostics,
    policy,
    trimChartDataCacheEntries,
    onError,
    onStateChange,
  });
  useEffect(() => {
    optionsRef.current = {
      chartDataCacheDiagnostics,
      policy,
      trimChartDataCacheEntries,
      onError,
      onStateChange,
    };
  }, [chartDataCacheDiagnostics, policy, trimChartDataCacheEntries, onError, onStateChange]);
  const schedule = resolveFrontendAutoGcSchedule(policy);

  useEffect(() => {
    const scheduler = createFrontendAutoGcScheduler({
      enabled: schedule.enabled,
      cooldownMs: schedule.cooldownMs,
      collectDiagnostics: async () => collectFrontendCacheDiagnosticsAsync({
        chartDataCache: optionsRef.current.chartDataCacheDiagnostics,
      }),
      runGc: (diagnostics) => runAutoFrontendGc(diagnostics as CacheDiagnostics, {
        policy: optionsRef.current.policy,
        trimChartDataCacheEntries: optionsRef.current.trimChartDataCacheEntries,
      }),
      onError: (error, snapshot) => optionsRef.current.onError?.(error, snapshot),
      onStateChange: (snapshot) => optionsRef.current.onStateChange?.(snapshot),
    });
    scheduler.start();
    return () => {
      scheduler.stop();
    };
  }, [schedule.enabled, schedule.cooldownMs]);
}
