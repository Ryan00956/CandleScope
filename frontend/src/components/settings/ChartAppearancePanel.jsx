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

            {settings.chartType === 'renko' && (
                <div className="st-group">
                    <div className="st-group-title">Renko 砖块</div>
                    <div className="st-group-desc">
                        使用源周期收盘价生成合成砖块。ATR 模式会在进入图表时确定固定砖高；传统模式使用手动砖高。
                    </div>
                    <label className="st-field">
                        <span>砖高计算</span>
                        <select
                            className="st-select"
                            value={settings.renkoBoxSizeMode || 'atr'}
                            onChange={(event) => handleUpdate('renkoBoxSizeMode', event.target.value)}
                        >
                            <option value="atr">ATR 自动</option>
                            <option value="traditional">传统固定砖高</option>
                        </select>
                    </label>
                    {(settings.renkoBoxSizeMode || 'atr') === 'atr' ? (
                        <label className="st-field">
                            <span>ATR 长度</span>
                            <input
                                className="st-input"
                                type="number"
                                min="2"
                                max="500"
                                step="1"
                                value={settings.renkoAtrLength || 14}
                                onChange={(event) => handleUpdate('renkoAtrLength', Number(event.target.value))}
                            />
                        </label>
                    ) : (
                        <label className="st-field">
                            <span>固定砖高</span>
                            <input
                                className="st-input"
                                type="number"
                                min="0"
                                step="any"
                                value={settings.renkoBoxSize || 1}
                                onChange={(event) => handleUpdate('renkoBoxSize', Number(event.target.value))}
                            />
                        </label>
                    )}
                    <div className="st-group-desc">
                        Renko 价格是合成值，不应用作精确成交价或回测成交价。
                    </div>
                </div>
            )}

            {settings.chartType === 'point-and-figure' && (
                <div className="st-group">
                    <div className="st-group-title">Point &amp; Figure 点数图</div>
                    <div className="st-group-desc">
                        使用源周期收盘价生成严格交替的 X/O 列。ATR 模式在进入图表时确定固定箱格；传统模式使用手动箱格。
                    </div>
                    <label className="st-field">
                        <span>箱格计算</span>
                        <select
                            className="st-select"
                            value={settings.pointFigureBoxSizeMode || 'atr'}
                            onChange={(event) => handleUpdate('pointFigureBoxSizeMode', event.target.value)}
                        >
                            <option value="atr">ATR 自动</option>
                            <option value="traditional">传统固定箱格</option>
                        </select>
                    </label>
                    {(settings.pointFigureBoxSizeMode || 'atr') === 'atr' ? (
                        <label className="st-field">
                            <span>ATR 长度</span>
                            <input
                                className="st-input"
                                type="number"
                                min="2"
                                max="500"
                                step="1"
                                value={settings.pointFigureAtrLength || 14}
                                onChange={(event) => handleUpdate('pointFigureAtrLength', Number(event.target.value))}
                            />
                        </label>
                    ) : (
                        <label className="st-field">
                            <span>固定箱格</span>
                            <input
                                className="st-input"
                                type="number"
                                min="0"
                                step="any"
                                value={settings.pointFigureBoxSize || 1}
                                onChange={(event) => handleUpdate('pointFigureBoxSize', Number(event.target.value))}
                            />
                        </label>
                    )}
                    <label className="st-field">
                        <span>反转格数</span>
                        <input
                            className="st-input"
                            type="number"
                            min="1"
                            max="100"
                            step="1"
                            value={settings.pointFigureReversalAmount || 3}
                            onChange={(event) => handleUpdate('pointFigureReversalAmount', Number(event.target.value))}
                        />
                    </label>
                    <div className="st-group-desc">
                        点数图是合成价格结构；V1 不支持 High/Low 路径、Percentage 和 One Step Back，也不应用作精确成交价。
                    </div>
                </div>
            )}

            {settings.chartType === 'kagi' && (
                <div className="st-group">
                    <div className="st-group-title">Kagi 卡吉图</div>
                    <div className="st-group-desc">
                        使用源周期收盘价生成无时间比例的转折线。突破前肩切换为 Yang 粗线，跌破前腰切换为 Yin 细线；粗细与涨跌方向独立。
                    </div>
                    <label className="st-field">
                        <span>反转距离</span>
                        <select
                            className="st-select"
                            value={settings.kagiReversalMode || 'atr'}
                            onChange={(event) => handleUpdate('kagiReversalMode', event.target.value)}
                        >
                            <option value="atr">ATR 自动</option>
                            <option value="traditional">传统固定距离</option>
                        </select>
                    </label>
                    {(settings.kagiReversalMode || 'atr') === 'atr' ? (
                        <label className="st-field">
                            <span>ATR 长度</span>
                            <input
                                className="st-input"
                                type="number"
                                min="2"
                                max="500"
                                step="1"
                                value={settings.kagiAtrLength || 14}
                                onChange={(event) => handleUpdate('kagiAtrLength', Number(event.target.value))}
                            />
                        </label>
                    ) : (
                        <label className="st-field">
                            <span>固定反转距离</span>
                            <input
                                className="st-input"
                                type="number"
                                min="0"
                                step="any"
                                value={settings.kagiReversalAmount || 1}
                                onChange={(event) => handleUpdate('kagiReversalAmount', Number(event.target.value))}
                            />
                        </label>
                    )}
                    <div className="st-group-desc">
                        Kagi 是合成价格结构；V1 使用 Close，不支持 Percentage，也不应用作精确成交价或回测成交价。
                    </div>
                </div>
            )}

            {settings.chartType === 'line-break' && (
                <div className="st-group">
                    <div className="st-group-title">Line Break 新价线</div>
                    <div className="st-group-desc">
                        使用源周期收盘价与最近若干条合成线的高低区间比较；只有严格突破区间才生成新线。
                    </div>
                    <label className="st-field">
                        <span>参考线数量</span>
                        <input
                            className="st-input"
                            type="number"
                            min="1"
                            max="50"
                            step="1"
                            value={settings.lineBreakNumberOfLines || 3}
                            onChange={(event) => handleUpdate('lineBreakNumberOfLines', Number(event.target.value))}
                        />
                    </label>
                    <div className="st-group-desc">
                        常用设置为 3。最新未收盘源 K 触发的 line 可能随价格回撤消失；合成价格不应用作精确成交价或回测成交价。
                    </div>
                </div>
            )}

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
