import { useCallback, useEffect, useState } from "react";
import { markPerf } from "../../runtime/performance/perfMarks";
import { SETTINGS_ACTION_TYPES } from "./settingsActionTypes";
import { useExchangeSettingsRuntime } from "./exchangeSettingsRuntime";
import { useProxySettingsRuntime } from "./proxySettingsRuntime";
import { useSettingsMaintenanceRuntime } from "./maintenanceSettingsRuntime";

export const SETTINGS_CATEGORIES = [
  { key: "appearance", label: "外观显示", icon: "🎨" },
  { key: "network", label: "网络连接", icon: "🌐" },
  { key: "exchanges", label: "交易所", icon: "🏦" },
  { key: "data", label: "数据管理", icon: "💾" },
  { key: "database", label: "数据库工具", icon: "🗄️" },
  { key: "about", label: "关于", icon: "ℹ️" },
];

export function useSettingsRuntime({
  isOpen,
  settings,
  onUpdate,
  currentSymbol = "",
  currentMarketType = "spot",
  currentExchange = "binance",
  watchlists = [],
}) {
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

  useEffect(() => {
    if (isOpen) markPerf("lazy.settings.ready");
  }, [isOpen]);

  const handleToggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, []);

  return {
    view: {
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
    },
    actions: {
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
      maintenance: {
        onStorageRepair: maintenanceRuntime.handleStorageRepair,
        onGapScan: maintenanceRuntime.handleGapScan,
        onExchangeRefresh: maintenanceRuntime.handleExchangeRefresh,
      },
    },
    status: {},
  };
}