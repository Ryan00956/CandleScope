import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    deleteDatabaseSeries,
    deleteDatabaseSymbol,
    fetchDatabaseSeries,
    requestDatabaseBackfill,
    scanDatabaseSeriesGaps,
} from '../../features/settings/databaseSettingsRuntime';
import { parseSymbolKey } from '../../utils/symbolKey';
import type { ReactNode } from 'react';
import type {
    DatabaseSeries,
    DatabaseSeriesListResult,
    DatabaseSeriesStatus,
} from '../../features/settings/databaseSettingsRuntime.js';
import type { WatchlistGroup } from '../../features/watchlist/watchlistTypes.js';

interface DatabaseSeriesGroup {
    exchange: string;
    marketType: string;
    symbol: string;
    intervals: DatabaseSeries[];
    status: DatabaseSeriesStatus;
    totalCount: number;
    gapCount: number;
    earliestOpenMs: number;
    latestOpenMs: number;
}

interface OperationResult {
    status: string;
    message: string;
    detail?: string;
}

type BackfillTargetMode = 'now' | 'custom';

interface BackfillDialogState {
    series: DatabaseSeries;
    targetMode: BackfillTargetMode;
    targetValue: string;
}

type DeleteDialogState =
    | { type: 'series'; series: DatabaseSeries; confirmText: string }
    | { type: 'symbol'; group: DatabaseSeriesGroup; confirmText: string };

const ALL_VALUE = 'all';
const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(value: unknown, fallback = ''): string {
    return String(value || fallback).toLowerCase().trim();
}

function displayMarketType(value: unknown): string {
    const marketType = normalize(value, 'spot');
    if (marketType === 'futures') return '合约';
    if (marketType === 'swap') return '永续';
    return '现货';
}

function formatExchange(value: unknown): string {
    const exchange = normalize(value, 'binance');
    return exchange ? exchange.charAt(0).toUpperCase() + exchange.slice(1) : '--';
}

function formatDateTime(ms: number): string {
    if (!ms) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(ms));
}

function formatDateTimePrecise(ms: number): string {
    if (!ms) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(ms));
}

function toDateTimeLocalValue(ms: number): string {
    if (!ms) return '';
    const date = new Date(ms);
    const offsetMs = date.getTimezoneOffset() * 60 * 1000;
    return new Date(ms - offsetMs).toISOString().slice(0, 16);
}

