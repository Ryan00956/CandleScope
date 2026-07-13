import type { ReactNode } from "react";
import type {
    MaintenanceResult,
    MaintenanceScope,
} from "../../features/settings/maintenanceSettingsRuntime.js";

function getRepairResultClassName(status: string | undefined): string {
    if (status === 'ok') return 'st-result-ok';
    if (status === 'partial' || status === 'warning') return 'st-result-warn';
    return 'st-result-fail';
}

function getRepairStatusLabel(status: string | undefined): string {
    if (status === 'repaired') return '已修复';
    if (status === 'failed') return '失败';
    return '通过';
}

function renderRepairDetails(result: MaintenanceResult): ReactNode {
    if (!Array.isArray(result.results) || result.results.length === 0) return null;
    return (
        <div className="st-series-list">
            {result.results.slice(0, 6).map((item) => (
                <div key={`${item.symbol}-${item.interval}`} className="st-series-item">
                    <div className="st-series-line">
                        <span className="st-series-name">{item.symbol} · {item.interval}</span>
                        <span className={`st-series-badge st-badge-${item.status === 'repaired' ? 'ok' : item.status === 'failed' ? 'fail' : 'info'}`}>
                            {getRepairStatusLabel(item.status)}
                        </span>
                    </div>
                    <div className="st-series-msg">{item.message}</div>
                </div>
            ))}
            {result.results.length > 6 && (
                <div className="st-series-more">
                    其余 {result.results.length - 6} 项结果已省略
                </div>
            )}
        </div>
    );
}

function renderGapScanDetails(result: MaintenanceResult): ReactNode {
    if (!Array.isArray(result.results) || result.results.length === 0) return null;
    return (
        <div className="st-series-list">
            {result.results.map((item) => (
                <div key={item.interval} className="st-series-item">
                    <div className="st-series-line">
                        <span className="st-series-name">
                            {item.interval}
                            {item.total_bars && <span className="st-series-meta"> · {item.total_bars}</span>}
                            {item.latest_data && <span className="st-series-meta"> · {item.latest_data}</span>}
                        </span>
                        <span className={`st-series-badge st-badge-${item.status === 'filled' ? 'ok' : item.status === 'ok' ? 'info' : 'fail'}`}>
                            {item.status === 'ok' ? '✓' : item.status === 'filled' ? `+${item.bars_filled}` : '!'}
                        </span>
                    </div>
                    <div className="st-series-msg">{item.message}</div>
                </div>
            ))}
        </div>
    );
}

function exchangeLabel(exchange: string | null | undefined): string {
    return String(exchange || '').charAt(0).toUpperCase() + String(exchange || '').slice(1);
}

export interface StorageMaintenancePanelProps {
    currentSymbol: string;
    currentMarketType: string;
    currentExchange: string;
    currentScopeSymbols: string[];
    watchlistScopeSymbols: string[];
    storageRepairLoading: boolean;
    storageRepairResult: MaintenanceResult | null;
    gapScanLoading: boolean;
    gapScanResult: MaintenanceResult | null;
    maintenanceScope: MaintenanceScope | null;
    exchangeRefreshLoading: boolean;
    exchangeRefreshResult: MaintenanceResult | null;
    onStorageRepair(scope: MaintenanceScope): void;
    onGapScan(scope: MaintenanceScope): void;
    onExchangeRefresh(): void;
}

