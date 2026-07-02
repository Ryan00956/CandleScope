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

function buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics) {
  return collectFrontendCacheDiagnostics({
    chartDataCache: chartDataCacheDiagnostics,
  });
}

export function useCacheDiagnosticsRuntime({
  chartDataCacheDiagnostics,
  isOpen,
  settings = {},
  trimChartDataCacheEntries,
}) {
  const [frontendDiagnostics, setFrontendDiagnostics] = useState(() =>
    buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics)
  );
  const [backendDiagnostics, setBackendDiagnostics] = useState(null);
  const [frontendGcPlan, setFrontendGcPlan] = useState(null);
  const [frontendGcResult, setFrontendGcResult] = useState(null);
  const [backendMemoryGcPlan, setBackendMemoryGcPlan] = useState(null);
  const [backendMemoryGcResult, setBackendMemoryGcResult] = useState(null);
  const [storageGcPlan, setStorageGcPlan] = useState(null);
  const [storageGcResult, setStorageGcResult] = useState(null);
  const [storageVacuumResult, setStorageVacuumResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async ({ signal } = {}) => {
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
      setBackendDiagnostics(backend);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError(err?.message || "缓存诊断加载失败");
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
      const plan = await planBackendMemoryGc();
      setBackendMemoryGcPlan(plan);
      setBackendMemoryGcResult(null);
      return plan;
    } catch (err) {
      setError(err?.message || "后端内存 GC 预估失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const runBackendMemoryGcNow = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await runBackendMemoryGc();
      setBackendMemoryGcResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(backend);
      return result;
    } catch (err) {
      setError(err?.message || "后端内存 GC 执行失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const planStorageGcDryRun = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const plan = await planStorageGc({
        dbLimits: settings.cacheLimits,
        sqliteBudgetBytes: settings.sqliteStorageBudgetBytes,
        storageRowLimitsEnabled: settings.storageRowLimitsEnabled,
      });
      setStorageGcPlan(plan);
      setStorageGcResult(null);
      setStorageVacuumResult(null);
      return plan;
    } catch (err) {
      setError(err?.message || "数据库 GC 预估失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, [settings.cacheLimits, settings.sqliteStorageBudgetBytes, settings.storageRowLimitsEnabled]);

  const runStorageGcNow = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await runStorageGc({
        policy: {
          dbLimits: settings.cacheLimits,
          sqliteBudgetBytes: settings.sqliteStorageBudgetBytes,
          storageRowLimitsEnabled: settings.storageRowLimitsEnabled,
        },
      });
      setStorageGcResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(backend);
      return result;
    } catch (err) {
      setError(err?.message || "数据库 GC 执行失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, [settings.cacheLimits, settings.sqliteStorageBudgetBytes, settings.storageRowLimitsEnabled]);

  const vacuumStorageNow = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await vacuumStorage();
      setStorageVacuumResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(backend);
      return result;
    } catch (err) {
      setError(err?.message || "数据库 VACUUM 失败");
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
