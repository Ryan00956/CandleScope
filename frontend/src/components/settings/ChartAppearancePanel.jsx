export default function ChartAppearancePanel({ settings, onUpdate }) {
    const handleUpdate = (key, value) => {
        onUpdate({ ...settings, [key]: value });
    };

    return (
        <>
            <div className="st-group">
                <div className="st-group-title">视觉主题</div>
                <div className="st-group-desc">选择界面的整体视觉风格，可跟随系统亮/暗色自动切换</div>
                <div className="st-theme-grid st-appearance-theme-grid">
                    {[
                        { value: 'dark', icon: '🌙', label: '深色' },
                        { value: 'light', icon: '☀️', label: '亮色' },
                        { value: 'system', icon: '🌓', label: '跟随系统' },
                        { value: 'custom', icon: '🎨', label: '自定义' },
                    ].map((theme) => (
                        <button
                            key={theme.value}
                            className={`st-theme-card ${settings.theme === theme.value ? 'active' : ''}`}
                            onClick={() => handleUpdate('theme', theme.value)}
                        >
                            <span className="st-theme-icon">{theme.icon}</span>
                            <span className="st-theme-label">{theme.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            {settings.theme === 'custom' && (
                <div className="st-group">
                    <div className="st-group-title">自定义背景色</div>
                    <div className="st-color-row">
                        <input
                            type="color"
                            value={settings.customBg}
                            onChange={(event) => handleUpdate('customBg', event.target.value)}
                        />
                        <code className="st-color-code">{settings.customBg}</code>
                    </div>
                </div>
            )}

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
                                onChange={(event) => handleUpdate('upColor', event.target.value)}
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
                                onChange={(event) => handleUpdate('downColor', event.target.value)}
                            />
                            <code className="st-color-code">{settings.downColor}</code>
                        </div>
                    </div>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">显示时区</div>
                <div className="st-group-desc">图表坐标轴及十字线时间标签使用的时区</div>
                <select
                    className="st-select"
                    value={settings.timezone || 'Local'}
                    onChange={(event) => handleUpdate('timezone', event.target.value)}
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
                        {Intl.supportedValuesOf('timeZone').map((timezone) => (
                            <option key={timezone} value={timezone}>{timezone.replace('_', ' ')}</option>
                        ))}
                    </optgroup>
                </select>
            </div>
        </>
    );
}
