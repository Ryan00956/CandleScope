import { useCallback, useEffect, useState } from "react";
import {
  fetchCacheDiagnostics,
  planBackendMemoryGc,
  planStorageGc,
  recordCacheAccess,
  runBackendMemoryGc,
  runStorageGc,
  vacuumStorage,
} from "../../services/api";
import { collectFrontendCacheDiagnostics, collectFrontendCacheDiagnosticsAsync } from "../cache-gc/cacheDiagnostics";
import { drainFrontendCacheAccessEvents } from "../cache-gc/cacheAccessRuntime";
import { planFrontendGc } from "../cache-gc/cachePolicy";
import { executeFrontendGcPlan } from "../cache-gc/cacheTrim";
import type { ChartSettings } from "./chartAppearanceSettings.js";
import type {
  CacheDiagnostics,
  CacheTrimOwnerResult,
  FrontendGcExecutionResult,
  GcPlan,
  GcVictim,
} from "../cache-gc/cacheGcTypes.js";

type BackendDiagnosticsResult = Record<string, unknown>;
type TrimChartDataCacheEntries = (victims: GcVictim[]) => CacheTrimOwnerResult;

export interface CacheDiagnosticsRuntime extends Record<string, unknown> {
  frontendDiagnostics: CacheDiagnostics;
  backendDiagnostics: BackendDiagnosticsResult | null;
  backendMemoryGcPlan: BackendDiagnosticsResult | null;
  backendMemoryGcResult: BackendDiagnosticsResult | null;
  frontendGcPlan: GcPlan | null;
  frontendGcResult: FrontendGcExecutionResult | null;
  loading: boolean;
  error: string;
  onPlanBackendMemoryGc(): Promise<BackendDiagnosticsResult | null>;
  onPlanFrontendGc(): GcPlan;
  onPlanStorageGc(): Promise<BackendDiagnosticsResult | null>;
  onRunBackendMemoryGc(): Promise<BackendDiagnosticsResult | null>;
  onRunFrontendGc(): FrontendGcExecutionResult;
  onRunStorageGc(): Promise<BackendDiagnosticsResult | null>;
  onRefresh(options?: { signal?: AbortSignal }): Promise<void>;
  onVacuumStorage(): Promise<BackendDiagnosticsResult | null>;
  storageGcPlan: BackendDiagnosticsResult | null;
  storageGcResult: BackendDiagnosticsResult | null;
  storageVacuumResult: BackendDiagnosticsResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics: unknown): CacheDiagnostics {
  return collectFrontendCacheDiagnostics({
    chartDataCache: chartDataCacheDiagnostics,
  });
}

