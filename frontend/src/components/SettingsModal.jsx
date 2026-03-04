import React, { useState } from 'react';

export default function SettingsModal({ isOpen, onClose, settings, onUpdate }) {
    if (!isOpen) return null;

    const handleUpdate = (key, value) => {
        onUpdate({ ...settings, [key]: value });
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
                    {/* 4. 时区设置 */}
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
          width: 90%; max-width: 400px;
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
      `}</style>
        </div>
    );
}
