import React, { useState, useEffect, useCallback } from 'react';
import {
    fetchProxySettings,
    updateProxySettings,
    testProxyConnection,
    repairStoredCustomIntervals,
} from '../services/api';

export default function SettingsModal({ isOpen, onClose, settings, onUpdate }) {
    // ── Proxy state ─────────────────────────────────────────
    const [proxyMode, setProxyMode] = useState('system');
    const [customProxy, setCustomProxy] = useState('');
    const [systemProxy, setSystemProxy] = useState('');
    const [effectiveProxy, setEffectiveProxy] = useState('');
    const [proxyLoading, setProxyLoading] = useState(false);
    const [proxyTestResult, setProxyTestResult] = useState(null);
    const [proxySaveMsg, setProxySaveMsg] = useState(null);
    const [storageRepairLoading, setStorageRepairLoading] = useState(false);
    const [storageRepairResult, setStorageRepairResult] = useState(null);

    // Load proxy settings when modal opens
    useEffect(() => {
        if (!isOpen) return;
        setProxyTestResult(null);
        setProxySaveMsg(null);
        setStorageRepairResult(null);
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

    const handleStorageRepair = useCallback(async () => {
        setStorageRepairLoading(true);
        setStorageRepairResult(null);
        try {
            const res = await repairStoredCustomIntervals();
            setStorageRepairResult(res);
        } catch (err) {
            setStorageRepairResult({
                status: 'error',
                message: `修复失败: ${err.message}`,
                checked_series: 0,
                repaired_series: 0,
                unchanged_series: 0,
                failed_series: 1,
                total_deleted_rows: 0,
                total_written_rows: 0,
                total_stale_rows_removed: 0,
                results: [],
            });
        } finally {
            setStorageRepairLoading(false);
        }
    }, []);

    if (!isOpen) return null;

    const handleUpdate = (key, value) => {
        onUpdate({ ...settings, [key]: value });
    };

    const getRepairResultClassName = (status) => {
        if (status === 'ok') return 'repair-result-ok';
        if (status === 'partial' || status === 'warning') return 'repair-result-warn';
        return 'repair-result-fail';
    };

    const getRepairStatusLabel = (status) => {
        if (status === 'repaired') return '已修复';
        if (status === 'failed') return '失败';
        return '通过';
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>界面设置</h3>
                    <button className="close-btn" onClick={onClose}>&times;</button>
                </div>

                <div className="modal-body">
                    {/* 1. 主题选择 */}
                    <section className="settings-section">
                        <label>视觉主题</label>
                        <div className="theme-grid">
                            <button
                                className={`theme-opt ${settings.theme === 'dark' ? 'active' : ''}`}
                                onClick={() => handleUpdate('theme', 'dark')}
                            >
                                🌙 深色
                            </button>
                            <button
                                className={`theme-opt ${settings.theme === 'light' ? 'active' : ''}`}
                                onClick={() => handleUpdate('theme', 'light')}
                            >
                                ☀️ 亮色
                            </button>
                            <button
                                className={`theme-opt ${settings.theme === 'custom' ? 'active' : ''}`}
                                onClick={() => handleUpdate('theme', 'custom')}
                            >
                                🎨 自定义
                            </button>
                        </div>
                    </section>

                    {/* 2. 背景色自定义 (仅自定义主题显示) */}
                    {settings.theme === 'custom' && (
                        <section className="settings-section">
                            <label>自定义背景色</label>
                            <div className="color-picker-row">
                                <input
                                    type="color"
                                    value={settings.customBg}
                                    onChange={(e) => handleUpdate('customBg', e.target.value)}
                                />
                                <span className="color-code">{settings.customBg}</span>
                            </div>
                        </section>
                    )}

                    {/* 3. K线颜色设置 */}
                    <section className="settings-section">
                        <label>涨跌颜色方案</label>
                        <div className="preset-row">
                            <button
                                className="preset-btn"
                                onClick={() => onUpdate({ ...settings, upColor: '#22c55e', downColor: '#ef4444' })}
                            >
                                <span style={{ color: '#22c55e' }}>绿涨</span><span style={{ color: '#ef4444' }}>红跌</span>
                            </button>
                            <button
                                className="preset-btn"
                                onClick={() => onUpdate({ ...settings, upColor: '#ef4444', downColor: '#22c55e' })}
                            >
                                <span style={{ color: '#ef4444' }}>红涨</span><span style={{ color: '#22c55e' }}>绿跌</span>
                            </button>
                        </div>

                        <div className="custom-colors">
                            <div className="color-item">
                                <span>上涨颜色</span>
                                <input
                                    type="color"
                                    value={settings.upColor}
                                    onChange={(e) => handleUpdate('upColor', e.target.value)}
                                />
                            </div>
                            <div className="color-item">
                                <span>下跌颜色</span>
                                <input
                                    type="color"
                                    value={settings.downColor}
                                    onChange={(e) => handleUpdate('downColor', e.target.value)}
                                />
                            </div>
                        </div>
                    </section>
                    {/* 4. 网络代理设置 */}
                    <section className="settings-section">
                        <label>🌐 网络代理</label>
                        <div className="proxy-mode-grid">
                            <button
                                className={`theme-opt ${proxyMode === 'system' ? 'active' : ''}`}
                                onClick={() => { setProxyMode('system'); setProxyTestResult(null); setProxySaveMsg(null); }}
                            >
                                🖥️ 系统代理
                            </button>
                            <button
                                className={`theme-opt ${proxyMode === 'custom' ? 'active' : ''}`}
                                onClick={() => { setProxyMode('custom'); setProxyTestResult(null); setProxySaveMsg(null); }}
                            >
                                ⚙️ 自定义
                            </button>
                            <button
                                className={`theme-opt ${proxyMode === 'none' ? 'active' : ''}`}
                                onClick={() => { setProxyMode('none'); setProxyTestResult(null); setProxySaveMsg(null); }}
                            >
                                🚫 不使用
                            </button>
                        </div>

                        {proxyMode === 'system' && systemProxy && (
                            <div className="proxy-info">
                                <span className="proxy-info-label">检测到系统代理:</span>
                                <code className="proxy-info-value">{systemProxy}</code>
                            </div>
                        )}
                        {proxyMode === 'system' && !systemProxy && (
                            <div className="proxy-info proxy-info-warn">
                                <span>未检测到系统代理环境变量，将直连</span>
                            </div>
                        )}

                        {proxyMode === 'custom' && (
                            <div className="proxy-custom-input">
                                <input
                                    type="text"
                                    className="proxy-input"
                                    placeholder="http://127.0.0.1:7890 或 socks5://..."
                                    value={customProxy}
                                    onChange={(e) => { setCustomProxy(e.target.value); setProxySaveMsg(null); }}
                                />
                            </div>
                        )}

                        {effectiveProxy && proxyMode !== 'none' && (
                            <div className="proxy-info">
                                <span className="proxy-info-label">当前生效:</span>
                                <code className="proxy-info-value">{effectiveProxy}</code>
                            </div>
                        )}

                        <div className="proxy-actions">
                            <button
                                className="proxy-test-btn"
                                onClick={handleProxyTest}
                                disabled={proxyLoading}
                            >
                                {proxyLoading ? '⏳ 测试中...' : '🔍 测试连接'}
                            </button>
                            <button
                                className="proxy-save-btn"
                                onClick={handleProxySave}
                                disabled={proxyLoading}
                            >
                                {proxyLoading ? '⏳ ...' : '💾 保存代理'}
                            </button>
                        </div>

                        {proxyTestResult && (
                            <div className={`proxy-result ${proxyTestResult.success ? 'proxy-result-ok' : 'proxy-result-fail'}`}>
                                <span>{proxyTestResult.success ? '✅' : '❌'} {proxyTestResult.message}</span>
                                {proxyTestResult.proxy_used && (
                                    <div className="proxy-result-detail">代理: {proxyTestResult.proxy_used}</div>
                                )}
                            </div>
                        )}

                        {proxySaveMsg && (
                            <div className={`proxy-result ${proxySaveMsg.ok ? 'proxy-result-ok' : 'proxy-result-fail'}`}>
                                <span>{proxySaveMsg.text}</span>
                            </div>
                        )}
                    </section>

                    {/* 5. 时区设置 */}
                    <section className="settings-section">
                        <label>显示时区</label>
                        <select
                            className="timezone-select"
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
                    </section>

                    {/* 6. 数据库存储修复 */}
                    <section className="settings-section">
                        <label>🛠️ 库检查与修正</label>
                        <div className="repair-card">
                            <div className="repair-title">自定义周期落库修复</div>
                            <div className="repair-desc">
                                检查数据库里已存在的自定义周期 K 线，并按基础周期的 authoritative 聚合逻辑重建错误数据。
                                原生周期不会被改动。
                            </div>
                            <div className="repair-note">
                                如果基础周期本身有缺口，后端会先尝试自动回补，再决定是否回写 custom rows。
                            </div>
                            <button
                                className="repair-btn"
                                onClick={handleStorageRepair}
                                disabled={storageRepairLoading}
                            >
                                {storageRepairLoading ? '⏳ 检查中...' : '检查并修正库内容'}
                            </button>
                        </div>

                        {storageRepairResult && (
                            <div className={`repair-result ${getRepairResultClassName(storageRepairResult.status)}`}>
                                <div className="repair-result-head">{storageRepairResult.message}</div>
                                <div className="repair-stats">
                                    <span>检查 {storageRepairResult.checked_series || 0}</span>
                                    <span>修复 {storageRepairResult.repaired_series || 0}</span>
                                    <span>通过 {storageRepairResult.unchanged_series || 0}</span>
                                    <span>失败 {storageRepairResult.failed_series || 0}</span>
                                    <span>删库 {storageRepairResult.total_deleted_rows || 0}</span>
                                    <span>回写 {storageRepairResult.total_written_rows || 0}</span>
                                </div>

                                {Array.isArray(storageRepairResult.results) && storageRepairResult.results.length > 0 && (
                                    <div className="repair-series-list">
                                        {storageRepairResult.results.slice(0, 6).map((item) => (
                                            <div
                                                key={`${item.symbol}-${item.interval}`}
                                                className="repair-series-item"
                                            >
                                                <div className="repair-series-line">
                                                    <span className="repair-series-name">{item.symbol} · {item.interval}</span>
                                                    <span className={`repair-series-status repair-series-status-${item.status}`}>
                                                        {getRepairStatusLabel(item.status)}
                                                    </span>
                                                </div>
                                                <div className="repair-series-msg">{item.message}</div>
                                            </div>
                                        ))}
                                        {storageRepairResult.results.length > 6 && (
                                            <div className="repair-series-more">
                                                其余 {storageRepairResult.results.length - 6} 项结果已省略
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </section>
                </div>

                <div className="modal-footer">
                    <button className="primary-btn" onClick={onClose}>保存并关闭</button>
                </div>
            </div>

            <style jsx>{`
        .modal-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000;
          backdrop-filter: blur(4px);
        }
        .modal-content {
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          width: 90%; max-width: 480px;
          max-height: 85vh;
          overflow-y: auto;
          box-shadow: 0 20px 40px rgba(0,0,0,0.4);
        }
        .modal-header {
          padding: 16px; border-bottom: 1px solid var(--border-color);
          display: flex; justify-content: space-between; align-items: center;
        }
        .close-btn { 
          background: none; border: none; color: var(--text-secondary); 
          font-size: 24px; cursor: pointer; 
        }
        .modal-body { padding: 20px; }
        .settings-section { margin-bottom: 24px; }
        .settings-section label { 
          display: block; margin-bottom: 12px; font-size: 13px; 
          color: var(--text-muted); font-weight: 500;
        }
        .theme-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .theme-opt {
          padding: 10px; border: 1px solid var(--border-color); background: var(--bg-tertiary);
          color: var(--text-primary); border-radius: 6px; cursor: pointer; font-size: 13px;
        }
        .theme-opt.active { border-color: var(--accent-blue); color: var(--accent-blue); background: rgba(59, 130, 246, 0.1); }
        .preset-row { display: flex; gap: 8px; margin-bottom: 16px; }
        .preset-btn {
          flex: 1; padding: 8px; border: 1px solid var(--border-color); 
          background: var(--bg-tertiary); border-radius: 6px; cursor: pointer;
          display: flex; gap: 8px; justify-content: center; font-weight: 600;
        }
        .custom-colors { display: flex; flex-direction: column; gap: 12px; }
        .color-item { display: flex; justify-content: space-between; align-items: center; }
        .color-picker-row { display: flex; align-items: center; gap: 12px; }
        .color-code { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
        input[type="color"] { 
          border: none; width: 32px; height: 32px; cursor: pointer; background: none;
        }
        .timezone-select {
          width: 100%; padding: 10px; border: 1px solid var(--border-color); 
          background: var(--bg-tertiary); color: var(--text-primary); border-radius: 6px; 
          cursor: pointer; outline: none;
        }
        .timezone-select:focus { border-color: var(--accent-blue); }
        .modal-footer { padding: 16px; border-top: 1px solid var(--border-color); text-align: right; }
        .primary-btn {
          background: var(--accent-blue); color: white; border: none;
          padding: 8px 24px; border-radius: 6px; font-weight: 600; cursor: pointer;
        }
        .primary-btn:hover { opacity: 0.9; }

        /* ── Proxy settings ─────────────────────── */
        .proxy-mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
        .proxy-info {
          margin: 8px 0; padding: 8px 12px; border-radius: 6px;
          background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2);
          font-size: 12px; color: var(--text-secondary);
          display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
        }
        .proxy-info-warn {
          background: rgba(234, 179, 8, 0.08); border-color: rgba(234, 179, 8, 0.3);
          color: #eab308;
        }
        .proxy-info-label { font-weight: 500; }
        .proxy-info-value {
          font-family: var(--font-mono); font-size: 11px;
          background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;
        }
        .proxy-custom-input { margin: 10px 0; }
        .proxy-input {
          width: 100%; padding: 10px 12px; border: 1px solid var(--border-color);
          background: var(--bg-tertiary); color: var(--text-primary); border-radius: 6px;
          font-family: var(--font-mono); font-size: 13px; outline: none;
          box-sizing: border-box;
        }
        .proxy-input:focus { border-color: var(--accent-blue); }
        .proxy-input::placeholder { color: var(--text-muted); font-family: inherit; }
        .proxy-actions { display: flex; gap: 8px; margin-top: 12px; }
        .proxy-test-btn, .proxy-save-btn {
          flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 13px;
          font-weight: 500; cursor: pointer; border: 1px solid var(--border-color);
          transition: all 0.15s;
        }
        .proxy-test-btn {
          background: var(--bg-tertiary); color: var(--text-primary);
        }
        .proxy-test-btn:hover:not(:disabled) { border-color: var(--accent-blue); color: var(--accent-blue); }
        .proxy-save-btn {
          background: var(--accent-blue); color: white; border-color: var(--accent-blue);
        }
        .proxy-save-btn:hover:not(:disabled) { opacity: 0.9; }
        .proxy-test-btn:disabled, .proxy-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .proxy-result {
          margin-top: 10px; padding: 10px 12px; border-radius: 6px;
          font-size: 12px; line-height: 1.5;
        }
        .proxy-result-ok {
          background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.3);
          color: #22c55e;
        }
        .proxy-result-fail {
          background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
        }
        .proxy-result-detail {
          margin-top: 4px; font-size: 11px; opacity: 0.8;
          font-family: var(--font-mono);
        }
        .repair-card {
          padding: 12px;
          border-radius: 8px;
          border: 1px solid var(--border-color);
          background: var(--bg-tertiary);
        }
        .repair-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .repair-desc {
          margin-top: 6px;
          font-size: 12px;
          line-height: 1.55;
          color: var(--text-secondary);
        }
        .repair-note {
          margin-top: 8px;
          font-size: 11px;
          line-height: 1.5;
          color: var(--text-muted);
        }
        .repair-btn {
          width: 100%;
          margin-top: 12px;
          padding: 9px 12px;
          border-radius: 6px;
          border: 1px solid rgba(245, 158, 11, 0.35);
          background: rgba(245, 158, 11, 0.12);
          color: #f59e0b;
          cursor: pointer;
          font-weight: 600;
          transition: all 0.15s;
        }
        .repair-btn:hover:not(:disabled) {
          background: rgba(245, 158, 11, 0.18);
          border-color: rgba(245, 158, 11, 0.55);
        }
        .repair-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .repair-result {
          margin-top: 12px;
          padding: 12px;
          border-radius: 8px;
          font-size: 12px;
          line-height: 1.5;
        }
        .repair-result-ok {
          background: rgba(34, 197, 94, 0.08);
          border: 1px solid rgba(34, 197, 94, 0.3);
          color: #22c55e;
        }
        .repair-result-warn {
          background: rgba(245, 158, 11, 0.08);
          border: 1px solid rgba(245, 158, 11, 0.28);
          color: #f59e0b;
        }
        .repair-result-fail {
          background: rgba(239, 68, 68, 0.08);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
        }
        .repair-result-head {
          font-weight: 600;
        }
        .repair-stats {
          margin-top: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 6px 12px;
          font-size: 11px;
        }
        .repair-series-list {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .repair-series-item {
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .repair-series-line {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .repair-series-name {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-primary);
        }
        .repair-series-status {
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 600;
          white-space: nowrap;
        }
        .repair-series-status-repaired {
          background: rgba(34, 197, 94, 0.12);
          color: #22c55e;
        }
        .repair-series-status-failed {
          background: rgba(239, 68, 68, 0.12);
          color: #ef4444;
        }
        .repair-series-status-checked {
          background: rgba(59, 130, 246, 0.12);
          color: var(--accent-blue);
        }
        .repair-series-msg {
          margin-top: 4px;
          color: var(--text-secondary);
          font-size: 11px;
        }
        .repair-series-more {
          margin-top: 4px;
          font-size: 11px;
          color: var(--text-muted);
        }
      `}</style>
        </div>
    );
}