export function useCacheDiagnosticsRuntime({
  chartDataCacheDiagnostics,
  isOpen,
  settings = {},
  trimChartDataCacheEntries,
}: {
  chartDataCacheDiagnostics: unknown;
  isOpen: boolean;
  settings?: Partial<Pick<ChartSettings,
    "cacheLimits" | "frontendCacheBudgetBytes" | "sqliteStorageBudgetBytes" | "storageRowLimitsEnabled">>;
  trimChartDataCacheEntries?: TrimChartDataCacheEntries | null;
}): CacheDiagnosticsRuntime {
  const [frontendDiagnostics, setFrontendDiagnostics] = useState<CacheDiagnostics>(() =>
    buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics)
  );
  const [backendDiagnostics, setBackendDiagnostics] = useState<BackendDiagnosticsResult | null>(null);
  const [frontendGcPlan, setFrontendGcPlan] = useState<GcPlan | null>(null);
  const [frontendGcResult, setFrontendGcResult] = useState<FrontendGcExecutionResult | null>(null);
  const [backendMemoryGcPlan, setBackendMemoryGcPlan] = useState<BackendDiagnosticsResult | null>(null);
  const [backendMemoryGcResult, setBackendMemoryGcResult] = useState<BackendDiagnosticsResult | null>(null);
  const [storageGcPlan, setStorageGcPlan] = useState<BackendDiagnosticsResult | null>(null);
  const [storageGcResult, setStorageGcResult] = useState<BackendDiagnosticsResult | null>(null);
  const [storageVacuumResult, setStorageVacuumResult] = useState<BackendDiagnosticsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async ({ signal }: { signal?: AbortSignal } = {}): Promise<void> => {
    const nextFrontendDiagnostics = await collectFrontendCacheDiagnosticsAsync({
      chartDataCache: chartDataCacheDiagnostics,
    });
    setFrontendDiagnostics(nextFrontendDiagnostics);
    setFrontendGcPlan(null);
    setFrontendGcResult(null);
    setBackendMemoryGcPlan(null);
    setBackendMemoryGcResult(null);
    setStorageGcPlan(null);
    setStorageGcResult(null);
    setStorageVacuumResult(null);
    setLoading(true);
    setError("");
    try {
      const accessEvents = drainFrontendCacheAccessEvents(20);
      await Promise.allSettled(accessEvents.map((event) => recordCacheAccess(event)));
      const backend = await fetchCacheDiagnostics({ signal });
      setBackendDiagnostics(isRecord(backend) ? backend : {});
    } catch (err: unknown) {
      if (isRecord(err) && err.name === "AbortError") return;
      setError(errorMessage(err, "缓存诊断加载失败"));
      setBackendDiagnostics(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [chartDataCacheDiagnostics]);

  const planFrontendGcDryRun = useCallback(() => {
    const nextFrontendDiagnostics = buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics);
    const plan = planFrontendGc(nextFrontendDiagnostics, {
      maxEstimatedBytes: settings.frontendCacheBudgetBytes,
    });
    setFrontendDiagnostics(nextFrontendDiagnostics);
    setFrontendGcPlan(plan);
    setFrontendGcResult(null);
    return plan;
  }, [chartDataCacheDiagnostics, settings.frontendCacheBudgetBytes]);

  const planBackendMemoryGcDryRun = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rawPlan = await planBackendMemoryGc();
      const plan = isRecord(rawPlan) ? rawPlan : {};
      setBackendMemoryGcPlan(plan);
      setBackendMemoryGcResult(null);
      return plan;
    } catch (err: unknown) {
      setError(errorMessage(err, "后端内存 GC 预估失败"));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const runBackendMemoryGcNow = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rawResult = await runBackendMemoryGc();
      const result = isRecord(rawResult) ? rawResult : {};
      setBackendMemoryGcResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(isRecord(backend) ? backend : {});
      return result;
    } catch (err: unknown) {
      setError(errorMessage(err, "后端内存 GC 执行失败"));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const planStorageGcDryRun = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rawPlan = await planStorageGc({
        dbLimits: settings.cacheLimits,
        sqliteBudgetBytes: settings.sqliteStorageBudgetBytes,
        storageRowLimitsEnabled: settings.storageRowLimitsEnabled,
      });
      const plan = isRecord(rawPlan) ? rawPlan : {};
      setStorageGcPlan(plan);
      setStorageGcResult(null);
      setStorageVacuumResult(null);
      return plan;
    } catch (err: unknown) {
      setError(errorMessage(err, "数据库 GC 预估失败"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [settings.cacheLimits, settings.sqliteStorageBudgetBytes, settings.storageRowLimitsEnabled]);

  const runStorageGcNow = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rawResult = await runStorageGc({
        policy: {
          dbLimits: settings.cacheLimits,
          sqliteBudgetBytes: settings.sqliteStorageBudgetBytes,
          storageRowLimitsEnabled: settings.storageRowLimitsEnabled,
        },
      });
      const result = isRecord(rawResult) ? rawResult : {};
      setStorageGcResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(isRecord(backend) ? backend : {});
      return result;
    } catch (err: unknown) {
      setError(errorMessage(err, "数据库 GC 执行失败"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [settings.cacheLimits, settings.sqliteStorageBudgetBytes, settings.storageRowLimitsEnabled]);

  const vacuumStorageNow = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rawResult = await vacuumStorage();
      const result = isRecord(rawResult) ? rawResult : {};
      setStorageVacuumResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(isRecord(backend) ? backend : {});
      return result;
    } catch (err: unknown) {
      setError(errorMessage(err, "数据库 VACUUM 失败"));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const runFrontendGc = useCallback(() => {
    const plan = frontendGcPlan || planFrontendGcDryRun();
    const result = executeFrontendGcPlan(plan, {
      trimChartDataCacheEntries,
    });
    setFrontendGcResult(result);
    setFrontendDiagnostics(buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics));
    return result;
  }, [
    chartDataCacheDiagnostics,
    frontendGcPlan,
    planFrontendGcDryRun,
    trimChartDataCacheEntries,
  ]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const controller = new AbortController();
    refresh({ signal: controller.signal });
    return () => controller.abort();
  }, [isOpen, refresh]);

  return {
    frontendDiagnostics,
    backendDiagnostics,
    backendMemoryGcPlan,
    backendMemoryGcResult,
    frontendGcPlan,
    frontendGcResult,
    loading,
    error,
    onPlanBackendMemoryGc: planBackendMemoryGcDryRun,
    onPlanFrontendGc: planFrontendGcDryRun,
    onPlanStorageGc: planStorageGcDryRun,
    onRunBackendMemoryGc: runBackendMemoryGcNow,
    onRunFrontendGc: runFrontendGc,
    onRunStorageGc: runStorageGcNow,
    onRefresh: refresh,
    onVacuumStorage: vacuumStorageNow,
    storageGcPlan,
    storageGcResult,
    storageVacuumResult,
  };
}
