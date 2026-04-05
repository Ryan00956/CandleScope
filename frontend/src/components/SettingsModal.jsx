import React, { useState, useEffect, useCallback } from 'react';
import {
    fetchProxySettings,
    updateProxySettings,
    testProxyConnection,
    repairStoredCustomIntervals,
    scanAndFillGaps,
    refreshExchangeInfo,
} from '../services/api';
import { parseSymbolKey } from '../utils/symbolKey';

// ── Category definitions ────────────────────────────────────────
const CATEGORIES = [
    { key: 'appearance', label: '外观显示', icon: '🎨' },
    { key: 'network',    label: '网络连接', icon: '🌐' },
    { key: 'data',       label: '数据管理', icon: '💾' },
    { key: 'about',      label: '关于',     icon: 'ℹ️' },
];

// ── Interval parsing utility ────────────────────────────────────
const _UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };
const _INTERVAL_RE = /^(\d+)([smhdwM])$/;

function parseIntervalToSeconds(interval) {
    const m = _INTERVAL_RE.exec(interval);
    if (!m) return null;
    const num = parseInt(m[1], 10);
    const unit = m[2];
    if (num <= 0 || !_UNIT_SECONDS[unit]) return null;
    return num * _UNIT_SECONDS[unit];
}

function getTierForInterval(interval) {
    const secs = parseIntervalToSeconds(interval);
    if (secs === null) return 'minutes';
    if (secs < 60)    return 'seconds';
    if (secs < 3600)  return 'minutes';
    if (secs < 86400) return 'hours';
    return 'daily';
}

// ── Ephemeral cache (memory-only, e.g. 1s) ──────────────────────
const EPHEMERAL_CACHE_OPTIONS = [
    { value: 3600,   label: '1 小时',  desc: '3,600 根' },
    { value: 14400,  label: '4 小时',  desc: '14,400 根' },
    { value: 43200,  label: '12 小时', desc: '43,200 根' },
    { value: 86400,  label: '24 小时', desc: '86,400 根' },
];
const DEFAULT_EPHEMERAL_BARS = 86400;

// ── DB storage tiers (minutes, hours, daily+) ───────────────────
const DB_TIERS = [
    {
        key: 'minutes', label: '分钟级',
        desc: '1 分钟 – 59 分钟  (1m, 5m, 15m, 45m …)',
        representativeSec: 60,
    },
    {
        key: 'hours', label: '小时级',
        desc: '1 小时 – 23 小时  (1h, 2h, 4h, 12h …)',
        representativeSec: 3600,
    },
    {
        key: 'daily', label: '天级+',
        desc: '≥ 1 天  (1d, 3d, 1w, 1M …)',
        representativeSec: 86400,
    },
];

// DB presets: only control minutes/hours (daily is always unlimited)
const DB_PRESETS = [
    {
        key: 'compact', label: '紧凑', icon: '🟢',
        desc: '节省磁盘，保留较少历史',
        limits: { minutes: 50000, hours: 20000, daily: 0 },
    },
    {
        key: 'standard', label: '标准', icon: '🔵',
        desc: '推荐设置，平衡存储与可用性',
        limits: { minutes: 200000, hours: 50000, daily: 0 },
    },
    {
        key: 'generous', label: '宽裕', icon: '🟡',
        desc: '保留更多历史，占用更多磁盘',
        limits: { minutes: 500000, hours: 100000, daily: 0 },
    },
    {
        key: 'unlimited', label: '无限制', icon: '⚪',
        desc: '不自动清理，数据库持续增长',
        limits: { minutes: 0, hours: 0, daily: 0 },
    },
];

const DEFAULT_DB_LIMITS = DB_PRESETS.find(p => p.key === 'standard').limits;

// Helper: estimate how long N bars covers for a tier
function barsToHumanTime(bars, representativeSec) {
    if (bars === 0) return '不清理';
    const totalSec = bars * representativeSec;
    if (totalSec < 3600)        return `≈ ${Math.round(totalSec / 60)} 分钟`;
    if (totalSec < 86400)       return `≈ ${(totalSec / 3600).toFixed(1)} 小时`;
    if (totalSec < 86400 * 365) return `≈ ${Math.round(totalSec / 86400)} 天`;
    return `≈ ${(totalSec / (86400 * 365)).toFixed(0)} 年+`;
}