export default function StorageMaintenancePanel({
    currentSymbol,
    currentMarketType,
    currentExchange,
    currentScopeSymbols,
    watchlistScopeSymbols,
    storageRepairLoading,
    storageRepairResult,
    gapScanLoading,
    gapScanResult,
    maintenanceScope,
    exchangeRefreshLoading,
    exchangeRefreshResult,
    onStorageRepair,
    onGapScan,
    onExchangeRefresh,
}: StorageMaintenancePanelProps) {
    const scopeLabel = maintenanceScope === 'watchlist' ? '自选 + 当前' : '当前图表';

    return (
        <div className="st-group">
            <div className="st-group-title">库检查与修正</div>
            <div className="st-group-desc">数据库维护工具，用于修复异常数据和补齐缺口</div>

            <div className="st-tool-card">
                <div className="st-tool-header">
                    <span className="st-tool-icon">🔧</span>
                    <div>
                        <div className="st-tool-name">自定义周期落库修复</div>
                        <div className="st-tool-desc">
                            检查数据库里已存在的自定义周期 K 线，并按基础周期的 authoritative 聚合逻辑重建错误数据。原生周期不会被改动。
                        </div>
                    </div>
                </div>
                <div className="st-actions-row">
                    <button
                        className="st-btn st-btn-warn"
                        onClick={() => onStorageRepair('current')}
                        disabled={storageRepairLoading || currentScopeSymbols.length === 0}
                        style={{ flex: 1 }}
                    >
                        {storageRepairLoading && maintenanceScope === 'current'
                            ? '⏳ 检查中...'
                            : `当前图表 (${currentSymbol || '-'})`}
                    </button>
                    <button
                        className="st-btn st-btn-secondary"
                        onClick={() => onStorageRepair('watchlist')}
                        disabled={storageRepairLoading || watchlistScopeSymbols.length === 0}
                        style={{ flex: 1 }}
                    >
                        {storageRepairLoading && maintenanceScope === 'watchlist'
                            ? '⏳ 检查中...'
                            : `自选 + 当前 (${watchlistScopeSymbols.length})`}
                    </button>
                </div>
            </div>

            {storageRepairResult && (
                <div className={`st-result ${getRepairResultClassName(storageRepairResult.status)}`}>
                    <div className="st-result-head">{storageRepairResult.message}</div>
                    <div className="st-result-detail">
                        范围: {scopeLabel} · 交易所: {exchangeLabel(storageRepairResult.exchange || currentExchange)} · 市场: {storageRepairResult.market_type || currentMarketType}
                        {Array.isArray(storageRepairResult.symbols_filter) && storageRepairResult.symbols_filter.length > 0
                            ? ` · 品种 ${storageRepairResult.symbols_filter.length}`
                            : ''}
                    </div>
                    <div className="st-result-stats">
                        <span>检查 {storageRepairResult.checked_series || 0}</span>
                        <span>修复 {storageRepairResult.repaired_series || 0}</span>
                        <span>通过 {storageRepairResult.unchanged_series || 0}</span>
                        <span>失败 {storageRepairResult.failed_series || 0}</span>
                        <span>删库 {storageRepairResult.total_deleted_rows || 0}</span>
                        <span>回写 {storageRepairResult.total_written_rows || 0}</span>
                    </div>
                    {renderRepairDetails(storageRepairResult)}
                </div>
            )}

            <div className="st-tool-card" style={{ marginTop: 12 }}>
                <div className="st-tool-header">
                    <span className="st-tool-icon">🔍</span>
                    <div>
                        <div className="st-tool-name">数据缺口扫描与修复</div>
                        <div className="st-tool-desc">
                            扫描所有标准时间周期（1m ~ 1w）的数据库，检测尾部缺口和内部缺口，并从 {exchangeLabel(currentExchange)} REST API 自动补齐。
                        </div>
                    </div>
                </div>
                <div className="st-actions-row">
                    <button
                        className="st-btn st-btn-accent"
                        onClick={() => onGapScan('current')}
                        disabled={gapScanLoading || storageRepairLoading || currentScopeSymbols.length === 0}
                        style={{ flex: 1 }}
                    >
                        {gapScanLoading && maintenanceScope === 'current'
                            ? '⏳ 扫描中...'
                            : `当前图表 (${currentSymbol || '-'})`}
                    </button>
                    <button
                        className="st-btn st-btn-secondary"
                        onClick={() => onGapScan('watchlist')}
                        disabled={gapScanLoading || storageRepairLoading || watchlistScopeSymbols.length === 0}
                        style={{ flex: 1 }}
                    >
                        {gapScanLoading && maintenanceScope === 'watchlist'
                            ? '⏳ 扫描中...'
                            : `自选 + 当前 (${watchlistScopeSymbols.length})`}
                    </button>
                </div>
            </div>

            {gapScanResult && (
                <div className={`st-result ${getRepairResultClassName(gapScanResult.status)}`}>
                    <div className="st-result-head">{gapScanResult.message}</div>
                    <div className="st-result-detail">
                        范围: {scopeLabel} · 交易所: {exchangeLabel(gapScanResult.exchange || currentExchange)} · 市场: {gapScanResult.market_type || currentMarketType}
                        {Array.isArray(gapScanResult.symbols_filter) && gapScanResult.symbols_filter.length > 0
                            ? ` · 品种 ${gapScanResult.symbols_filter.length}`
                            : ''}
                    </div>
                    <div className="st-result-stats">
                        <span>发现缺口 {gapScanResult.gaps_found || 0}</span>
                        <span>已修复 {gapScanResult.gaps_filled || 0}</span>
                        <span>补回 {gapScanResult.total_bars_filled || 0} 条</span>
                        <span>耗时 {((gapScanResult.elapsed_ms || 0) / 1000).toFixed(1)}s</span>
                    </div>
                    {renderGapScanDetails(gapScanResult)}
                </div>
            )}

            <div className="st-tool-card" style={{ marginTop: 12 }}>
                <div className="st-tool-header">
                    <span className="st-tool-icon">🔄</span>
                    <div>
                        <div className="st-tool-name">更新交易对列表</div>
                        <div className="st-tool-desc">
                            从币安重新拉取现货交易对列表。交易对列表会在软件启动时自动加载，通常无需手动更新。
                        </div>
                    </div>
                </div>
                <button
                    className="st-btn st-btn-accent"
                    onClick={onExchangeRefresh}
                    disabled={exchangeRefreshLoading}
                    style={{ width: '100%' }}
                >
                    {exchangeRefreshLoading ? '⏳ 拉取中...' : '🔄 更新交易对'}
                </button>
            </div>

            {exchangeRefreshResult && (
                <div className={`st-result ${getRepairResultClassName(exchangeRefreshResult.status)}`}>
                    <div className="st-result-head">{exchangeRefreshResult.message}</div>
                </div>
            )}
        </div>
    );
}
