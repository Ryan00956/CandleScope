import React, { useState } from 'react';
import SettingsPanelHost from './SettingsPanelHost';
import SettingsModalStyles from './SettingsModalStyles';
import { buildSettingsPanelViewModel } from './settingsPanelViewModel';
import { SETTINGS_CATEGORIES, resolveSettingsTab } from './settingsTabRegistry';
import { useSettingsRuntime } from './useSettingsRuntime';

export default function SettingsModal({
    isOpen,
    onClose,
    settings,
    onUpdate,
    currentSymbol = '',
    currentMarketType = 'spot',
    currentExchange = 'binance',
    watchlists = [],
}) {
    const [activeCategory, setActiveCategory] = useState('appearance');
  const settingsRuntime = useSettingsRuntime({
        isOpen,
    settings,
    onUpdate,
        currentSymbol,
        currentMarketType,
        currentExchange,
        watchlists,
    });
  const { view, actions } = settingsRuntime;

    if (!isOpen) return null;

    const panelModel = buildSettingsPanelViewModel({ view, actions });
    const activeCatObj = resolveSettingsTab(activeCategory);

    return (
        <div className="st-overlay" onClick={onClose}>
            <div className="st-panel" onClick={e => e.stopPropagation()}>
                {/* Sidebar */}
                <nav className="st-sidebar">
                    <div className="st-sidebar-title">设置</div>
                    <div className="st-sidebar-nav">
                        {SETTINGS_CATEGORIES.map(cat => (
                            <button
                                key={cat.key}
                                className={`st-nav-item ${activeCategory === cat.key ? 'active' : ''}`}
                                onClick={() => setActiveCategory(cat.key)}
                            >
                                <span className="st-nav-icon">{cat.icon}</span>
                                <span className="st-nav-label">{cat.label}</span>
                            </button>
                        ))}
                    </div>
                    <div className="st-sidebar-footer">
                        <button className="st-btn st-btn-primary st-btn-close" onClick={onClose}>
                            保存并关闭
                        </button>
                    </div>
                </nav>

                {/* Content */}
                <main className="st-content">
                    <div className="st-content-header">
                        <h2 className="st-content-title">
                            <span>{activeCatObj.icon}</span> {activeCatObj.label}
                        </h2>
                        <button className="st-close-x" onClick={onClose}>✕</button>
                    </div>
                    <div className="st-content-body">
                        <SettingsPanelHost activeCategory={activeCategory} panelModel={panelModel} />
                    </div>
                </main>
            </div>
            <SettingsModalStyles />
        </div>
    );
}
