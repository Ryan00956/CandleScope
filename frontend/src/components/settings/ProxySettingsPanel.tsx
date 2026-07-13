import type {
    ProxyMode,
    ProxySaveMessage,
    ProxyTestResult,
} from "../../features/settings/proxySettingsRuntime.js";

interface ProxyModeOption {
    value: ProxyMode;
    icon: string;
    label: string;
}

const PROXY_MODES: ProxyModeOption[] = [
    { value: 'system', icon: '🖥️', label: '系统代理' },
    { value: 'custom', icon: '⚙️', label: '自定义' },
    { value: 'none', icon: '🚫', label: '不使用' },
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
    return (
        <div className="st-group">
            <div className="st-group-title">代理模式</div>
            <div className="st-group-desc">选择访问交易所 API 的网络代理方式</div>
            <div className="st-theme-grid">
                {PROXY_MODES.map((mode) => (
                    <button
                        key={mode.value}
                        className={`st-theme-card ${proxyMode === mode.value ? 'active' : ''}`}
                        onClick={() => onProxyModeChange(mode.value)}
                    >
                        <span className="st-theme-icon">{mode.icon}</span>
                        <span className="st-theme-label">{mode.label}</span>
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
                        onChange={(event) => onCustomProxyChange(event.target.value)}
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
                    onClick={onProxyTest}
                    disabled={proxyLoading}
                >
                    {proxyLoading ? '⏳ 测试中...' : '🔍 测试连接'}
                </button>
                <button
                    className="st-btn st-btn-primary"
                    onClick={onProxySave}
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