function barsToStorageSize(bars) {
    if (bars === 0) return '--';
    const bytes = bars * 200;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function barsToMemorySize(bars) {
    if (bars === 0) return '--';
    const bytes = bars * 200;
    if (bytes < 1024 * 1024) return `≈ ${(bytes / 1024).toFixed(0)} KB`;
    return `≈ ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SettingsModal({
    isOpen,
    onClose,
    settings,
    onUpdate,
    currentSymbol = '',
    currentMarketType = 'spot',
    currentExchange = 'binance',
    watchlists = [],
}) {
    const [activeCategory, setActiveCategory] = useState('appearance');

    // ── Proxy state ─────────────────────────────────────────
    const [proxyMode, setProxyMode] = useState('system');
    const [customProxy, setCustomProxy] = useState('');
    const [systemProxy, setSystemProxy] = useState('');
    const [effectiveProxy, setEffectiveProxy] = useState('');
    const [proxyLoading, setProxyLoading] = useState(false);
    const [proxyTestResult, setProxyTestResult] = useState(null);
    const [proxySaveMsg, setProxySaveMsg] = useState(null);

    // ── Storage repair state ────────────────────────────────
    const [storageRepairLoading, setStorageRepairLoading] = useState(false);
    const [storageRepairResult, setStorageRepairResult] = useState(null);
    const [gapScanLoading, setGapScanLoading] = useState(false);
    const [gapScanResult, setGapScanResult] = useState(null);
    const [maintenanceScope, setMaintenanceScope] = useState(null);

    // Load proxy settings when modal opens
    useEffect(() => {
        if (!isOpen) return;
        setProxyTestResult(null);
        setProxySaveMsg(null);
        setStorageRepairResult(null);
        setGapScanResult(null);
        setMaintenanceScope(null);
        fetchProxySettings()
            .then((data) => {
                setProxyMode(data.mode || 'system');
                setCustomProxy(data.custom_proxy || '');
                setSystemProxy(data.system_proxy || '');
                setEffectiveProxy(data.effective_proxy || '');
            })
            .catch(() => { /* ignore — backend may not be up */ });
    }, [isOpen]);

    const handleProxySave = useCallback(async () => {
        setProxyLoading(true);
        setProxySaveMsg(null);
        try {
            const res = await updateProxySettings({ mode: proxyMode, custom_proxy: customProxy });
            setEffectiveProxy(res.effective_proxy || '');
            setProxySaveMsg({ ok: true, text: '代理设置已保存 ✓' });
        } catch (err) {
            setProxySaveMsg({ ok: false, text: `保存失败: ${err.message}` });
        } finally {
            setProxyLoading(false);
        }
    }, [proxyMode, customProxy]);

    const handleProxyTest = useCallback(async () => {
        setProxyLoading(true);
        setProxyTestResult(null);
        try {
            const res = await testProxyConnection({ mode: proxyMode, custom_proxy: customProxy });
            setProxyTestResult(res);
        } catch (err) {
            setProxyTestResult({ success: false, message: `请求失败: ${err.message}` });
        } finally {
            setProxyLoading(false);
        }
    }, [proxyMode, customProxy]);

    const getCurrentScopeSymbols = useCallback(() => {
        const symbol = String(currentSymbol || '').toUpperCase().trim();
        return symbol ? [symbol] : [];
    }, [currentSymbol]);

    const getWatchlistScopeSymbols = useCallback(() => {
        const collected = new Set(getCurrentScopeSymbols());
        for (const wl of watchlists || []) {
            for (const item of wl.symbols || []) {
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
                checked_series: 0, repaired_series: 0,
                unchanged_series: 0, failed_series: 1,
                total_deleted_rows: 0, total_written_rows: 0,
                total_stale_rows_removed: 0, results: [],
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
                gaps_found: 0, gaps_filled: 0,
                total_bars_filled: 0, results: [],
            });
        } finally {
            setGapScanLoading(false);
        }
    }, [currentExchange, currentMarketType, getCurrentScopeSymbols, getWatchlistScopeSymbols]);

    // ── Exchange info refresh ──
    const [exchangeRefreshLoading, setExchangeRefreshLoading] = useState(false);
    const [exchangeRefreshResult, setExchangeRefreshResult] = useState(null);

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

    // ── Data management state (must be above early return for hook ordering) ──
    const [showAdvanced, setShowAdvanced] = useState(false);

    if (!isOpen) return null;

    const handleUpdate = (key, value) => {
        onUpdate({ ...settings, [key]: value });
    };

    const getRepairResultClassName = (status) => {
        if (status === 'ok') return 'st-result-ok';
        if (status === 'partial' || status === 'warning') return 'st-result-warn';
        return 'st-result-fail';
    };

    const getRepairStatusLabel = (status) => {
        if (status === 'repaired') return '已修复';
        if (status === 'failed') return '失败';
        return '通过';
    };

    const currentScopeSymbols = getCurrentScopeSymbols();
    const watchlistScopeSymbols = getWatchlistScopeSymbols();
    const scopeLabel = maintenanceScope === 'watchlist' ? '自选 + 当前' : '当前图表';

    // ── Render category panels ──────────────────────────────

    const renderAppearance = () => (
        <>
            {/* Theme */}
            <div className="st-group">
                <div className="st-group-title">视觉主题</div>
                <div className="st-group-desc">选择界面的整体视觉风格</div>
                <div className="st-theme-grid">
                    {[
                        { value: 'dark',   icon: '🌙', label: '深色' },
                        { value: 'light',  icon: '☀️', label: '亮色' },
                        { value: 'custom', icon: '🎨', label: '自定义' },
                    ].map(t => (
                        <button
                            key={t.value}
                            className={`st-theme-card ${settings.theme === t.value ? 'active' : ''}`}
                            onClick={() => handleUpdate('theme', t.value)}
                        >
                            <span className="st-theme-icon">{t.icon}</span>
                            <span className="st-theme-label">{t.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Custom bg */}
            {settings.theme === 'custom' && (
                <div className="st-group">
                    <div className="st-group-title">自定义背景色</div>
                    <div className="st-color-row">
                        <input
                            type="color"
                            value={settings.customBg}
                            onChange={(e) => handleUpdate('customBg', e.target.value)}
                        />
                        <code className="st-color-code">{settings.customBg}</code>
                    </div>
                </div>
            )}

            {/* Candle colors */}
            <div className="st-group">
                <div className="st-group-title">涨跌颜色方案</div>
                <div className="st-group-desc">设置 K 线涨跌配色，也可以自定义</div>
                <div className="st-preset-row">
                    <button
                        className="st-preset-btn"
                        onClick={() => onUpdate({ ...settings, upColor: '#22c55e', downColor: '#ef4444' })}
                    >
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>● 绿涨</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>● 红跌</span>
                    </button>
                    <button
                        className="st-preset-btn"
                        onClick={() => onUpdate({ ...settings, upColor: '#ef4444', downColor: '#22c55e' })}
                    >
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>● 红涨</span>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>● 绿跌</span>
                    </button>
                </div>
                <div className="st-custom-colors">
                    <div className="st-color-item">
                        <span>上涨颜色</span>
                        <div className="st-color-row">
                            <input
                                type="color"
                                value={settings.upColor}
                                onChange={(e) => handleUpdate('upColor', e.target.value)}
                            />
                            <code className="st-color-code">{settings.upColor}</code>
                        </div>
                    </div>
                    <div className="st-color-item">
                        <span>下跌颜色</span>
                        <div className="st-color-row">
                            <input
                                type="color"
                                value={settings.downColor}
                                onChange={(e) => handleUpdate('downColor', e.target.value)}
                            />
                            <code className="st-color-code">{settings.downColor}</code>
                        </div>
                    </div>
                </div>
            </div>

            {/* Timezone */}
            <div className="st-group">
                <div className="st-group-title">显示时区</div>
                <div className="st-group-desc">图表坐标轴及十字线时间标签使用的时区</div>
                <select
                    className="st-select"
                    value={settings.timezone || 'Local'}
                    onChange={(e) => handleUpdate('timezone', e.target.value)}
                >
                    <option value="Local">本地时间 (Browser Default)</option>
                    <optgroup label="常用地区 (Common)">
                        <option value="UTC">UTC (世界协调时间)</option>
                        <option value="America/New_York">纽约 (New York - EST/EDT)</option>
                        <option value="Europe/London">伦敦 (London - GMT/BST)</option>
                        <option value="Asia/Shanghai">北京/上海 (Shanghai - CST)</option>
                        <option value="Asia/Tokyo">东京 (Tokyo - JST)</option>
                        <option value="Asia/Singapore">新加坡 (Singapore)</option>
                        <option value="Asia/Hong_Kong">香港 (Hong Kong)</option>
                    </optgroup>
                    <optgroup label="所有时区 (All Timezones)">
                        {Intl.supportedValuesOf('timeZone').map(tz => (
                            <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
                        ))}
                    </optgroup>
                </select>
            </div>
        </>
    );

    const renderNetwork = () => (
        <>
            <div className="st-group">
                <div className="st-group-title">代理模式</div>
                <div className="st-group-desc">选择访问交易所 API 的网络代理方式</div>
                <div className="st-theme-grid">
                    {[
                        { value: 'system', icon: '🖥️', label: '系统代理' },
                        { value: 'custom', icon: '⚙️', label: '自定义' },
                        { value: 'none',   icon: '🚫', label: '不使用' },
                    ].map(m => (
                        <button
                            key={m.value}
                            className={`st-theme-card ${proxyMode === m.value ? 'active' : ''}`}
                            onClick={() => { setProxyMode(m.value); setProxyTestResult(null); setProxySaveMsg(null); }}
                        >
                            <span className="st-theme-icon">{m.icon}</span>
                            <span className="st-theme-label">{m.label}</span>
                        </button>
                    ))}
                </div>

                {proxyMode === 'system' && systemProxy && (
                    <div className="st-info-box">
                        <span className="st-info-label">检测到系统代理:</span>
                        <code className="st-info-value">{systemProxy}</code>
                    </div>
                )}
                {proxyMode === 'system' && !systemProxy && (
                    <div className="st-info-box st-info-warn">
                        <span>未检测到系统代理环境变量，将直连</span>
                    </div>
                )}

                {proxyMode === 'custom' && (
                    <div style={{ marginTop: 12 }}>
                        <input
                            type="text"
                            className="st-input"
                            placeholder="http://127.0.0.1:7890 或 socks5://..."
                            value={customProxy}
                            onChange={(e) => { setCustomProxy(e.target.value); setProxySaveMsg(null); }}
                        />
                    </div>
                )}

                {effectiveProxy && proxyMode !== 'none' && (
                    <div className="st-info-box">
                        <span className="st-info-label">当前生效:</span>
                        <code className="st-info-value">{effectiveProxy}</code>
                    </div>
                )}

                <div className="st-actions-row">
                    <button
                        className="st-btn st-btn-secondary"
                        onClick={handleProxyTest}
                        disabled={proxyLoading}
                    >
                        {proxyLoading ? '⏳ 测试中...' : '🔍 测试连接'}
                    </button>
                    <button
                        className="st-btn st-btn-primary"
                        onClick={handleProxySave}
                        disabled={proxyLoading}
                    >
                        {proxyLoading ? '⏳ ...' : '💾 保存代理'}
                    </button>
                </div>

                {proxyTestResult && (
                    <div className={`st-result ${proxyTestResult.success ? 'st-result-ok' : proxyTestResult.partial ? 'st-result-warn' : 'st-result-fail'}`}>
                        <span>{proxyTestResult.success ? '✅' : proxyTestResult.partial ? '⚠️' : '❌'} {proxyTestResult.message}</span>
                        {proxyTestResult.proxy_used && (
                            <div className="st-result-detail">代理: {proxyTestResult.proxy_used}</div>
                        )}
                        {Array.isArray(proxyTestResult.results) && proxyTestResult.results.length > 0 && (
                            <div className="st-exchange-results">
                                {proxyTestResult.results.map((r) => (
                                    <div key={r.exchange} className={`st-exchange-result-item ${r.success ? 'ok' : 'fail'}`}>
                                        <span className="st-exchange-result-icon">{r.success ? '✅' : '❌'}</span>
                                        <span className="st-exchange-result-label">{r.label}</span>
                                        <span className="st-exchange-result-msg">{r.message}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {proxySaveMsg && (
                    <div className={`st-result ${proxySaveMsg.ok ? 'st-result-ok' : 'st-result-fail'}`}>
                        <span>{proxySaveMsg.text}</span>
                    </div>
                )}
            </div>
        </>
    );

    const currentPreset = settings.cachePreset || 'standard';
    const currentLimits = settings.cacheLimits || { ...DEFAULT_DB_LIMITS };
    const currentEphemeralBars = settings.ephemeralCacheBars ?? DEFAULT_EPHEMERAL_BARS;
    const isCustomPreset = currentPreset === 'custom';

    const handlePresetChange = (presetKey) => {
        const preset = DB_PRESETS.find(p => p.key === presetKey);
        if (preset) {
            onUpdate({
                ...settings,
                cachePreset: presetKey,
                cacheLimits: { ...preset.limits },
            });
        }
    };

    const handleLimitChange = (tierKey, value) => {
        const newLimits = { ...currentLimits, [tierKey]: value };
        const matchingPreset = DB_PRESETS.find(p =>
            Object.keys(p.limits).every(k => p.limits[k] === newLimits[k])
        );
        onUpdate({
            ...settings,
            cachePreset: matchingPreset ? matchingPreset.key : 'custom',
            cacheLimits: newLimits,
        });
    };

    const handleEphemeralChange = (value) => {
        onUpdate({
            ...settings,
            ephemeralCacheBars: value,
        });
    };

    const renderData = () => (
        <>
            {/* ── Section 1: Ephemeral Cache (memory-only) ── */}
            <div className="st-group">
                <div className="st-group-title">
                    <span>实时缓存</span>
                    <span className="st-badge st-badge-memory">仅内存</span>
                </div>
                <div className="st-group-desc">
                    秒级 K 线（如 1s）仅存在于内存缓存中，<strong>不写入数据库</strong>。
                    进程退出后自动丢弃，下次启动重新从交易所接收。
                </div>

                <div className="st-ephemeral-cards">
                    {EPHEMERAL_CACHE_OPTIONS.map(opt => (
                        <button
                            key={opt.value}
                            className={`st-ephemeral-card ${currentEphemeralBars === opt.value ? 'active' : ''}`}
                            onClick={() => handleEphemeralChange(opt.value)}
                        >
                            <span className="st-ephemeral-label">{opt.label}</span>
                            <span className="st-ephemeral-desc">{opt.desc}</span>
                        </button>
                    ))}
                </div>

                <div className="st-ephemeral-summary">
                    <span className="st-ephemeral-stat">
                        📊 缓存容量: <strong>{currentEphemeralBars.toLocaleString()}</strong> 根
                    </span>
                    <span className="st-ephemeral-stat">
                        ⏱ 约覆盖: <strong>{barsToHumanTime(currentEphemeralBars, 1).replace('≈ ', '')}</strong>
                    </span>
                    <span className="st-ephemeral-stat">
                        💾 内存占用: <strong>{barsToMemorySize(currentEphemeralBars)}</strong> / 交易对
                    </span>
                </div>
            </div>

            {/* ── Section 2: DB Storage Strategy ── */}
            <div className="st-group">
                <div className="st-group-title">
                    <span>数据库存储策略</span>
                    <span className="st-badge st-badge-db">持久化</span>
                </div>
                <div className="st-group-desc">
                    分钟级及以上的 K 线数据持久化到数据库。选择预设方案或展开高级选项自定义每个级别的保留上限。
                </div>

                <div className="st-preset-cards">
                    {DB_PRESETS.map(preset => (
                        <button
                            key={preset.key}
                            className={`st-preset-card ${currentPreset === preset.key ? 'active' : ''}`}
                            onClick={() => handlePresetChange(preset.key)}
                        >
                            <span className="st-preset-icon">{preset.icon}</span>
                            <span className="st-preset-name">{preset.label}</span>
                            <span className="st-preset-desc">{preset.desc}</span>
                        </button>
                    ))}
                </div>

                {isCustomPreset && (
                    <div className="st-info-box" style={{ marginTop: 12 }}>
                        <span>🔧 当前使用自定义配置，不匹配任何预设</span>
                    </div>
                )}
            </div>

            {/* DB tier details + advanced toggle */}
            <div className="st-group">
                <div className="st-group-title-row">
                    <div className="st-group-title" style={{ marginBottom: 0 }}>各级别保留详情</div>
                    <button
                        className={`st-advanced-toggle ${showAdvanced ? 'active' : ''}`}
                        onClick={() => setShowAdvanced(prev => !prev)}
                    >
                        {showAdvanced ? '收起高级 ▴' : '高级 ▾'}
                    </button>
                </div>
                <div className="st-group-desc">
                    每个数据系列（交易对 × 周期）独立计算。级别按 K 线持续时间自动判定，<strong>自定义周期</strong>（如 7m、45m、2h）也按此规则归入对应级别。
                </div>

                <div className="st-tier-table">
                    <div className="st-tier-header">
                        <span className="st-tier-col-name">级别</span>
                        <span className="st-tier-col-limit">最大根数</span>
                        <span className="st-tier-col-time">≈ 对应时长</span>
                        <span className="st-tier-col-size">≈ 磁盘占用 / 系列</span>
                    </div>
                    {DB_TIERS.map(tier => {
                        const limit = currentLimits[tier.key] ?? 0;
                        return (
                            <div key={tier.key} className="st-tier-row">
                                <div className="st-tier-col-name">
                                    <span className="st-tier-label">{tier.label}</span>
                                    <span className="st-tier-desc">{tier.desc}</span>
                                </div>
                                <div className="st-tier-col-limit">
                                    {showAdvanced && tier.key !== 'daily' ? (
                                        <input
                                            type="number"
                                            className="st-tier-input"
                                            value={limit}
                                            min={0}
                                            step={1000}
                                            onChange={(e) => handleLimitChange(tier.key, Math.max(0, parseInt(e.target.value) || 0))}
                                            title="0 = 不清理"
                                        />
                                    ) : (
                                        <span className={`st-tier-value ${limit === 0 ? 'unlimited' : ''}`}>
                                            {limit === 0 ? '∞' : limit.toLocaleString()}
                                        </span>
                                    )}
                                </div>
                                <span className="st-tier-col-time">
                                    {barsToHumanTime(limit, tier.representativeSec)}
                                </span>
                                <span className="st-tier-col-size">
                                    {barsToStorageSize(limit)}
                                </span>
                            </div>
                        );
                    })}
                </div>

                {showAdvanced && (
                    <div className="st-advanced-hint">
                        <span>💡 输入 <strong>0</strong> 表示不限制（不清理该级别数据）。天级+数据量极小，始终保留。修改后如不匹配预设则切换为「自定义」。</span>
                    </div>
                )}
            </div>

            {/* Storage repair */}
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
                            onClick={() => handleStorageRepair('current')}
                            disabled={storageRepairLoading || currentScopeSymbols.length === 0}
                            style={{ flex: 1 }}
                        >
                            {storageRepairLoading && maintenanceScope === 'current'
                                ? '⏳ 检查中...'
                                : `当前图表 (${currentSymbol || '-'})`}
                        </button>
                        <button
                            className="st-btn st-btn-secondary"
                            onClick={() => handleStorageRepair('watchlist')}
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
                            范围: {scopeLabel} · 交易所: {(storageRepairResult.exchange || currentExchange).charAt(0).toUpperCase() + (storageRepairResult.exchange || currentExchange).slice(1)} · 市场: {storageRepairResult.market_type || currentMarketType}
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
                                扫描所有标准时间周期（1m ~ 1w）的数据库，检测尾部缺口和内部缺口，并从 {currentExchange.charAt(0).toUpperCase() + currentExchange.slice(1)} REST API 自动补齐。
                            </div>
                        </div>
                    </div>
                    <div className="st-actions-row">
                        <button
                            className="st-btn st-btn-accent"
                            onClick={() => handleGapScan('current')}
                            disabled={gapScanLoading || storageRepairLoading || currentScopeSymbols.length === 0}
                            style={{ flex: 1 }}
                        >
                            {gapScanLoading && maintenanceScope === 'current'
                                ? '⏳ 扫描中...'
                                : `当前图表 (${currentSymbol || '-'})`}
                        </button>
                        <button
                            className="st-btn st-btn-secondary"
                            onClick={() => handleGapScan('watchlist')}
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
                            范围: {scopeLabel} · 交易所: {(gapScanResult.exchange || currentExchange).charAt(0).toUpperCase() + (gapScanResult.exchange || currentExchange).slice(1)} · 市场: {gapScanResult.market_type || currentMarketType}
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
                        onClick={handleExchangeRefresh}
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
        </>
    );

    const renderAbout = () => (
        <>
            <div className="st-group">
                <div className="st-about-header">
                    <div className="st-about-logo">📈</div>
                    <div className="st-about-name">CandleScope</div>
                    <div className="st-about-version">v0.2.0</div>
                    <div className="st-about-tagline">开源 K 线看盘・实时行情</div>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">技术栈</div>
                <div className="st-about-stack">
                    <div className="st-stack-item">
                        <span className="st-stack-label">前端</span>
                        <span className="st-stack-value">React + Lightweight Charts</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">后端</span>
                        <span className="st-stack-value">FastAPI + SQLite (WAL)</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">数据源</span>
                        <span className="st-stack-value">Binance REST + WebSocket</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">实时更新</span>
                        <span className="st-stack-value">WebSocket 双向通信</span>
                    </div>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">快捷键</div>
                <div className="st-about-stack">
                    <div className="st-stack-item">
                        <span className="st-stack-label">⚙️</span>
                        <span className="st-stack-value">设置面板</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">📊</span>
                        <span className="st-stack-value">指标面板</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">✎</span>
                        <span className="st-stack-value">管理自定义周期</span>
                    </div>
                </div>
            </div>
        </>
    );

    // ── Detail renderers (repair / gap scan results) ────────
    const renderRepairDetails = (result) => {
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
    };

    const renderGapScanDetails = (result) => {
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
    };

    // ── Active panel ─────────────────────────────────────────
    const renderPanel = () => {
        switch (activeCategory) {
            case 'appearance': return renderAppearance();
            case 'network':    return renderNetwork();
            case 'data':       return renderData();
            case 'about':      return renderAbout();
            default:           return renderAppearance();
        }
    };

    const activeCatObj = CATEGORIES.find(c => c.key === activeCategory) || CATEGORIES[0];

    return (
        <div className="st-overlay" onClick={onClose}>
            <div className="st-panel" onClick={e => e.stopPropagation()}>
                {/* Sidebar */}
                <nav className="st-sidebar">
                    <div className="st-sidebar-title">设置</div>
                    <div className="st-sidebar-nav">
                        {CATEGORIES.map(cat => (
                            <button
                                key={cat.key}
                                className={`st-nav-item ${activeCategory === cat.key ? 'active' : ''}`}
                                onClick={() => setActiveCategory(cat.key)}
                            >
                                <span className="st-nav-icon">{cat.icon}</span>
                                <span className="st-nav-label">{cat.label}</span>
                            </button>
                        ))}
                    </div>
                    <div className="st-sidebar-footer">
                        <button className="st-btn st-btn-primary st-btn-close" onClick={onClose}>
                            保存并关闭
                        </button>
                    </div>
                </nav>

                {/* Content */}
                <main className="st-content">
                    <div className="st-content-header">
                        <h2 className="st-content-title">
                            <span>{activeCatObj.icon}</span> {activeCatObj.label}
                        </h2>
                        <button className="st-close-x" onClick={onClose}>✕</button>
                    </div>
                    <div className="st-content-body">
                        {renderPanel()}
                    </div>
                </main>
            </div>

            <style>{`
/* ═══════════════════════════════════════════════════════════
   Settings Panel — Full-page sidebar + content layout
   Inspired by VS Code / Discord settings
   ═══════════════════════════════════════════════════════════ */

.st-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(6px);
  animation: st-fade-in 0.18s ease-out;
}

@keyframes st-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes st-slide-up {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.st-panel {
  display: flex;
  width: min(960px, 92vw);
  height: min(680px, 88vh);
  background: var(--bg-secondary, #1e293b);
  border: 1px solid var(--border-color, #334155);
  border-radius: 16px;
  overflow: hidden;
  box-shadow:
    0 24px 48px rgba(0, 0, 0, 0.45),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset;
  animation: st-slide-up 0.22s ease-out;
}

/* ── Sidebar ────────────────────────────────────────────── */
.st-sidebar {
  width: 200px;
  min-width: 200px;
  background: var(--bg-primary, #0f172a);
  border-right: 1px solid var(--border-color, #334155);
  display: flex;
  flex-direction: column;
  padding: 0;
}

.st-sidebar-title {
  padding: 24px 20px 16px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  letter-spacing: 0.02em;
}

.st-sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px;
}

.st-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #94a3b8);
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.15s ease;
  text-align: left;
}

.st-nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary, #f1f5f9);
}

.st-nav-item.active {
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-blue, #3b82f6);
}

.st-nav-icon {
  font-size: 16px;
  width: 22px;
  text-align: center;
  flex-shrink: 0;
}

.st-sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--border-color, #334155);
}

.st-btn-close {
  width: 100%;
  justify-content: center;
}

/* ── Content area ───────────────────────────────────────── */
.st-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.st-content-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 28px 16px;
  border-bottom: 1px solid var(--border-color, #334155);
  flex-shrink: 0;
}

.st-content-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.st-close-x {
  background: none;
  border: none;
  color: var(--text-muted, #64748b);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.15s;
}
.st-close-x:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary, #f1f5f9);
}

.st-content-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 32px;
}

/* Custom scrollbar */
.st-content-body::-webkit-scrollbar {
  width: 6px;
}
.st-content-body::-webkit-scrollbar-track {
  background: transparent;
}
.st-content-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}
.st-content-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.18);
}