function parseDateTimeLocalMs(value: string): number {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDuration(startMs: number, endMs: number): string {
    if (!startMs || !endMs || endMs < startMs) return '--';
    const days = (endMs - startMs) / DAY_MS;
    if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时`;
    if (days < 365) return `${Math.round(days)} 天`;
    return `${(days / 365).toFixed(1)} 年`;
}

function formatBytes(bytes: number): string {
    if (!bytes) return '--';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseIntervalMs(interval: string): number {
    const match = String(interval || '').match(/^(\d+)([mhdwM])$/);
    if (!match) return 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2];
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * DAY_MS;
    if (unit === 'w') return value * 7 * DAY_MS;
    return value * 30 * DAY_MS;
}

function intervalSortValue(interval: string): number {
    return parseIntervalMs(interval);
}

function getSeriesId(series: DatabaseSeries): string {
    return `${series.exchange}:${series.marketType}:${series.symbol}:${series.interval}`;
}

function getSymbolId(group: DatabaseSeriesGroup): string {
    return `${group.exchange}:${group.marketType}:${group.symbol}`;
}

function statusLabel(status: DatabaseSeriesStatus): string {
    if (status === 'gap') return '有缺口';
    if (status === 'stale') return '待更新';
    return '完整';
}

function statusBadgeClass(status: DatabaseSeriesStatus): string {
    if (status === 'gap') return 'st-badge-fail';
    if (status === 'stale') return 'st-badge-info';
    return 'st-badge-ok';
}

function resultClass(status: string): string {
    if (status === 'ok' || status === 'started' || status === 'already_complete') return 'st-result-ok';
    if (status === 'warning') return 'st-result-warn';
    return 'st-result-fail';
}

function makeOperationKey(action: string, series: DatabaseSeries): string {
    return `${action}:${getSeriesId(series)}`;
}

function getGroupStatus(intervals: DatabaseSeries[]): DatabaseSeriesStatus {
    if (intervals.some(item => item.status === 'gap')) return 'gap';
    if (intervals.some(item => item.status === 'stale')) return 'stale';
    return 'healthy';
}

function buildGroups(series: DatabaseSeries[]): DatabaseSeriesGroup[] {
    const groupMap = new Map<string, Omit<DatabaseSeriesGroup, 'status' | 'totalCount' | 'gapCount' | 'earliestOpenMs' | 'latestOpenMs'>>();
    for (const item of series) {
        const key = `${item.exchange}:${item.marketType}:${item.symbol}`;
        const existing = groupMap.get(key) || {
            exchange: item.exchange,
            marketType: item.marketType,
            symbol: item.symbol,
            intervals: [],
        };
        existing.intervals.push(item);
        groupMap.set(key, existing);
    }
    return [...groupMap.values()].map(group => {
        const intervals = [...group.intervals].sort((left, right) => intervalSortValue(left.interval) - intervalSortValue(right.interval));
        const earliestOpenMs = Math.min(...intervals.map(item => item.earliestOpenMs || Number.MAX_SAFE_INTEGER));
        const latestOpenMs = Math.max(...intervals.map(item => item.latestOpenMs || 0));
        return {
            ...group,
            intervals,
            status: getGroupStatus(intervals),
            totalCount: intervals.reduce((total, item) => total + Number(item.totalCount || 0), 0),
            gapCount: intervals.reduce((total, item) => total + Number(item.gapCount || 0), 0),
            earliestOpenMs: earliestOpenMs === Number.MAX_SAFE_INTEGER ? 0 : earliestOpenMs,
            latestOpenMs,
        };
    }).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export interface DatabaseManagementPanelProps {
    currentExchange?: string;
    currentMarketType?: string;
    currentSymbol?: string;
    watchlists?: WatchlistGroup[];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function backfillTargetMode(value: string): BackfillTargetMode {
    return value === 'custom' ? 'custom' : 'now';
}

export default function DatabaseManagementPanel({
    currentExchange = 'binance',
    currentMarketType = 'spot',
    currentSymbol = '',
    watchlists = [],
}: DatabaseManagementPanelProps) {
    const [payload, setPayload] = useState<DatabaseSeriesListResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [exchangeFilter, setExchangeFilter] = useState(normalize(currentExchange, 'binance'));
    const [marketFilter, setMarketFilter] = useState(normalize(currentMarketType, 'spot'));
    const [symbolQuery, setSymbolQuery] = useState('');
    const [intervalFilter, setIntervalFilter] = useState(ALL_VALUE);
    const [statusFilter, setStatusFilter] = useState(ALL_VALUE);
    const [scopeFilter, setScopeFilter] = useState(ALL_VALUE);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [operationLoadingKey, setOperationLoadingKey] = useState('');
    const [operationResult, setOperationResult] = useState<OperationResult | null>(null);
    const [backfillDialog, setBackfillDialog] = useState<BackfillDialogState | null>(null);
    const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);

    const loadSeries = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const nextPayload = await fetchDatabaseSeries();
            setPayload(nextPayload);
        } catch (err: unknown) {
            setError(`数据库库存加载失败: ${errorMessage(err)}`);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let disposed = false;
        setLoading(true);
        fetchDatabaseSeries()
            .then(nextPayload => {
                if (!disposed) {
                    setPayload(nextPayload);
                    setError('');
                }
            })
            .catch((err: unknown) => {
                if (!disposed) setError(`数据库库存加载失败: ${errorMessage(err)}`);
            })
            .finally(() => {
                if (!disposed) setLoading(false);
            });
        return () => {
            disposed = true;
        };
    }, []);

    const allSeries = useMemo(() => payload?.series || [], [payload?.series]);

    const exchangeOptions = useMemo(() => (
        [...new Set(allSeries.map(item => item.exchange))].sort()
    ), [allSeries]);

    const marketOptions = useMemo(() => (
        [...new Set(allSeries.map(item => item.marketType))].sort()
    ), [allSeries]);

    const intervalOptions = useMemo(() => (
        [...new Set(allSeries.map(item => item.interval))].sort((left, right) => intervalSortValue(left) - intervalSortValue(right))
    ), [allSeries]);

    const watchlistSymbolIds = useMemo(() => {
        const ids = new Set<string>();
        for (const watchlist of watchlists || []) {
            for (const item of watchlist.symbols || []) {
                const parsed = parseSymbolKey(item);
                ids.add(`${normalize(parsed.exchange, 'binance')}:${normalize(parsed.marketType, 'spot')}:${String(parsed.symbol || '').toUpperCase()}`);
            }
        }
        const current = String(currentSymbol || '').toUpperCase().trim();
        if (current) {
            ids.add(`${normalize(currentExchange, 'binance')}:${normalize(currentMarketType, 'spot')}:${current}`);
        }
        return ids;
    }, [currentExchange, currentMarketType, currentSymbol, watchlists]);

    const filteredSeries = useMemo(() => {
        const query = String(symbolQuery || '').toUpperCase().trim();
        return allSeries.filter(item => {
            if (exchangeFilter !== ALL_VALUE && item.exchange !== exchangeFilter) return false;
            if (marketFilter !== ALL_VALUE && item.marketType !== marketFilter) return false;
            if (intervalFilter !== ALL_VALUE && item.interval !== intervalFilter) return false;
            if (statusFilter !== ALL_VALUE && item.status !== statusFilter) return false;
            if (query && !item.symbol.includes(query)) return false;
            if (scopeFilter === 'current') {
                const current = String(currentSymbol || '').toUpperCase().trim();
                return current && item.symbol === current
                    && item.exchange === normalize(currentExchange, 'binance')
                    && item.marketType === normalize(currentMarketType, 'spot');
            }
            if (scopeFilter === 'watchlist') {
                return watchlistSymbolIds.has(`${item.exchange}:${item.marketType}:${item.symbol}`);
            }
            return true;
        });
    }, [allSeries, currentExchange, currentMarketType, currentSymbol, exchangeFilter, intervalFilter, marketFilter, scopeFilter, statusFilter, symbolQuery, watchlistSymbolIds]);

    const groups = useMemo(() => buildGroups(filteredSeries), [filteredSeries]);

    const stats = useMemo(() => {
        const symbols = new Set(filteredSeries.map(item => `${item.exchange}:${item.marketType}:${item.symbol}`));
        const totalBars = filteredSeries.reduce((total, item) => total + Number(item.totalCount || 0), 0);
        const gapSeries = filteredSeries.filter(item => item.status === 'gap').length;
        const earliest = filteredSeries.reduce((value, item) => Math.min(value, item.earliestOpenMs || Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
        const latest = filteredSeries.reduce((value, item) => Math.max(value, item.latestOpenMs || 0), 0);
        return {
            symbolCount: symbols.size,
            seriesCount: filteredSeries.length,
            totalBars,
            gapSeries,
            storageSizeBytes: totalBars * 200,
            earliestOpenMs: earliest === Number.MAX_SAFE_INTEGER ? 0 : earliest,
            latestOpenMs: latest,
        };
    }, [filteredSeries]);

    const resetFilters = useCallback(() => {
        setExchangeFilter(ALL_VALUE);
        setMarketFilter(ALL_VALUE);
        setSymbolQuery('');
        setIntervalFilter(ALL_VALUE);
        setStatusFilter(ALL_VALUE);
        setScopeFilter(ALL_VALUE);
    }, []);

    const showCurrentOnly = useCallback(() => {
        setScopeFilter('current');
        setExchangeFilter(normalize(currentExchange, 'binance'));
        setMarketFilter(normalize(currentMarketType, 'spot'));
        setSymbolQuery(String(currentSymbol || '').toUpperCase().trim());
    }, [currentExchange, currentMarketType, currentSymbol]);

    const showWatchlistOnly = useCallback(() => {
        setScopeFilter('watchlist');
        setExchangeFilter(ALL_VALUE);
        setMarketFilter(ALL_VALUE);
        setSymbolQuery('');
    }, []);

    const toggleGroup = useCallback((groupId: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    }, []);

    const removeSeriesFromView = useCallback((series: DatabaseSeries) => {
        setPayload(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                series: prev.series.filter(item => getSeriesId(item) !== getSeriesId(series)),
            };
        });
    }, []);

    const removeSymbolFromView = useCallback((group: DatabaseSeriesGroup) => {
        setPayload(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                series: prev.series.filter(item => `${item.exchange}:${item.marketType}:${item.symbol}` !== getSymbolId(group)),
            };
        });
    }, []);

    const handleScanGaps = useCallback(async (series: DatabaseSeries) => {
        const operationKey = makeOperationKey('scan', series);
        setOperationLoadingKey(operationKey);
        setOperationResult(null);
        try {
            const result = await scanDatabaseSeriesGaps(series);
            setOperationResult({
                status: result.status,
                message: `${series.symbol} ${series.interval}: ${result.message}`,
                detail: `缺口 ${result.gapCount || 0} 处 · 缺失 ${result.missingBars || 0} 根`,
            });
        } catch (err: unknown) {
            setOperationResult({ status: 'error', message: `扫描失败: ${errorMessage(err)}` });
        } finally {
            setOperationLoadingKey('');
        }
    }, []);

    const openBackfillDialog = useCallback((series: DatabaseSeries) => {
        const targetMs = Date.now();
        setBackfillDialog({
            series,
            targetMode: 'now',
            targetValue: toDateTimeLocalValue(targetMs),
        });
    }, []);

    const updateBackfillDialog = useCallback((patch: Partial<BackfillDialogState>) => {
        setBackfillDialog(prev => (prev ? { ...prev, ...patch } : prev));
    }, []);

    const submitBackfill = useCallback(async () => {
        if (!backfillDialog) return;
        const { series, targetValue } = backfillDialog;
        const targetEndMs = parseDateTimeLocalMs(targetValue);
        const estimatedBars = Math.max(0, Math.ceil((targetEndMs - series.latestOpenMs) / parseIntervalMs(series.interval)));
        const operationKey = makeOperationKey('backfill', series);
        setOperationLoadingKey(operationKey);
        setOperationResult(null);
        try {
            const result = await requestDatabaseBackfill({
                seriesKey: { ...series, estimatedBars },
                targetEndMs,
            });
            setOperationResult({
                status: result.status,
                message: `${series.symbol} ${series.interval}: ${result.message}`,
                detail: `目标 ${formatDateTimePrecise(targetEndMs)} · 预计 ${estimatedBars.toLocaleString()} 根`,
            });
            setBackfillDialog(null);
        } catch (err: unknown) {
            setOperationResult({ status: 'error', message: `补全失败: ${errorMessage(err)}` });
        } finally {
            setOperationLoadingKey('');
        }
    }, [backfillDialog]);

    const openDeleteSeriesDialog = useCallback((series: DatabaseSeries) => {
        setDeleteDialog({ type: 'series', series, confirmText: '' });
    }, []);

    const openDeleteSymbolDialog = useCallback((group: DatabaseSeriesGroup) => {
        setDeleteDialog({ type: 'symbol', group, confirmText: '' });
    }, []);

    const updateDeleteConfirmText = useCallback((value: string) => {
        setDeleteDialog(prev => (prev ? { ...prev, confirmText: value } : prev));
    }, []);

    const submitDelete = useCallback(async () => {
        if (!deleteDialog) return;
        if (deleteDialog.type === 'series') {
            const { series } = deleteDialog;
            const operationKey = makeOperationKey('delete', series);
            setOperationLoadingKey(operationKey);
            setOperationResult(null);
            try {
                const result = await deleteDatabaseSeries(series);
                removeSeriesFromView(series);
                setOperationResult({
                    status: result.status,
                    message: `${series.symbol} ${series.interval}: ${result.message}`,
                    detail: `模拟删除 ${Number(result.deletedBars || 0).toLocaleString()} 根 K 线`,
                });
                setDeleteDialog(null);
            } catch (err: unknown) {
                setOperationResult({ status: 'error', message: `删除失败: ${errorMessage(err)}` });
            } finally {
                setOperationLoadingKey('');
            }
            return;
        }
        const { group } = deleteDialog;
        const operationKey = `delete-symbol:${getSymbolId(group)}`;
        setOperationLoadingKey(operationKey);
        setOperationResult(null);
        try {
            const result = await deleteDatabaseSymbol({ symbol: group.symbol, intervals: group.intervals });
            removeSymbolFromView(group);
            setOperationResult({
                status: result.status,
                message: `${group.symbol}: ${result.message}`,
                detail: `模拟删除 ${result.deletedSeries} 个周期 · ${Number(result.deletedBars || 0).toLocaleString()} 根 K 线`,
            });
            setDeleteDialog(null);
        } catch (err: unknown) {
            setOperationResult({ status: 'error', message: `删除失败: ${errorMessage(err)}` });
        } finally {
            setOperationLoadingKey('');
        }
    }, [deleteDialog, removeSeriesFromView, removeSymbolFromView]);

    const renderSeriesRow = (series: DatabaseSeries): ReactNode => {
        const operationScanKey = makeOperationKey('scan', series);
        const operationBackfillKey = makeOperationKey('backfill', series);
        const operationDeleteKey = makeOperationKey('delete', series);
        return (
            <div key={getSeriesId(series)} className="st-db-series-row">
                <div className="st-db-series-main">
                    <span className="st-db-interval">{series.interval}</span>
                    <span className={`st-series-badge ${statusBadgeClass(series.status)}`}>{statusLabel(series.status)}</span>
                </div>
                <div className="st-db-series-stat">
                    <span>根数</span>
                    <strong>{Number(series.totalCount || 0).toLocaleString()}</strong>
                </div>
                <div className="st-db-series-stat st-db-wide">
                    <span>覆盖</span>
                    <strong>{formatDateTime(series.earliestOpenMs)} - {formatDateTime(series.latestOpenMs)}</strong>
                </div>
                <div className="st-db-series-stat">
                    <span>时长</span>
                    <strong>{formatDuration(series.earliestOpenMs, series.latestOpenMs)}</strong>
                </div>
                <div className="st-db-series-stat">
                    <span>缺口</span>
                    <strong>{series.gapCount ? `${series.gapCount} 处 / ${series.missingBars} 根` : '无'}</strong>
                </div>
                <div className="st-db-row-actions">
                    <button
                        className="st-btn st-btn-secondary st-db-mini-btn"
                        onClick={() => handleScanGaps(series)}
                        disabled={operationLoadingKey === operationScanKey}
                    >
                        {operationLoadingKey === operationScanKey ? '扫描中' : '扫描'}
                    </button>
                    <button
                        className="st-btn st-btn-accent st-db-mini-btn"
                        onClick={() => openBackfillDialog(series)}
                        disabled={operationLoadingKey === operationBackfillKey}
                    >
                        {operationLoadingKey === operationBackfillKey ? '补全中' : '补全'}
                    </button>
                    <button
                        className="st-btn st-btn-warn st-db-mini-btn"
                        onClick={() => openDeleteSeriesDialog(series)}
                        disabled={operationLoadingKey === operationDeleteKey}
                    >
                        删除
                    </button>
                </div>
            </div>
        );
    };

    const backfillTargetMs = backfillDialog ? parseDateTimeLocalMs(backfillDialog.targetValue) : 0;
    const backfillEstimate = backfillDialog
        ? Math.max(0, Math.ceil((backfillTargetMs - backfillDialog.series.latestOpenMs) / parseIntervalMs(backfillDialog.series.interval)))
        : 0;
    const deleteConfirmSymbol = deleteDialog?.type === 'symbol' ? deleteDialog.group.symbol : '';
    const deleteReady = deleteDialog?.type === 'series'
        || (deleteDialog?.type === 'symbol' && deleteDialog.confirmText.trim().toUpperCase() === deleteConfirmSymbol);

    return (
        <>
            <div className="st-group">
                <div className="st-group-title">
                    <span>数据库库存</span>
                    <span className="st-badge st-badge-db">实验</span>
                    {payload?.mode === 'mock' && <span className="st-badge st-badge-memory">Mock</span>}
                </div>
                <div className="st-group-desc">
                    查看当前落库的商品与周期覆盖情况。补全与删除入口先使用模拟结果，等待数据库管理 API 接入后切换到真实操作。
                </div>

                <div className="st-db-summary-grid">
                    <div className="st-db-summary-card">
                        <span>商品</span>
                        <strong>{stats.symbolCount}</strong>
                    </div>
                    <div className="st-db-summary-card">
                        <span>序列</span>
                        <strong>{stats.seriesCount}</strong>
                    </div>
                    <div className="st-db-summary-card">
                        <span>K 线</span>
                        <strong>{stats.totalBars.toLocaleString()}</strong>
                    </div>
                    <div className="st-db-summary-card">
                        <span>占用估算</span>
                        <strong>{formatBytes(payload?.storageSizeBytes || stats.storageSizeBytes)}</strong>
                    </div>
                    <div className="st-db-summary-card st-db-summary-wide">
                        <span>覆盖范围</span>
                        <strong>{formatDateTime(stats.earliestOpenMs)} - {formatDateTime(stats.latestOpenMs)}</strong>
                    </div>
                    <div className="st-db-summary-card">
                        <span>疑似缺口</span>
                        <strong>{stats.gapSeries}</strong>
                    </div>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title-row">
                    <div className="st-group-title" style={{ marginBottom: 0 }}>筛选与范围</div>
                    <button className="st-advanced-toggle" onClick={resetFilters}>重置</button>
                </div>
                <div className="st-db-filter-grid">
                    <label className="st-db-field">
                        <span>交易所</span>
                        <select className="st-select" value={exchangeFilter} onChange={event => setExchangeFilter(event.target.value)}>
                            <option value={ALL_VALUE}>全部交易所</option>
                            {exchangeOptions.map(exchange => <option key={exchange} value={exchange}>{formatExchange(exchange)}</option>)}
                        </select>
                    </label>
                    <label className="st-db-field">
                        <span>市场</span>
                        <select className="st-select" value={marketFilter} onChange={event => setMarketFilter(event.target.value)}>
                            <option value={ALL_VALUE}>全部市场</option>
                            {marketOptions.map(marketType => <option key={marketType} value={marketType}>{displayMarketType(marketType)}</option>)}
                        </select>
                    </label>
                    <label className="st-db-field">
                        <span>商品</span>
                        <input
                            className="st-input"
                            value={symbolQuery}
                            onChange={event => setSymbolQuery(event.target.value)}
                            placeholder="BTCUSDT"
                        />
                    </label>
                    <label className="st-db-field">
                        <span>周期</span>
                        <select className="st-select" value={intervalFilter} onChange={event => setIntervalFilter(event.target.value)}>
                            <option value={ALL_VALUE}>全部周期</option>
                            {intervalOptions.map(interval => <option key={interval} value={interval}>{interval}</option>)}
                        </select>
                    </label>
                    <label className="st-db-field">
                        <span>状态</span>
                        <select className="st-select" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                            <option value={ALL_VALUE}>全部状态</option>
                            <option value="healthy">完整</option>
                            <option value="gap">有缺口</option>
                            <option value="stale">待更新</option>
                        </select>
                    </label>
                </div>
                <div className="st-actions-row st-db-scope-actions">
                    <button className="st-btn st-btn-secondary" onClick={showCurrentOnly} disabled={!currentSymbol}>只看当前图表</button>
                    <button className="st-btn st-btn-secondary" onClick={showWatchlistOnly} disabled={watchlistSymbolIds.size === 0}>只看自选 + 当前</button>
                    <button className="st-btn st-btn-accent" onClick={loadSeries} disabled={loading}>{loading ? '刷新中...' : '刷新库存'}</button>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">商品与周期</div>
                <div className="st-group-desc">
                    每行以交易所、市场、商品、周期四元组识别，避免现货与合约同名数据混淆。
                </div>

                {error && (
                    <div className="st-result st-result-fail">
                        <div className="st-result-head">加载失败</div>
                        <div className="st-result-detail">{error}</div>
                    </div>
                )}

                {operationResult && (
                    <div className={`st-result ${resultClass(operationResult.status)}`}>
                        <div className="st-result-head">{operationResult.message}</div>
                        {operationResult.detail && <div className="st-result-detail">{operationResult.detail}</div>}
                    </div>
                )}

                <div className="st-db-list">
                    {loading && <div className="st-db-empty">正在加载数据库库存...</div>}
                    {!loading && !error && groups.length === 0 && (
                        <div className="st-db-empty">当前筛选下没有落库序列</div>
                    )}
                    {!loading && groups.map(group => {
                        const groupId = getSymbolId(group);
                        const expanded = expandedIds.has(groupId);
                        const deleteSymbolKey = `delete-symbol:${groupId}`;
                        return (
                            <div key={groupId} className="st-db-symbol-card">
                                <button className="st-db-symbol-head" onClick={() => toggleGroup(groupId)}>
                                    <span className="st-db-expand">{expanded ? '▾' : '▸'}</span>
                                    <span className="st-db-symbol-name">{group.symbol}</span>
                                    <span className="st-db-chip">{formatExchange(group.exchange)}</span>
                                    <span className="st-db-chip">{displayMarketType(group.marketType)}</span>
                                    <span className={`st-series-badge ${statusBadgeClass(group.status)}`}>{statusLabel(group.status)}</span>
                                    <span className="st-db-symbol-meta">{group.intervals.length} 周期 · {group.totalCount.toLocaleString()} 根</span>
                                </button>
                                {expanded && (
                                    <div className="st-db-symbol-body">
                                        <div className="st-db-symbol-toolbar">
                                            <span>覆盖 {formatDuration(group.earliestOpenMs, group.latestOpenMs)}</span>
                                            <span>最新 {formatDateTime(group.latestOpenMs)}</span>
                                            <button
                                                className="st-btn st-btn-warn st-db-mini-btn"
                                                onClick={() => openDeleteSymbolDialog(group)}
                                                disabled={operationLoadingKey === deleteSymbolKey}
                                            >
                                                删除商品
                                            </button>
                                        </div>
                                        {group.intervals.map(renderSeriesRow)}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {backfillDialog && (
                <div className="st-db-dialog-backdrop" onClick={() => setBackfillDialog(null)}>
                    <div className="st-db-dialog" onClick={event => event.stopPropagation()}>
                        <div className="st-db-dialog-title">补全到指定位置</div>
                        <div className="st-db-dialog-subtitle">
                            {backfillDialog.series.symbol} · {backfillDialog.series.interval} · {formatExchange(backfillDialog.series.exchange)} · {displayMarketType(backfillDialog.series.marketType)}
                        </div>
                        <div className="st-db-dialog-grid">
                            <div className="st-db-dialog-row">
                                <span>当前最新</span>
                                <strong>{formatDateTimePrecise(backfillDialog.series.latestOpenMs)}</strong>
                            </div>
                            <label className="st-db-field">
                                <span>目标位置</span>
                                <select
                                    className="st-select"
                                    value={backfillDialog.targetMode}
                                    onChange={event => {
                                        const mode = backfillTargetMode(event.target.value);
                                        const targetMs = mode === 'now' ? Date.now() : backfillTargetMs || Date.now();
                                        updateBackfillDialog({ targetMode: mode, targetValue: toDateTimeLocalValue(targetMs) });
                                    }}
                                >
                                    <option value="now">补到当前时间</option>
                                    <option value="custom">补到指定日期时间</option>
                                </select>
                            </label>
                            <label className="st-db-field">
                                <span>日期时间</span>
                                <input
                                    className="st-input"
                                    type="datetime-local"
                                    value={backfillDialog.targetValue}
                                    onChange={event => updateBackfillDialog({ targetMode: 'custom', targetValue: event.target.value })}
                                />
                            </label>
                            <div className="st-db-dialog-row">
                                <span>预计补全</span>
                                <strong>{backfillEstimate.toLocaleString()} 根</strong>
                            </div>
                        </div>
                        <div className="st-info-box st-info-warn">
                            当前为前端模拟任务，不会写入数据库。真实后端接入后才会发起补全。
                        </div>
                        <div className="st-actions-row">
                            <button className="st-btn st-btn-secondary" onClick={() => setBackfillDialog(null)}>取消</button>
                            <button className="st-btn st-btn-accent" onClick={submitBackfill} disabled={operationLoadingKey.startsWith('backfill:')}>
                                {operationLoadingKey.startsWith('backfill:') ? '提交中...' : '确认补全'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {deleteDialog && (
                <div className="st-db-dialog-backdrop" onClick={() => setDeleteDialog(null)}>
                    <div className="st-db-dialog" onClick={event => event.stopPropagation()}>
                        <div className="st-db-dialog-title">确认删除实验数据</div>
                        <div className="st-db-dialog-subtitle">
                            {deleteDialog.type === 'series'
                                ? `${deleteDialog.series.symbol} · ${deleteDialog.series.interval} · ${formatExchange(deleteDialog.series.exchange)} · ${displayMarketType(deleteDialog.series.marketType)}`
                                : `${deleteDialog.group.symbol} · ${formatExchange(deleteDialog.group.exchange)} · ${displayMarketType(deleteDialog.group.marketType)} · ${deleteDialog.group.intervals.length} 个周期`}
                        </div>
                        <div className="st-info-box st-info-warn">
                            当前只会从 mock 页面中移除数据，不会删除真实数据库。真实删除上线前应接入备份或恢复策略。
                        </div>
                        {deleteDialog.type === 'symbol' && (
                            <label className="st-db-field st-db-confirm-field">
                                <span>输入商品名确认</span>
                                <input
                                    className="st-input"
                                    value={deleteDialog.confirmText}
                                    onChange={event => updateDeleteConfirmText(event.target.value)}
                                    placeholder={deleteDialog.group.symbol}
                                />
                            </label>
                        )}
                        <div className="st-actions-row">
                            <button className="st-btn st-btn-secondary" onClick={() => setDeleteDialog(null)}>取消</button>
                            <button className="st-btn st-btn-warn" onClick={submitDelete} disabled={!deleteReady || operationLoadingKey.startsWith('delete')}>
                                {operationLoadingKey.startsWith('delete') ? '删除中...' : '确认删除'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
