import { useCallback, useEffect, useState } from 'react';
import {
    refreshExchangeInfo,
    repairStoredCustomIntervals,
    scanAndFillGaps,
} from '../../services/api';
import { parseSymbolKey } from '../../utils/symbolKey';

export function useSettingsMaintenanceRuntime({
    isOpen,
    currentSymbol,
    currentMarketType,
    currentExchange,
    watchlists,
}) {
    const [storageRepairLoading, setStorageRepairLoading] = useState(false);
    const [storageRepairResult, setStorageRepairResult] = useState(null);
    const [gapScanLoading, setGapScanLoading] = useState(false);
    const [gapScanResult, setGapScanResult] = useState(null);
    const [maintenanceScope, setMaintenanceScope] = useState(null);
    const [exchangeRefreshLoading, setExchangeRefreshLoading] = useState(false);
    const [exchangeRefreshResult, setExchangeRefreshResult] = useState(null);

    useEffect(() => {
        if (!isOpen) return;
        setStorageRepairResult(null);
        setGapScanResult(null);
        setMaintenanceScope(null);
    }, [isOpen]);

    const getCurrentScopeSymbols = useCallback(() => {
        const symbol = String(currentSymbol || '').toUpperCase().trim();
        return symbol ? [symbol] : [];
    }, [currentSymbol]);

    const getWatchlistScopeSymbols = useCallback(() => {
        const collected = new Set(getCurrentScopeSymbols());
        for (const watchlist of watchlists || []) {
            for (const item of watchlist.symbols || []) {
                const { symbol, marketType, exchange } = parseSymbolKey(item);
                if ((marketType || 'spot') !== currentMarketType) continue;
                if ((exchange || 'binance') !== currentExchange) continue;
                const normalized = String(symbol || '').toUpperCase().trim();
                if (normalized) collected.add(normalized);
            }
        }
        return [...collected];
    }, [currentExchange, currentMarketType, getCurrentScopeSymbols, watchlists]);

    const handleStorageRepair = useCallback(async (scope) => {
        const symbols = scope === 'watchlist' ? getWatchlistScopeSymbols() : getCurrentScopeSymbols();
        setStorageRepairLoading(true);
        setStorageRepairResult(null);
        setMaintenanceScope(scope);
        try {
            const res = await repairStoredCustomIntervals({
                marketType: currentMarketType,
                exchange: currentExchange,
                symbols,
            });
            setStorageRepairResult(res);
        } catch (err) {
            setStorageRepairResult({
                status: 'error',
                message: `修复失败: ${err.message}`,
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

    const handleGapScan = useCallback(async (scope) => {
        const symbols = scope === 'watchlist' ? getWatchlistScopeSymbols() : getCurrentScopeSymbols();
        setGapScanLoading(true);
        setGapScanResult(null);
        setMaintenanceScope(scope);
        try {
            const res = await scanAndFillGaps({
                marketType: currentMarketType,
                exchange: currentExchange,
                symbols,
            });
            setGapScanResult(res);
        } catch (err) {
            setGapScanResult({
                status: 'error',
                message: `扫描失败: ${err.message}`,
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
            const res = await refreshExchangeInfo(currentExchange);
            const refreshedCount = typeof res.count === 'number'
                ? res.count
                : Object.values(res.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
            setExchangeRefreshResult({
                status: 'ok',
                message: `已更新 ${currentExchange} 的 ${refreshedCount} 个交易对`,
                count: refreshedCount,
            });
        } catch (err) {
            setExchangeRefreshResult({
                status: 'error',
                message: `更新失败: ${err.message}`,
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