/* ── Groups ─────────────────────────────────────────────── */
.st-group {
  margin-bottom: 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.st-group:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.st-group-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  margin-bottom: 4px;
}

.st-group-desc {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary, #94a3b8);
  margin-bottom: 14px;
}

/* ── Theme cards ────────────────────────────────────────── */
.st-theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.st-theme-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.st-theme-card:hover {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
  transform: translateY(-1px);
}

.st-theme-card.active {
  border-color: var(--accent-blue, #3b82f6);
  background: rgba(59, 130, 246, 0.1);
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3);
}

.st-theme-icon {
  font-size: 22px;
}

.st-theme-label {
  font-size: 12.5px;
  font-weight: 500;
}

/* ── Preset row ─────────────────────────────────────────── */
.st-preset-row {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.st-preset-btn {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
  font-size: 13px;
  transition: all 0.15s;
}

.st-preset-btn:hover {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
}

/* ── Colors ─────────────────────────────────────────────── */
.st-custom-colors {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.st-color-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
}

.st-color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.st-color-code {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11.5px;
  color: var(--text-muted, #64748b);
  background: rgba(255, 255, 255, 0.04);
  padding: 3px 8px;
  border-radius: 4px;
}

input[type="color"] {
  border: none;
  width: 32px;
  height: 32px;
  cursor: pointer;
  background: none;
  border-radius: 6px;
}

/* ── Select ─────────────────────────────────────────────── */
.st-select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-radius: 8px;
  cursor: pointer;
  outline: none;
  font-size: 13px;
  transition: border-color 0.15s;
}
.st-select:focus {
  border-color: var(--accent-blue, #3b82f6);
}

.st-select-inline {
  width: auto;
  min-width: 140px;
}

/* ── Input ──────────────────────────────────────────────── */
.st-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-radius: 8px;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.st-input:focus {
  border-color: var(--accent-blue, #3b82f6);
}
.st-input::placeholder {
  color: var(--text-muted, #64748b);
  font-family: inherit;
}

/* ── Info box ───────────────────────────────────────────── */
.st-info-box {
  margin-top: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.06);
  border: 1px solid rgba(59, 130, 246, 0.15);
  font-size: 12.5px;
  color: var(--text-secondary, #94a3b8);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  line-height: 1.5;
}

.st-info-warn {
  background: rgba(234, 179, 8, 0.06);
  border-color: rgba(234, 179, 8, 0.2);
  color: #eab308;
}

.st-info-label {
  font-weight: 600;
}

.st-info-value {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── Buttons ────────────────────────────────────────────── */
.st-actions-row {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.st-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.18s ease;
  flex: 1;
}

.st-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.st-btn-primary {
  background: var(--accent-blue, #3b82f6);
  color: white;
  border-color: var(--accent-blue, #3b82f6);
}
.st-btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}

.st-btn-secondary {
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-color: var(--border-color, #334155);
}
.st-btn-secondary:hover:not(:disabled) {
  border-color: var(--accent-blue, #3b82f6);
  color: var(--accent-blue, #3b82f6);
}

.st-btn-warn {
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.3);
}
.st-btn-warn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(245, 158, 11, 0.5);
}

.st-btn-accent {
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-blue, #3b82f6);
  border-color: rgba(59, 130, 246, 0.3);
}
.st-btn-accent:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(59, 130, 246, 0.5);
}

/* ── Preset cards (storage strategy) ────────────────────── */
.st-preset-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.st-preset-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 8px 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.st-preset-card:hover {
  border-color: rgba(255, 255, 255, 0.15);
  transform: translateY(-1px);
}

.st-preset-card.active {
  border-color: var(--accent-blue, #3b82f6);
  background: rgba(59, 130, 246, 0.08);
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.25);
}

.st-preset-icon {
  font-size: 20px;
}

.st-preset-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.st-preset-desc {
  font-size: 10.5px;
  color: var(--text-muted, #64748b);
  text-align: center;
  line-height: 1.4;
}

/* ── Badges (memory / db indicators) ────────────────────── */
.st-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 8px;
  letter-spacing: 0.03em;
  vertical-align: middle;
}

.st-badge-memory {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.25);
}

.st-badge-db {
  background: rgba(59, 130, 246, 0.12);
  color: #93c5fd;
  border: 1px solid rgba(59, 130, 246, 0.25);
}

/* ── Ephemeral cache option cards ───────────────────────── */
.st-ephemeral-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.st-ephemeral-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 12px 8px 10px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.st-ephemeral-card:hover {
  border-color: rgba(168, 85, 247, 0.35);
  transform: translateY(-1px);
}

.st-ephemeral-card.active {
  border-color: #a855f7;
  background: rgba(168, 85, 247, 0.08);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.2);
}

.st-ephemeral-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.st-ephemeral-desc {
  font-size: 10.5px;
  color: var(--text-muted, #64748b);
}

/* ── Ephemeral summary stats ────────────────────────────── */
.st-ephemeral-summary {
  display: flex;
  gap: 18px;
  padding: 10px 14px;
  margin-top: 10px;
  background: rgba(168, 85, 247, 0.05);
  border: 1px solid rgba(168, 85, 247, 0.12);
  border-radius: 8px;
  flex-wrap: wrap;
}

.st-ephemeral-stat {
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
}

.st-ephemeral-stat strong {
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}
.st-group-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.st-advanced-toggle {
  background: none;
  border: 1px solid var(--border-color, #334155);
  color: var(--text-muted, #64748b);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.st-advanced-toggle:hover {
  border-color: rgba(255, 255, 255, 0.15);
  color: var(--text-secondary, #94a3b8);
}

.st-advanced-toggle.active {
  border-color: var(--accent-blue, #3b82f6);
  color: var(--accent-blue, #3b82f6);
  background: rgba(59, 130, 246, 0.06);
}

/* ── Tier table ─────────────────────────────────────────── */
.st-tier-table {
  border: 1px solid var(--border-color, #334155);
  border-radius: 10px;
  overflow: hidden;
}

.st-tier-header {
  display: grid;
  grid-template-columns: 2fr 1.5fr 1.2fr 1.2fr;
  gap: 8px;
  padding: 9px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--border-color, #334155);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.st-tier-row {
  display: grid;
  grid-template-columns: 2fr 1.5fr 1.2fr 1.2fr;
  gap: 8px;
  padding: 10px 14px;
  align-items: center;
  background: var(--bg-tertiary, #1a2332);
  transition: background 0.12s;
}

.st-tier-row + .st-tier-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.st-tier-row:hover {
  background: rgba(255, 255, 255, 0.02);
}

.st-tier-col-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.st-tier-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.st-tier-desc {
  font-size: 11px;
  color: var(--text-muted, #64748b);
}

.st-tier-col-limit {
  display: flex;
  align-items: center;
}

.st-tier-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

.st-tier-value.unlimited {
  color: var(--text-muted, #64748b);
  font-size: 18px;
}

.st-tier-input {
  width: 100%;
  max-width: 110px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-primary, #0f172a);
  color: var(--text-primary, #f1f5f9);
  border-radius: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  outline: none;
  transition: border-color 0.15s;
}

.st-tier-input:focus {
  border-color: var(--accent-blue, #3b82f6);
}

/* Hide number input arrows */
.st-tier-input::-webkit-outer-spin-button,
.st-tier-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.st-tier-input[type=number] {
  -moz-appearance: textfield;
}

.st-tier-col-time,
.st-tier-col-size {
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
}

.st-advanced-hint {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.05);
  border: 1px solid rgba(59, 130, 246, 0.12);
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
  line-height: 1.5;
}

/* ── Inline setting ─────────────────────────────────────── */
.st-inline-setting {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.st-inline-setting label {
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
  white-space: nowrap;
}

/* ── Responsive ─────────────────────────────────────────── */
@media (max-width: 640px) {
  .st-panel {
    flex-direction: column;
    height: 92vh;
    width: 96vw;
  }

  .st-sidebar {
    width: 100%;
    min-width: unset;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid var(--border-color, #334155);
    padding: 0;
    align-items: center;
  }

  .st-sidebar-title {
    padding: 12px 16px;
    font-size: 15px;
  }

  .st-sidebar-nav {
    flex-direction: row;
    gap: 2px;
    padding: 0 4px;
    overflow-x: auto;
  }

  .st-nav-item {
    padding: 8px 12px;
    white-space: nowrap;
    font-size: 12.5px;
  }

  .st-nav-label {
    display: none;
  }

  .st-sidebar-footer {
    display: none;
  }

  .st-content-body {
    padding: 16px;
  }

  .st-theme-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .st-preset-cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .st-ephemeral-cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .st-tier-header,
  .st-tier-row {
    grid-template-columns: 1.5fr 1fr 1fr;
  }

  .st-tier-col-size {
    display: none;
  }
}
.st-tool-card {
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
}

.st-tool-header {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.st-tool-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 1px;
}

.st-tool-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  margin-bottom: 4px;
}

.st-tool-desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary, #94a3b8);
}

/* ── Result box ─────────────────────────────────────────── */
.st-result {
  margin-top: 12px;
  padding: 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.5;
}

.st-result-ok {
  background: rgba(34, 197, 94, 0.06);
  border: 1px solid rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.st-result-warn {
  background: rgba(245, 158, 11, 0.06);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.st-result-fail {
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.st-result-head {
  font-weight: 600;
  margin-bottom: 6px;
}

.st-result-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 11.5px;
}

.st-result-detail {
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.8;
  font-family: var(--font-mono, monospace);
}

/* ── Series list (repair details) ───────────────────────── */
.st-series-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.st-series-item {
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.st-series-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.st-series-name {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  color: var(--text-primary, #f1f5f9);
}

.st-series-meta {
  color: var(--text-muted, #64748b);
  font-size: 10px;
  font-weight: 400;
}

.st-series-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.st-badge-ok {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}
.st-badge-fail {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.st-badge-info {
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-blue, #3b82f6);
}

.st-series-msg {
  margin-top: 4px;
  color: var(--text-secondary, #94a3b8);
  font-size: 11px;
}

.st-series-more {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted, #64748b);
}

/* ── About section ──────────────────────────────────────── */
.st-about-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 20px 0 8px;
}

.st-about-logo {
  font-size: 48px;
  margin-bottom: 12px;
  filter: drop-shadow(0 4px 12px rgba(59, 130, 246, 0.3));
}

.st-about-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  letter-spacing: 0.01em;
}

.st-about-version {
  margin-top: 4px;
  font-size: 13px;
  color: var(--accent-blue, #3b82f6);
  font-weight: 600;
  padding: 2px 12px;
  background: rgba(59, 130, 246, 0.1);
  border-radius: 999px;
}

.st-about-tagline {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
}

.st-about-stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--border-color, #334155);
}

.st-stack-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 11px 16px;
  background: var(--bg-tertiary, #1a2332);
  font-size: 13px;
}

.st-stack-item + .st-stack-item {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.st-stack-label {
  color: var(--text-muted, #64748b);
  font-weight: 500;
}

.st-stack-value {
  color: var(--text-primary, #f1f5f9);
  font-weight: 500;
}


/* ── Exchange connectivity test results ─────────────────── */
.st-exchange-results {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.st-exchange-result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  transition: background 0.15s;
}

.st-exchange-result-item.ok {
  background: rgba(34, 197, 94, 0.06);
}

.st-exchange-result-item.fail {
  background: rgba(239, 68, 68, 0.06);
}

.st-exchange-result-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.st-exchange-result-label {
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  min-width: 110px;
}

.st-exchange-result-msg {
  color: var(--text-secondary, #94a3b8);
  font-size: 11.5px;
  flex: 1;
  text-align: right;
}


      `}</style>
        </div>
    );
}
