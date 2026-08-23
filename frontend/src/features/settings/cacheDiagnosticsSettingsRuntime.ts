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
import { t } from "../../i18n/index.js";
import type { ChartSettings } from "./chartAppearanceSettings.js";
import type {
  CacheDiagnostics,
  CacheTrimOwnerResult,
  FrontendGcExecutionResult,
  GcPlan,
  GcVictim,
} from "../cache-gc/cacheGcTypes.js";

export interface BackendGcVictim extends Record<string, unknown> {
  owner?: string;
  key: string;
  reason?: string;
  estimatedBytes?: number;
  estimated_bytes?: number;
  would_free_estimated_bytes?: number;
}

export interface StorageGcSeries extends Record<string, unknown> {
  owner?: string;
  key: string;
  reason?: string;
  would_delete_rows?: number;
  risk_flags?: string[];
}

export interface StorageFilesSummary extends Record<string, unknown> {
  exists?: boolean;
  db_size_bytes?: number;
  wal_size_bytes?: number;
  total_size_bytes?: number;
}

export interface StorageWatermarks extends Record<string, unknown> {
  budget_bytes?: number;
  level?: string;
  budget_usage_ratio?: number;
}

export interface BackendDiagnosticsResult extends Record<string, unknown> {
  data_manager?: {
    cache?: Record<string, unknown> & {
      total_series?: number;
      max_series?: number;
      total_bars?: number;
      max_bars_per_series?: number;
      hits?: number;
      misses?: number;
    };
  };
  storage?: {
    files?: StorageFilesSummary;
    series?: Record<string, unknown> & {
      series_count?: number;
      total_rows?: number;
      largest_series?: Array<{
        exchange?: string;
        market_type?: string;
        symbol?: string;
        interval?: string;
        total_count?: number;
      }>;
    };
    watermarks?: StorageWatermarks;
  };
  indicator?: {
    pyne_cache?: Record<string, unknown> & {
      size?: number;
      items?: number;
      max_items?: number;
      maxItems?: number;
    };
  };
  victims?: BackendGcVictim[];
  series?: StorageGcSeries[];
  pressure?: Record<string, number | undefined>;
  watermarks?: StorageWatermarks;
  would_free_estimated_bytes?: number;
  would_free_bars?: number;
  would_remove_series?: number;
  protected_count?: number;
  removed_series?: number;
  trimmed_series?: number;
  removed_bars?: number;
  removed_estimated_bytes?: number;
  would_delete_rows?: number;
  victim_count?: number;
  vacuum_recommended?: boolean;
  unable_to_reach_budget?: boolean;
  budget_gap_bytes?: number;
  deleted_rows?: number;
  affected_series?: number;
  elapsed_ms?: number;
  checkpoint_result?: unknown;
  status?: string;
  storage_files_after?: StorageFilesSummary;
}
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
      const backend = await fetchCacheDiagnostics(signal === undefined ? {} : { signal });
      setBackendDiagnostics(isRecord(backend) ? backend : {});
    } catch (err: unknown) {
      if (isRecord(err) && err.name === "AbortError") return;
      setError(errorMessage(err, t("core.error.cacheDiagnostics")));
      setBackendDiagnostics(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [chartDataCacheDiagnostics]);

  const planFrontendGcDryRun = useCallback(() => {
    const nextFrontendDiagnostics = buildFallbackFrontendDiagnostics(chartDataCacheDiagnostics);
    const plan = planFrontendGc(nextFrontendDiagnostics, {
      ...(settings.frontendCacheBudgetBytes === undefined
        ? {}
        : { maxEstimatedBytes: settings.frontendCacheBudgetBytes }),
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
      setError(errorMessage(err, t("core.error.backendGcEstimate")));
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
      setError(errorMessage(err, t("core.error.backendGcRun")));
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
        ...(settings.cacheLimits === undefined ? {} : { dbLimits: settings.cacheLimits }),
        ...(settings.sqliteStorageBudgetBytes === undefined
          ? {}
          : { sqliteBudgetBytes: settings.sqliteStorageBudgetBytes }),
        ...(settings.storageRowLimitsEnabled === undefined
          ? {}
          : { storageRowLimitsEnabled: settings.storageRowLimitsEnabled }),
      });
      const plan = isRecord(rawPlan) ? rawPlan : {};
      setStorageGcPlan(plan);
      setStorageGcResult(null);
      setStorageVacuumResult(null);
      return plan;
    } catch (err: unknown) {
      setError(errorMessage(err, t("core.error.storageGcEstimate")));
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
          ...(settings.cacheLimits === undefined ? {} : { dbLimits: settings.cacheLimits }),
          ...(settings.sqliteStorageBudgetBytes === undefined
            ? {}
            : { sqliteBudgetBytes: settings.sqliteStorageBudgetBytes }),
          ...(settings.storageRowLimitsEnabled === undefined
            ? {}
            : { storageRowLimitsEnabled: settings.storageRowLimitsEnabled }),
        },
      });
      const result = isRecord(rawResult) ? rawResult : {};
      setStorageGcResult(result);
      const backend = await fetchCacheDiagnostics();
      setBackendDiagnostics(isRecord(backend) ? backend : {});
      return result;
    } catch (err: unknown) {
      setError(errorMessage(err, t("core.error.storageGcRun")));
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
      setError(errorMessage(err, t("core.error.storageVacuum")));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const runFrontendGc = useCallback(() => {
    const plan = frontendGcPlan || planFrontendGcDryRun();
    const result = executeFrontendGcPlan(plan, {
      ...(trimChartDataCacheEntries === undefined ? {} : { trimChartDataCacheEntries }),
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
    void refresh({ signal: controller.signal });
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
