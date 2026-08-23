import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type {
    CacheRowLimits,
    ChartSettings,
} from "../../features/settings/chartAppearanceSettings.js";

type CacheTierKey = keyof CacheRowLimits;
const CACHE_TIER_KEYS: CacheTierKey[] = ["minutes", "hours", "daily"];

interface CacheTier {
    key: CacheTierKey;
    labelKey: "settings.cache.minutes" | "settings.cache.hours" | "settings.cache.daily";
    descKey: "settings.cache.minutesDesc" | "settings.cache.hoursDesc" | "settings.cache.dailyDesc";
    representativeSec: number;
}

interface CachePreset {
    key: string;
    labelKey: "settings.cache.compact" | "settings.cache.standard" | "settings.cache.generous" | "settings.cache.unlimited";
    descKey: "settings.cache.compactDesc" | "settings.cache.standardDesc" | "settings.cache.generousDesc" | "settings.cache.unlimitedDesc";
    icon: string;
    limits: CacheRowLimits;
}

const EPHEMERAL_CACHE_OPTIONS = [
    { value: 3600, labelKey: "settings.cache.hour1" as const, bars: 3600 },
    { value: 14400, labelKey: "settings.cache.hour4" as const, bars: 14400 },
    { value: 43200, labelKey: "settings.cache.hour12" as const, bars: 43200 },
    { value: 86400, labelKey: "settings.cache.hour24" as const, bars: 86400 },
];

const DEFAULT_EPHEMERAL_BARS = 86400;
const DEFAULT_FRONTEND_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

const DB_TIERS: CacheTier[] = [
    {
        key: 'minutes',
        labelKey: 'settings.cache.minutes',
        descKey: 'settings.cache.minutesDesc',
        representativeSec: 60,
    },
    {
        key: 'hours',
        labelKey: 'settings.cache.hours',
        descKey: 'settings.cache.hoursDesc',
        representativeSec: 3600,
    },
    {
        key: 'daily',
        labelKey: 'settings.cache.daily',
        descKey: 'settings.cache.dailyDesc',
        representativeSec: 86400,
    },
];

const DB_PRESETS: CachePreset[] = [
    {
        key: 'compact',
        labelKey: 'settings.cache.compact',
        descKey: 'settings.cache.compactDesc',
        icon: '🟢',
        limits: { minutes: 50000, hours: 20000, daily: 0 },
    },
    {
        key: 'standard',
        labelKey: 'settings.cache.standard',
        descKey: 'settings.cache.standardDesc',
        icon: '🔵',
        limits: { minutes: 200000, hours: 50000, daily: 0 },
    },
    {
        key: 'generous',
        labelKey: 'settings.cache.generous',
        descKey: 'settings.cache.generousDesc',
        icon: '🟡',
        limits: { minutes: 500000, hours: 100000, daily: 0 },
    },
    {
        key: 'unlimited',
        labelKey: 'settings.cache.unlimited',
        descKey: 'settings.cache.unlimitedDesc',
        icon: '⚪',
        limits: { minutes: 0, hours: 0, daily: 0 },
    },
];

const DEFAULT_DB_LIMITS: CacheRowLimits = { minutes: 200000, hours: 50000, daily: 0 };

