const EPHEMERAL_CACHE_OPTIONS = [
    { value: 3600, label: '1 小时', desc: '3,600 根' },
    { value: 14400, label: '4 小时', desc: '14,400 根' },
    { value: 43200, label: '12 小时', desc: '43,200 根' },
    { value: 86400, label: '24 小时', desc: '86,400 根' },
];

const DEFAULT_EPHEMERAL_BARS = 86400;

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

const DEFAULT_DB_LIMITS = DB_PRESETS.find((preset) => preset.key === 'standard').limits;

function barsToHumanTime(bars, representativeSec) {
    if (bars === 0) return '不清理';
    const totalSec = bars * representativeSec;
    if (totalSec < 3600) return `≈ ${Math.round(totalSec / 60)} 分钟`;
    if (totalSec < 86400) return `≈ ${(totalSec / 3600).toFixed(1)} 小时`;
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

export default function CacheLimitsPanel({ settings, onUpdate, showAdvanced, onToggleAdvanced }) {
    const currentPreset = settings.cachePreset || 'standard';
    const currentLimits = settings.cacheLimits || { ...DEFAULT_DB_LIMITS };
    const currentEphemeralBars = settings.ephemeralCacheBars ?? DEFAULT_EPHEMERAL_BARS;
    const isCustomPreset = currentPreset === 'custom';

    const handlePresetChange = (presetKey) => {
        const preset = DB_PRESETS.find((item) => item.key === presetKey);
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
        const matchingPreset = DB_PRESETS.find((preset) =>
            Object.keys(preset.limits).every((key) => preset.limits[key] === newLimits[key])
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
                    分钟级及以上的 K 线数据持久化到数据库。选择预设方案或展开高级选项自定义每个级别的保留上限。
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
                    <div className="st-group-title" style={{ marginBottom: 0 }}>各级别保留详情</div>
                    <button
                        className={`st-advanced-toggle ${showAdvanced ? 'active' : ''}`}
                        onClick={onToggleAdvanced}
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
                    {DB_TIERS.map((tier) => {
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
                                            onChange={(event) => handleLimitChange(tier.key, Math.max(0, parseInt(event.target.value) || 0))}
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
        </>
    );
}
