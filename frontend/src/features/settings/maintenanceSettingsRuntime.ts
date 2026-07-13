import { useCallback, useEffect, useState } from "react";
import {
  refreshExchangeInfo,
  repairStoredCustomIntervals,
  scanAndFillGaps,
} from "../../services/api";
import { parseSymbolKey } from "../../utils/symbolKey";
import type { WatchlistGroup } from "../watchlist/watchlistTypes.js";

export type MaintenanceScope = "current" | "watchlist";
export type MaintenanceResult = Record<string, unknown>;

export interface SettingsMaintenanceRuntime {
  currentScopeSymbols: string[];
  watchlistScopeSymbols: string[];
  storageRepairLoading: boolean;
  storageRepairResult: MaintenanceResult | null;
  gapScanLoading: boolean;
  gapScanResult: MaintenanceResult | null;
  maintenanceScope: MaintenanceScope | null;
  exchangeRefreshLoading: boolean;
  exchangeRefreshResult: MaintenanceResult | null;
  handleStorageRepair(scope: MaintenanceScope): Promise<void>;
  handleGapScan(scope: MaintenanceScope): Promise<void>;
  handleExchangeRefresh(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function useSettingsMaintenanceRuntime({
  isOpen,
  currentSymbol,
  currentMarketType,
  currentExchange,
  watchlists,
}: {
  isOpen: boolean;
  currentSymbol: string;
  currentMarketType: string;
  currentExchange: string;
  watchlists: WatchlistGroup[] | null | undefined;
}): SettingsMaintenanceRuntime {
  const [storageRepairLoading, setStorageRepairLoading] = useState(false);
  const [storageRepairResult, setStorageRepairResult] = useState<MaintenanceResult | null>(null);
  const [gapScanLoading, setGapScanLoading] = useState(false);
  const [gapScanResult, setGapScanResult] = useState<MaintenanceResult | null>(null);
  const [maintenanceScope, setMaintenanceScope] = useState<MaintenanceScope | null>(null);
  const [exchangeRefreshLoading, setExchangeRefreshLoading] = useState(false);
  const [exchangeRefreshResult, setExchangeRefreshResult] = useState<MaintenanceResult | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStorageRepairResult(null);
    setGapScanResult(null);
    setMaintenanceScope(null);
  }, [isOpen]);

  const getCurrentScopeSymbols = useCallback(() => {
    const symbol = String(currentSymbol || "").toUpperCase().trim();
    return symbol ? [symbol] : [];
  }, [currentSymbol]);

  const getWatchlistScopeSymbols = useCallback(() => {
    const collected = new Set(getCurrentScopeSymbols());
    for (const watchlist of watchlists || []) {
      for (const item of watchlist.symbols || []) {
        const { symbol, marketType, exchange } = parseSymbolKey(item);
        if ((marketType || "spot") !== currentMarketType) continue;
        if ((exchange || "binance") !== currentExchange) continue;
        const normalized = String(symbol || "").toUpperCase().trim();
        if (normalized) collected.add(normalized);
      }
    }
    return [...collected];
  }, [currentExchange, currentMarketType, getCurrentScopeSymbols, watchlists]);

  const handleStorageRepair = useCallback(async (scope: MaintenanceScope): Promise<void> => {
    const symbols = scope === "watchlist" ? getWatchlistScopeSymbols() : getCurrentScopeSymbols();
    setStorageRepairLoading(true);
    setStorageRepairResult(null);
    setMaintenanceScope(scope);
    try {
      const res = await repairStoredCustomIntervals({
        marketType: currentMarketType,
        exchange: currentExchange,
        symbols,
      });
      setStorageRepairResult(isRecord(res) ? res : {});
    } catch (err: unknown) {
      setStorageRepairResult({
        status: "error",
        message: `修复失败: ${errorMessage(err)}`,
        exchange: currentExchange,
        market_type: currentMarketType,
        symbols_filter: symbols,
        checked_series: 0,
        repaired_series: 0,
        unchanged_series: 0,
        failed_series: 1,
        total_deleted_rows: 0,
        total_written_rows: 0,
        total_stale_rows_removed: 0,
        results: [],
      });
    } finally {
      setStorageRepairLoading(false);
    }
  }, [currentExchange, currentMarketType, getCurrentScopeSymbols, getWatchlistScopeSymbols]);

  const handleGapScan = useCallback(async (scope: MaintenanceScope): Promise<void> => {
    const symbols = scope === "watchlist" ? getWatchlistScopeSymbols() : getCurrentScopeSymbols();
    setGapScanLoading(true);
    setGapScanResult(null);
    setMaintenanceScope(scope);
    try {
      const res = await scanAndFillGaps({
        marketType: currentMarketType,
        exchange: currentExchange,
        symbols,
      });
      setGapScanResult(isRecord(res) ? res : {});
    } catch (err: unknown) {
      setGapScanResult({
        status: "error",
        message: `扫描失败: ${errorMessage(err)}`,
        exchange: currentExchange,
        market_type: currentMarketType,
        symbols_filter: symbols,
        gaps_found: 0,
        gaps_filled: 0,
        total_bars_filled: 0,
        results: [],
      });
    } finally {
      setGapScanLoading(false);
    }
  }, [currentExchange, currentMarketType, getCurrentScopeSymbols, getWatchlistScopeSymbols]);

  const handleExchangeRefresh = useCallback(async () => {
    setExchangeRefreshLoading(true);
    setExchangeRefreshResult(null);
    try {
      const raw = await refreshExchangeInfo(currentExchange);
      const res = isRecord(raw) ? raw : {};
      const counts = isRecord(res.counts) ? res.counts : {};
      const refreshedCount = typeof res.count === "number"
        ? res.count
        : Object.values(counts).reduce<number>((sum, value) => sum + Number(value || 0), 0);
      setExchangeRefreshResult({
        status: "ok",
        message: `已更新 ${currentExchange} 的 ${refreshedCount} 个交易对`,
        count: refreshedCount,
      });
    } catch (err: unknown) {
      setExchangeRefreshResult({
        status: "error",
        message: `更新失败: ${errorMessage(err)}`,
      });
    } finally {
      setExchangeRefreshLoading(false);
    }
  }, [currentExchange]);

  return {
    currentScopeSymbols: getCurrentScopeSymbols(),
    watchlistScopeSymbols: getWatchlistScopeSymbols(),
    storageRepairLoading,
    storageRepairResult,
    gapScanLoading,
    gapScanResult,
    maintenanceScope,
    exchangeRefreshLoading,
    exchangeRefreshResult,
    handleStorageRepair,
    handleGapScan,
    handleExchangeRefresh,
  };
}
