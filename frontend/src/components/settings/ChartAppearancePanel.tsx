import type {
    ChartSettings,
    ChartTheme,
    PriceBoxSizeMode,
} from "../../features/settings/chartAppearanceSettings.js";
import {
    LOCALE_OPTIONS,
    setLocale,
    t,
    type LocaleId,
    type MessageKey,
} from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

interface ThemeOption {
    value: ChartTheme;
    icon: string;
    labelKey: MessageKey;
}

const THEME_OPTIONS: ThemeOption[] = [
    { value: "dark", icon: "🌙", labelKey: "settings.appearance.theme.dark" },
    { value: "light", icon: "☀️", labelKey: "settings.appearance.theme.light" },
    { value: "system", icon: "🌓", labelKey: "settings.appearance.theme.system" },
    { value: "custom", icon: "🎨", labelKey: "settings.appearance.theme.custom" },
];

function priceBoxSizeMode(value: string): PriceBoxSizeMode {
    return value === "traditional" ? "traditional" : "atr";
}

export interface ChartAppearancePanelProps {
    settings: ChartSettings;
    onUpdate(settings: ChartSettings): void;
}

export default function ChartAppearancePanel({ settings, onUpdate }: ChartAppearancePanelProps) {
    useLocale();
    const handleUpdate = <K extends keyof ChartSettings>(key: K, value: ChartSettings[K]) => {
        onUpdate({ ...settings, [key]: value });
    };
    const handleLocaleChange = (locale: LocaleId) => {
        setLocale(locale);
        handleUpdate("locale", locale);
    };

    return (
        <>
            <div className="st-group">
                <div className="st-group-title">{t("settings.language.title")}</div>
                <div className="st-group-desc">{t("settings.language.description")}</div>
                <select
                    className="st-select"
                    value={settings.locale || "zh-CN"}
                    onChange={(event) => handleLocaleChange(event.target.value === "en" ? "en" : "zh-CN")}
                    aria-label={t("settings.language.title")}
                    data-settings-locale="true"
                >
                    {LOCALE_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>{option.nativeLabel}</option>
                    ))}
                </select>
            </div>

            <div className="st-group">
                <div className="st-group-title">{t("settings.appearance.themeTitle")}</div>
                <div className="st-group-desc">{t("settings.appearance.themeDescription")}</div>
                <div className="st-theme-grid st-appearance-theme-grid">
                    {THEME_OPTIONS.map((theme) => (
                        <button
                            key={theme.value}
                            className={`st-theme-card ${settings.theme === theme.value ? 'active' : ''}`}
                            onClick={() => handleUpdate('theme', theme.value)}
                        >
                            <span className="st-theme-icon">{theme.icon}</span>
                            <span className="st-theme-label">{t(theme.labelKey)}</span>
                        </button>
                    ))}
                </div>
            </div>

            {settings.theme === 'custom' && (
                <div className="st-group">
                    <div className="st-group-title">{t("settings.appearance.customBg")}</div>
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
                <div className="st-group-title">{t("settings.appearance.colorScheme")}</div>
                <div className="st-group-desc">{t("settings.appearance.colorSchemeDescription")}</div>
                <div className="st-preset-row">
                    <button
                        className="st-preset-btn"
                        onClick={() => onUpdate({ ...settings, upColor: '#22c55e', downColor: '#ef4444' })}
                    >
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>● {t("settings.appearance.greenUp")}</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>● {t("settings.appearance.redDown")}</span>
                    </button>
                    <button
                        className="st-preset-btn"
                        onClick={() => onUpdate({ ...settings, upColor: '#ef4444', downColor: '#22c55e' })}
                    >
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>● {t("settings.appearance.redUp")}</span>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>● {t("settings.appearance.greenDown")}</span>
                    </button>
                </div>
                <div className="st-custom-colors">
                    <div className="st-color-item">
                        <span>{t("settings.appearance.upColor")}</span>
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
                        <span>{t("settings.appearance.downColor")}</span>
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
                    <div className="st-group-title">{t("settings.appearance.renkoTitle")}</div>
                    <div className="st-group-desc">
                        {t("settings.appearance.renkoDescription")}
                    </div>
                    <label className="st-field">
                        <span>{t("settings.appearance.boxSizeMode")}</span>
                        <select
                            className="st-select"
                            value={settings.renkoBoxSizeMode || 'atr'}
                            onChange={(event) => handleUpdate('renkoBoxSizeMode', priceBoxSizeMode(event.target.value))}
                        >
                            <option value="atr">{t("settings.appearance.atrAuto")}</option>
                            <option value="traditional">{t("settings.appearance.traditionalBox")}</option>
                        </select>
                    </label>
                    {(settings.renkoBoxSizeMode || 'atr') === 'atr' ? (
                        <label className="st-field">
                            <span>{t("settings.appearance.atrLength")}</span>
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
                            <span>{t("settings.appearance.fixedBox")}</span>
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
                        {t("settings.appearance.renkoFooter")}
                    </div>
                </div>
            )}

            {settings.chartType === 'point-and-figure' && (
                <div className="st-group">
                    <div className="st-group-title">{t("settings.appearance.pointFigureTitle")}</div>
                    <div className="st-group-desc">
                        {t("settings.appearance.pointFigureDescription")}
                    </div>
                    <label className="st-field">
                        <span>{t("settings.appearance.pointFigureBoxMode")}</span>
                        <select
                            className="st-select"
                            value={settings.pointFigureBoxSizeMode || 'atr'}
                            onChange={(event) => handleUpdate('pointFigureBoxSizeMode', priceBoxSizeMode(event.target.value))}
                        >
                            <option value="atr">{t("settings.appearance.atrAuto")}</option>
                            <option value="traditional">{t("settings.appearance.traditionalPointFigureBox")}</option>
                        </select>
                    </label>
                    {(settings.pointFigureBoxSizeMode || 'atr') === 'atr' ? (
                        <label className="st-field">
                            <span>{t("settings.appearance.atrLength")}</span>
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
                            <span>{t("settings.appearance.fixedPointFigureBox")}</span>
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
                        <span>{t("settings.appearance.reversalBoxes")}</span>
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
                        {t("settings.appearance.pointFigureFooter")}
                    </div>
                </div>
            )}

            {settings.chartType === 'kagi' && (
                <div className="st-group">
                    <div className="st-group-title">{t("settings.appearance.kagiTitle")}</div>
                    <div className="st-group-desc">
                        {t("settings.appearance.kagiDescription")}
                    </div>
                    <label className="st-field">
                        <span>{t("settings.appearance.reversalDistance")}</span>
                        <select
                            className="st-select"
                            value={settings.kagiReversalMode || 'atr'}
                            onChange={(event) => handleUpdate('kagiReversalMode', priceBoxSizeMode(event.target.value))}
                        >
                            <option value="atr">{t("settings.appearance.atrAuto")}</option>
                            <option value="traditional">{t("settings.appearance.traditionalDistance")}</option>
                        </select>
                    </label>
                    {(settings.kagiReversalMode || 'atr') === 'atr' ? (
                        <label className="st-field">
                            <span>{t("settings.appearance.atrLength")}</span>
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
                            <span>{t("settings.appearance.fixedReversalDistance")}</span>
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
                        {t("settings.appearance.kagiFooter")}
                    </div>
                </div>
            )}

            {settings.chartType === 'line-break' && (
                <div className="st-group">
                    <div className="st-group-title">{t("settings.appearance.lineBreakTitle")}</div>
                    <div className="st-group-desc">
                        {t("settings.appearance.lineBreakDescription")}
                    </div>
                    <label className="st-field">
                        <span>{t("settings.appearance.lineBreakCount")}</span>
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
                        {t("settings.appearance.lineBreakFooter")}
                    </div>
                </div>
            )}

            <div className="st-group">
                <div className="st-group-title">{t("settings.appearance.timezoneTitle")}</div>
                <div className="st-group-desc">{t("settings.appearance.timezoneDescription")}</div>
                <select
                    className="st-select"
                    value={settings.timezone || 'Local'}
                    onChange={(event) => handleUpdate('timezone', event.target.value)}
                >
                    <option value="Local">{t("settings.appearance.timezoneLocal")}</option>
                    <optgroup label={t("settings.appearance.timezoneCommon")}>
                        <option value="UTC">{t("settings.appearance.timezoneUtc")}</option>
                        <option value="America/New_York">{t("settings.appearance.timezoneNewYork")}</option>
                        <option value="Europe/London">{t("settings.appearance.timezoneLondon")}</option>
                        <option value="Asia/Shanghai">{t("settings.appearance.timezoneShanghai")}</option>
                        <option value="Asia/Tokyo">{t("settings.appearance.timezoneTokyo")}</option>
                        <option value="Asia/Singapore">{t("settings.appearance.timezoneSingapore")}</option>
                        <option value="Asia/Hong_Kong">{t("settings.appearance.timezoneHongKong")}</option>
                    </optgroup>
                    <optgroup label={t("settings.appearance.timezoneAll")}>
                        {Intl.supportedValuesOf('timeZone').map((timezone) => (
                            <option key={timezone} value={timezone}>{timezone.replace('_', ' ')}</option>
                        ))}
                    </optgroup>
                </select>
            </div>
        </>
    );
}
