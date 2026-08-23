import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type {
    ProxyMode,
    ProxySaveMessage,
    ProxyTestResult,
} from "../../features/settings/proxySettingsRuntime.js";

interface ProxyModeOption {
    value: ProxyMode;
    icon: string;
    labelKey: "settings.proxy.system" | "settings.proxy.custom" | "settings.proxy.none";
}

const PROXY_MODES: ProxyModeOption[] = [
    { value: 'system', icon: '🖥️', labelKey: 'settings.proxy.system' },
    { value: 'custom', icon: '⚙️', labelKey: 'settings.proxy.custom' },
    { value: 'none', icon: '🚫', labelKey: 'settings.proxy.none' },
];

export interface ProxySettingsPanelProps {
    proxyMode: ProxyMode;
    customProxy: string;
    systemProxy: string;
    effectiveProxy: string;
    proxyLoading: boolean;
    proxyTestResult: ProxyTestResult | null;
    proxySaveMsg: ProxySaveMessage | null;
    onProxyModeChange(mode: ProxyMode): void;
    onCustomProxyChange(value: string): void;
    onProxyTest(): void;
    onProxySave(): void;
}

export default function ProxySettingsPanel({
    proxyMode,
    customProxy,
    systemProxy,
    effectiveProxy,
    proxyLoading,
    proxyTestResult,
    proxySaveMsg,
    onProxyModeChange,
    onCustomProxyChange,
    onProxyTest,
    onProxySave,
}: ProxySettingsPanelProps) {
    useLocale();
    return (
        <div className="st-group">
            <div className="st-group-title">{t("settings.proxy.title")}</div>
            <div className="st-group-desc">{t("settings.proxy.desc")}</div>
            <div className="st-theme-grid">
                {PROXY_MODES.map((mode) => (
                    <button
                        key={mode.value}
                        className={`st-theme-card ${proxyMode === mode.value ? 'active' : ''}`}
                        onClick={() => onProxyModeChange(mode.value)}
                    >
                        <span className="st-theme-icon">{mode.icon}</span>
                        <span className="st-theme-label">{t(mode.labelKey)}</span>
                    </button>
                ))}
            </div>

            {proxyMode === 'system' && systemProxy && (
                <div className="st-info-box">
                    <span className="st-info-label">{t("settings.proxy.detected")}</span>
                    <code className="st-info-value">{systemProxy}</code>
                </div>
            )}
            {proxyMode === 'system' && !systemProxy && (
                <div className="st-info-box st-info-warn">
                    <span>{t("settings.proxy.notDetected")}</span>
                </div>
            )}

            {proxyMode === 'custom' && (
                <div style={{ marginTop: 12 }}>
                    <input
                        type="text"
                        className="st-input"
                        placeholder={t("settings.proxy.placeholder")}
                        value={customProxy}
                        onChange={(event) => onCustomProxyChange(event.target.value)}
                    />
                </div>
            )}

            {effectiveProxy && proxyMode !== 'none' && (
                <div className="st-info-box">
                    <span className="st-info-label">{t("settings.proxy.effective")}</span>
                    <code className="st-info-value">{effectiveProxy}</code>
                </div>
            )}

            <div className="st-actions-row">
                <button
                    className="st-btn st-btn-secondary"
                    onClick={onProxyTest}
                    disabled={proxyLoading}
                >
                    {proxyLoading ? t("settings.proxy.testing") : t("settings.proxy.test")}
                </button>
                <button
                    className="st-btn st-btn-primary"
                    onClick={onProxySave}
                    disabled={proxyLoading}
                >
                    {proxyLoading ? t("settings.proxy.saving") : t("settings.proxy.save")}
                </button>
            </div>

            {proxyTestResult && (
                <div className={`st-result ${proxyTestResult.success ? 'st-result-ok' : proxyTestResult.partial ? 'st-result-warn' : 'st-result-fail'}`}>
                    <span>{proxyTestResult.success ? '✅' : proxyTestResult.partial ? '⚠️' : '❌'} {proxyTestResult.message}</span>
                    {proxyTestResult.proxy_used && (
                        <div className="st-result-detail">{t("settings.proxy.used", { proxy: proxyTestResult.proxy_used })}</div>
                    )}
                    {Array.isArray(proxyTestResult.results) && proxyTestResult.results.length > 0 && (
                        <div className="st-exchange-results">
                            {proxyTestResult.results.map((result) => (
                                <div key={result.exchange} className={`st-exchange-result-item ${result.success ? 'ok' : 'fail'}`}>
                                    <span className="st-exchange-result-icon">{result.success ? '✅' : '❌'}</span>
                                    <span className="st-exchange-result-label">{result.label}</span>
                                    <span className="st-exchange-result-msg">{result.message}</span>
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
    );
}