function barsToHumanTime(bars: number, representativeSec: number): string {
    if (bars === 0) return t("settings.cache.noCleanup");
    const totalSec = bars * representativeSec;
    if (totalSec < 3600) return t("settings.cache.approxMinutes", { count: Math.round(totalSec / 60) });
    if (totalSec < 86400) return t("settings.cache.approxHours", { count: (totalSec / 3600).toFixed(1) });
    if (totalSec < 86400 * 365) return t("settings.cache.approxDays", { count: Math.round(totalSec / 86400) });
    return t("settings.cache.approxYears", { count: (totalSec / (86400 * 365)).toFixed(0) });
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
    const locale = useLocale();
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
                    <span>{t("settings.cache.ephemeralTitle")}</span>
                    <span className="st-badge st-badge-memory">{t("settings.cache.memory")}</span>
                </div>
                <div className="st-group-desc">
                    {t("settings.cache.ephemeralDesc")}
                </div>

                <div className="st-ephemeral-cards">
                    {EPHEMERAL_CACHE_OPTIONS.map((option) => (
                        <button
                            key={option.value}
                            className={`st-ephemeral-card ${currentEphemeralBars === option.value ? 'active' : ''}`}
                            onClick={() => handleEphemeralChange(option.value)}
                        >
                            <span className="st-ephemeral-label">{t(option.labelKey)}</span>
                            <span className="st-ephemeral-desc">{t("settings.cache.bars", { count: option.bars.toLocaleString(locale) })}</span>
                        </button>
                    ))}
                </div>

                <div className="st-ephemeral-summary">
                    <span className="st-ephemeral-stat">
                        📊 {t("settings.cache.capacity")} <strong>{currentEphemeralBars.toLocaleString(locale)}</strong>
                    </span>
                    <span className="st-ephemeral-stat">
                        ⏱ {t("settings.cache.coverage")} <strong>{barsToHumanTime(currentEphemeralBars, 1).replace('≈ ', '')}</strong>
                    </span>
                    <span className="st-ephemeral-stat">
                        💾 {t("settings.cache.memoryUse")} <strong>{barsToMemorySize(currentEphemeralBars)}</strong> {t("settings.cache.perSymbol")}
                    </span>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">
                    <span>{t("settings.cache.dbTitle")}</span>
                    <span className="st-badge st-badge-db">{t("settings.cache.persistent")}</span>
                </div>
                <div className="st-group-desc">
                    {t("settings.cache.dbDesc")}
                </div>

                <div className="st-tier-table">
                    <div className="st-tier-row">
                        <div className="st-tier-col-name">
                            <span className="st-tier-label">{t("settings.cache.frontendBudget")}</span>
                            <span className="st-tier-desc">{t("settings.cache.frontendBudgetDesc")}</span>
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
                                title={t("settings.cache.frontendBudgetTitle")}
                            />
                        </div>
                        <span className="st-tier-col-time">MB</span>
                        <span className="st-tier-col-size">{barsToMemorySize(Math.floor(currentFrontendBudget / 200))}</span>
                    </div>
                    <div className="st-tier-row">
                        <div className="st-tier-col-name">
                            <span className="st-tier-label">{t("settings.cache.sqliteBudget")}</span>
                            <span className="st-tier-desc">{t("settings.cache.sqliteBudgetDesc")}</span>
                        </div>
                        <div className="st-tier-col-limit">
                            <input
                                type="number"
                                className="st-tier-input"
                                value={sqliteBudgetDraft}
                                min={0}
                                max={16384}
                                step={0.25}
                                placeholder={t("settings.cache.unset")}
                                onChange={(event) => setSqliteBudgetDraft(event.target.value)}
                                onBlur={commitSqliteBudget}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') event.currentTarget.blur();
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setSqliteBudgetDraft(bytesToGbInput(currentSqliteBudget));
                                    }
                                }}
                                title={t("settings.cache.sqliteBudgetTitle")}
                            />
                        </div>
                        <span className="st-tier-col-time">GB</span>
                        <span className="st-tier-col-size">{currentSqliteBudget ? barsToStorageSize(Math.floor(currentSqliteBudget / 200)) : t("settings.cache.unset")}</span>
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
                            <span className="st-preset-name">{t(preset.labelKey)}</span>
                            <span className="st-preset-desc">{t(preset.descKey)}</span>
                        </button>
                    ))}
                </div>

                {isCustomPreset && (
                    <div className="st-info-box" style={{ marginTop: 12 }}>
                        <span>🔧 {t("settings.cache.custom")}</span>
                    </div>
                )}
            </div>

            <div className="st-group">
                <div className="st-group-title-row">
                    <div className="st-group-title" style={{ marginBottom: 0 }}>{t("settings.cache.advanced")}</div>
                    <button
                        className={`st-advanced-toggle ${showAdvanced ? 'active' : ''}`}
                        onClick={onToggleAdvanced}
                    >
                        {showAdvanced ? t("settings.cache.hideAdvanced") : t("settings.cache.showAdvanced")}
                    </button>
                </div>
                <div className="st-group-desc">
                    {t("settings.cache.advancedDesc")}
                </div>

                <label className="st-info-box" style={{ marginTop: 0 }}>
                    <input
                        type="checkbox"
                        checked={rowLimitsEnabled}
                        onChange={(event) => handleRowLimitsEnabledChange(event.target.checked)}
                    />
                    <span>{t("settings.cache.enableRowLimits")}</span>
                </label>

                <div className="st-tier-table">
                    <div className="st-tier-header">
                        <span className="st-tier-col-name">{t("settings.cache.tier")}</span>
                        <span className="st-tier-col-limit">{t("settings.cache.maxBars")}</span>
                        <span className="st-tier-col-time">{t("settings.cache.duration")}</span>
                        <span className="st-tier-col-size">{t("settings.cache.disk")}</span>
                    </div>
                    {DB_TIERS.map((tier) => {
                        const limit = currentLimits[tier.key] ?? 0;
                        return (
                            <div key={tier.key} className="st-tier-row">
                                <div className="st-tier-col-name">
                                    <span className="st-tier-label">{t(tier.labelKey)}</span>
                                    <span className="st-tier-desc">{t(tier.descKey)}</span>
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
                                            title={t("settings.cache.zeroNoCleanup")}
                                        />
                                    ) : (
                                        <span className={`st-tier-value ${limit === 0 ? 'unlimited' : ''}`}>
                                            {!rowLimitsEnabled ? t("settings.cache.off") : limit === 0 ? '∞' : limit.toLocaleString(locale)}
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
                        <span>{t("settings.cache.zeroHint")}</span>
                    </div>
                )}
            </div>
        </>
    );
}
