import { useCallback, useEffect, useState } from "react";
import { markPerf } from "../../runtime/performance/perfMarks";
import { SETTINGS_ACTION_TYPES } from "./settingsActionTypes";
import { SETTINGS_CATEGORIES } from "./settingsTabRegistry";
import { useCacheDiagnosticsRuntime } from "./cacheDiagnosticsSettingsRuntime";
import { useExchangeSettingsRuntime } from "./exchangeSettingsRuntime";
import { useProxySettingsRuntime } from "./proxySettingsRuntime";
import { useSettingsMaintenanceRuntime } from "./maintenanceSettingsRuntime";
import type { ChartSettings } from "./chartAppearanceSettings.js";
import type { CacheTrimOwnerResult, GcVictim } from "../cache-gc/cacheGcTypes.js";
import type { WatchlistGroup } from "../watchlist/watchlistTypes.js";
import type { SettingsRuntimeActions, SettingsRuntimeView } from "./settingsTypes.js";

export { SETTINGS_CATEGORIES };

export interface UseSettingsRuntimeOptions {
  isOpen: boolean;
  settings: ChartSettings;
  onUpdate(settings: ChartSettings): void;
  currentSymbol?: string;
  currentMarketType?: string;
  currentExchange?: string;
  watchlists?: WatchlistGroup[];
  chartDataCacheDiagnostics?: unknown;
  trimChartDataCacheEntries?: ((victims: GcVictim[]) => CacheTrimOwnerResult) | null;
}

export interface SettingsRuntime {
  view: SettingsRuntimeView & {
    actionTypes: typeof SETTINGS_ACTION_TYPES;
  };
  actions: SettingsRuntimeActions;
  status: Record<string, never>;
}

export function useSettingsRuntime({
  isOpen,
  settings,
  onUpdate,
  currentSymbol = "",
  currentMarketType = "spot",
  currentExchange = "binance",
  watchlists = [],
  chartDataCacheDiagnostics = null,
  trimChartDataCacheEntries = null,
}: UseSettingsRuntimeOptions): SettingsRuntime {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const exchangeRuntime = useExchangeSettingsRuntime({ isOpen });
  const proxyRuntime = useProxySettingsRuntime({ isOpen });
  const maintenanceRuntime = useSettingsMaintenanceRuntime({
    isOpen,
    currentSymbol,
    currentMarketType,
    currentExchange,
    watchlists,
  });
  const cacheDiagnosticsRuntime = useCacheDiagnosticsRuntime({
    chartDataCacheDiagnostics,
    isOpen,
    settings,
    trimChartDataCacheEntries,
  });

  useEffect(() => {
    if (isOpen) markPerf("lazy.settings.ready");
  }, [isOpen]);

  const handleToggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, []);

  const view: SettingsRuntime["view"] = {
      appearance: {
        settings,
        onUpdate,
      },
      proxy: proxyRuntime,
      exchanges: {
        currentExchange,
        ...exchangeRuntime,
      },
      cacheLimits: {
        settings,
        onUpdate,
        showAdvanced,
      },
      cacheDiagnostics: cacheDiagnosticsRuntime,
      maintenance: {
        currentSymbol,
        currentMarketType,
        currentExchange,
        ...maintenanceRuntime,
      },
      database: {
        currentExchange,
        currentMarketType,
        currentSymbol,
        watchlists,
      },
      actionTypes: SETTINGS_ACTION_TYPES,
  };

  const actions: SettingsRuntimeActions = {
      proxy: {
        onProxyModeChange: proxyRuntime.handleProxyModeChange,
        onCustomProxyChange: proxyRuntime.handleCustomProxyChange,
        onProxyTest: proxyRuntime.handleProxyTest,
        onProxySave: proxyRuntime.handleProxySave,
      },
      exchanges: {
        onRefreshExchanges: exchangeRuntime.loadSupportedExchanges,
      },
      cacheLimits: {
        onToggleAdvanced: handleToggleAdvanced,
      },
      cacheDiagnostics: {
        onPlanBackendMemoryGc: cacheDiagnosticsRuntime.onPlanBackendMemoryGc,
        onPlanFrontendGc: cacheDiagnosticsRuntime.onPlanFrontendGc,
        onPlanStorageGc: cacheDiagnosticsRuntime.onPlanStorageGc,
        onRunBackendMemoryGc: cacheDiagnosticsRuntime.onRunBackendMemoryGc,
        onRunFrontendGc: cacheDiagnosticsRuntime.onRunFrontendGc,
        onRunStorageGc: cacheDiagnosticsRuntime.onRunStorageGc,
        onRefresh: cacheDiagnosticsRuntime.onRefresh,
        onVacuumStorage: cacheDiagnosticsRuntime.onVacuumStorage,
      },
      maintenance: {
        onStorageRepair: maintenanceRuntime.handleStorageRepair,
        onGapScan: maintenanceRuntime.handleGapScan,
        onExchangeRefresh: maintenanceRuntime.handleExchangeRefresh,
      },
  };

  return {
    view,
    actions,
    status: {},
  };
}
