import { useEffect, useState } from "react";
import type {
    CacheRowLimits,
    ChartSettings,
} from "../../features/settings/chartAppearanceSettings.js";

type CacheTierKey = keyof CacheRowLimits;
const CACHE_TIER_KEYS: CacheTierKey[] = ["minutes", "hours", "daily"];

interface CacheTier {
    key: CacheTierKey;
    label: string;
    desc: string;
    representativeSec: number;
}

interface CachePreset {
    key: string;
    label: string;
    icon: string;
    desc: string;
    limits: CacheRowLimits;
}

const EPHEMERAL_CACHE_OPTIONS = [
    { value: 3600, label: '1 小时', desc: '3,600 根' },
    { value: 14400, label: '4 小时', desc: '14,400 根' },
    { value: 43200, label: '12 小时', desc: '43,200 根' },
    { value: 86400, label: '24 小时', desc: '86,400 根' },
];

const DEFAULT_EPHEMERAL_BARS = 86400;
const DEFAULT_FRONTEND_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

const DB_TIERS: CacheTier[] = [
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

const DB_PRESETS: CachePreset[] = [
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

const DEFAULT_DB_LIMITS: CacheRowLimits = { minutes: 200000, hours: 50000, daily: 0 };

function barsToHumanTime(bars: number, representativeSec: number): string {
    if (bars === 0) return '不清理';
    const totalSec = bars * representativeSec;
    if (totalSec < 3600) return `≈ ${Math.round(totalSec / 60)} 分钟`;
    if (totalSec < 86400) return `≈ ${(totalSec / 3600).toFixed(1)} 小时`;
    if (totalSec < 86400 * 365) return `≈ ${Math.round(totalSec / 86400)} 天`;
    return `≈ ${(totalSec / (86400 * 365)).toFixed(0)} 年+`;
}

function barsToStorageSize(bars: number): string {
    if (bars === 0) return '--';
    const bytes = bars * 200;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function barsToMemorySize(bars: number): string {
    if (bars === 0) return '--';
    const bytes = bars * 200;
    if (bytes < 1024 * 1024) return `≈ ${(bytes / 1024).toFixed(0)} KB`;
    return `≈ ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function bytesToGbInput(bytes: number | null): string {
    const value = Number(bytes || 0);
    if (!value) return '';
    return (value / 1024 / 1024 / 1024).toFixed(2);
}

function gbInputToBytes(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 1024 * 1024 * 1024);
}

function bytesToMbInput(bytes: number): string | number {
    const value = Number(bytes || 0);
    if (!value) return '';
    return Math.round(value / 1024 / 1024);
}

function mbInputToBytes(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FRONTEND_CACHE_BUDGET_BYTES;
    return Math.round(parsed * 1024 * 1024);
}

export interface CacheLimitsPanelProps {
    settings: ChartSettings;
    onUpdate(settings: ChartSettings): void;
    showAdvanced: boolean;
    onToggleAdvanced(): void;
}

export default function CacheLimitsPanel({
    settings,
    onUpdate,
    showAdvanced,
    onToggleAdvanced,
}: CacheLimitsPanelProps) {
    const currentPreset = settings.cachePreset || 'standard';
    const currentLimits = settings.cacheLimits || { ...DEFAULT_DB_LIMITS };
    const currentEphemeralBars = settings.ephemeralCacheBars ?? DEFAULT_EPHEMERAL_BARS;
    const currentFrontendBudget = settings.frontendCacheBudgetBytes ?? DEFAULT_FRONTEND_CACHE_BUDGET_BYTES;
    const currentSqliteBudget = settings.sqliteStorageBudgetBytes ?? null;
    const rowLimitsEnabled = Boolean(settings.storageRowLimitsEnabled);
    const isCustomPreset = currentPreset === 'custom';
    const [frontendBudgetDraft, setFrontendBudgetDraft] = useState(
        String(bytesToMbInput(currentFrontendBudget)),
    );
    const [sqliteBudgetDraft, setSqliteBudgetDraft] = useState(
        bytesToGbInput(currentSqliteBudget),
    );

    useEffect(() => {
        setFrontendBudgetDraft(String(bytesToMbInput(currentFrontendBudget)));
    }, [currentFrontendBudget]);

    useEffect(() => {
        setSqliteBudgetDraft(bytesToGbInput(currentSqliteBudget));
    }, [currentSqliteBudget]);

    const handlePresetChange = (presetKey: string) => {
        const preset = DB_PRESETS.find((item) => item.key === presetKey);
        if (preset) {
            onUpdate({
                ...settings,
                cachePreset: presetKey,
                cacheLimits: { ...preset.limits },
            });
        }
    };

    const handleLimitChange = (tierKey: CacheTierKey, value: number) => {
        const newLimits = { ...currentLimits, [tierKey]: value };
        const matchingPreset = DB_PRESETS.find((preset) =>
            CACHE_TIER_KEYS.every((key) => preset.limits[key] === newLimits[key])
        );
        onUpdate({
            ...settings,
            cachePreset: matchingPreset ? matchingPreset.key : 'custom',
            cacheLimits: newLimits,
        });
    };

    const handleEphemeralChange = (value: number) => {
        onUpdate({
            ...settings,
            ephemeralCacheBars: value,
        });
    };

    const commitFrontendBudget = () => {
        const parsed = Number(frontendBudgetDraft);
        if (!Number.isFinite(parsed) || parsed < 16 || parsed > 4096) {
            setFrontendBudgetDraft(String(bytesToMbInput(currentFrontendBudget)));
            return;
        }
        onUpdate({
            ...settings,
            frontendCacheBudgetBytes: mbInputToBytes(frontendBudgetDraft),
        });
    };

    const commitSqliteBudget = () => {
        const parsed = Number(sqliteBudgetDraft);
        if (sqliteBudgetDraft !== '' && (!Number.isFinite(parsed) || parsed <= 0 || parsed > 16384)) {
            setSqliteBudgetDraft(bytesToGbInput(currentSqliteBudget));
            return;
        }
        onUpdate({
            ...settings,
            sqliteStorageBudgetBytes: gbInputToBytes(sqliteBudgetDraft),
        });
    };

    const handleRowLimitsEnabledChange = (enabled: boolean) => {
        onUpdate({
            ...settings,
            storageRowLimitsEnabled: enabled,
        });
    };

    return (
        <>
            <div className="st-group">
                <div className="st-group-title">
                    <span>秒级内存缓存</span>
                    <span className="st-badge st-badge-memory">内存</span>
                </div>
                <div className="st-group-desc">
                    秒级 K 线（如 1s）仅存在于内存缓存中，<strong>不写入数据库</strong>。
                    进程退出后自动丢弃，下次启动重新从交易所接收。
                </div>

                <div className="st-ephemeral-cards">
                    {EPHEMERAL_CACHE_OPTIONS.map((option) => (
                        <button
                            key={option.value}
                            className={`st-ephemeral-card ${currentEphemeralBars === option.value ? 'active' : ''}`}
                            onClick={() => handleEphemeralChange(option.value)}
                        >
                            <span className="st-ephemeral-label">{option.label}</span>
                            <span className="st-ephemeral-desc">{option.desc}</span>
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

            <div className="st-group">
                <div className="st-group-title">
                    <span>数据库存储策略</span>
                    <span className="st-badge st-badge-db">持久化</span>
                </div>
                <div className="st-group-desc">
                    分钟级及以上 K 线持久化到数据库。SQLite 预算用于 DB + WAL 水位与清理规划；
                    SHM 仅展示、不计入可回收压力。自动删除数据库行默认关闭，只有后端显式启用后才会执行；VACUUM 始终手动。
                </div>

                <div className="st-tier-table">
                    <div className="st-tier-row">
                        <div className="st-tier-col-name">
                            <span className="st-tier-label">前端缓存预算</span>
                            <span className="st-tier-desc">浏览器内 warm/cold K 线与指标缓存</span>
                        </div>
                        <div className="st-tier-col-limit">
                            <input
                                type="number"
                                className="st-tier-input"
                                value={frontendBudgetDraft}
                                min={16}
                                max={4096}
                                step={16}
                                onChange={(event) => setFrontendBudgetDraft(event.target.value)}
                                onBlur={commitFrontendBudget}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') event.currentTarget.blur();
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setFrontendBudgetDraft(String(bytesToMbInput(currentFrontendBudget)));
                                    }
                                }}
                                title="前端缓存最大估算内存 MB"
                            />
                        </div>
                        <span className="st-tier-col-time">MB</span>
                        <span className="st-tier-col-size">{barsToMemorySize(Math.floor(currentFrontendBudget / 200))}</span>
                    </div>
                    <div className="st-tier-row">
                        <div className="st-tier-col-name">
                            <span className="st-tier-label">SQLite 数据库预算</span>
                            <span className="st-tier-desc">DB + WAL 规划水位；留空表示不设置预算</span>
                        </div>
                        <div className="st-tier-col-limit">
                            <input
                                type="number"
                                className="st-tier-input"
                                value={sqliteBudgetDraft}
                                min={0}
                                max={16384}
                                step={0.25}
                                placeholder="未设置"
                                onChange={(event) => setSqliteBudgetDraft(event.target.value)}
                                onBlur={commitSqliteBudget}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') event.currentTarget.blur();
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setSqliteBudgetDraft(bytesToGbInput(currentSqliteBudget));
                                    }
                                }}
                                title="SQLite DB + WAL 规划预算（GB）；自动删除需后端显式启用"
                            />
                        </div>
                        <span className="st-tier-col-time">GB</span>
                        <span className="st-tier-col-size">{currentSqliteBudget ? barsToStorageSize(Math.floor(currentSqliteBudget / 200)) : '未设置'}</span>
                    </div>
                </div>

                <div className="st-preset-cards">
                    {DB_PRESETS.map((preset) => (
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

            <div className="st-group">
                <div className="st-group-title-row">
                    <div className="st-group-title" style={{ marginBottom: 0 }}>高级行数上限 / 保护策略</div>
                    <button
                        className={`st-advanced-toggle ${showAdvanced ? 'active' : ''}`}
                        onClick={onToggleAdvanced}
                    >
                        {showAdvanced ? '收起高级 ▴' : '高级 ▾'}
                    </button>
                </div>
                <div className="st-group-desc">
                    这些上限只在启用后作为额外硬规则。清理规划仍会优先参考冷热、活跃订阅、自定义周期和 storage intent 风险；
                    自动行删除能力仍由后端独立控制。
                </div>

                <label className="st-info-box" style={{ marginTop: 0 }}>
                    <input
                        type="checkbox"
                        checked={rowLimitsEnabled}
                        onChange={(event) => handleRowLimitsEnabledChange(event.target.checked)}
                    />
                    <span>启用每系列行数上限</span>
                </label>

                <div className="st-tier-table">
                    <div className="st-tier-header">
                        <span className="st-tier-col-name">级别</span>
                        <span className="st-tier-col-limit">最大根数</span>
                        <span className="st-tier-col-time">≈ 对应时长</span>
                        <span className="st-tier-col-size">≈ 磁盘占用 / 系列</span>
                    </div>
                    {DB_TIERS.map((tier) => {
                        const limit = currentLimits[tier.key] ?? 0;
                        return (
                            <div key={tier.key} className="st-tier-row">
                                <div className="st-tier-col-name">
                                    <span className="st-tier-label">{tier.label}</span>
                                    <span className="st-tier-desc">{tier.desc}</span>
                                </div>
                                <div className="st-tier-col-limit">
                                    {showAdvanced && rowLimitsEnabled && tier.key !== 'daily' ? (
                                        <input
                                            type="number"
                                            className="st-tier-input"
                                            value={limit}
                                            min={0}
                                            step={1000}
                                            onChange={(event) => handleLimitChange(tier.key, Math.max(0, parseInt(event.target.value) || 0))}
                                            title="0 = 不清理"
                                        />
                                    ) : (
                                        <span className={`st-tier-value ${limit === 0 ? 'unlimited' : ''}`}>
                                            {!rowLimitsEnabled ? '关闭' : limit === 0 ? '∞' : limit.toLocaleString()}
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
                        <span>输入 <strong>0</strong> 表示该级别不使用行数上限。SQLite 预算只定义规划水位，不会自行开启自动行删除。</span>
                    </div>
                )}
            </div>
        </>
    );
}
