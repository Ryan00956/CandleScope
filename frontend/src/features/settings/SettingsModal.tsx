import { useState } from 'react';
import DataWorkbenchModal from '../data-workbench/DataWorkbenchModal.js';
import SettingsPanelHost from './SettingsPanelHost.js';
import SettingsModalStyles from './SettingsModalStyles.js';
import { buildSettingsPanelViewModel } from './settingsPanelViewModel.js';
import { SETTINGS_CATEGORIES, resolveSettingsTab } from './settingsTabRegistry.js';
import { useSettingsRuntime } from './useSettingsRuntime.js';
import type { MouseEvent } from 'react';
import type { PluginPlatformRuntime } from '../plugins/pluginPlatformTypes.js';
import type { SettingsCategory } from './settingsTypes.js';
import type { UseSettingsRuntimeOptions } from './useSettingsRuntime.js';

export interface SettingsModalProps extends UseSettingsRuntimeOptions {
    plugins?: PluginPlatformRuntime;
    onClose(): void;
}

export default function SettingsModal({
    isOpen,
    onClose,
    plugins,
    settings,
    onUpdate,
    currentSymbol = '',
    currentMarketType = 'spot',
    currentExchange = 'binance',
    watchlists = [],
    chartDataCacheDiagnostics = null,
    trimChartDataCacheEntries = null,
}: SettingsModalProps) {
    const [activeCategory, setActiveCategory] = useState<SettingsCategory>('appearance');
    const [dataWorkbenchOpen, setDataWorkbenchOpen] = useState(false);
  const settingsRuntime = useSettingsRuntime({
        isOpen,
    settings,
    onUpdate,
        currentSymbol,
        currentMarketType,
        currentExchange,
        watchlists,
        chartDataCacheDiagnostics,
        trimChartDataCacheEntries,
    });
  const { view, actions } = settingsRuntime;

    if (!isOpen) return null;

    const panelModel = buildSettingsPanelViewModel({ view, actions });
    const activeCatObj = resolveSettingsTab(activeCategory);

    return (
      <>
        <div className="st-overlay" onClick={onClose}>
            <div className="st-panel" onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}>
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
                                <span className="st-nav-icon" aria-hidden="true">{cat.icon}</span>
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
                            {activeCatObj.icon && <span>{activeCatObj.icon}</span>}
                            {activeCatObj.label}
                        </h2>
                        <button className="st-close-x" aria-label="关闭设置" onClick={onClose}>✕</button>
                    </div>
                    <div className="st-content-body">
                        <SettingsPanelHost
                            activeCategory={activeCategory}
                            onOpenDataWorkbench={() => setDataWorkbenchOpen(true)}
                            panelModel={panelModel}
                            plugins={plugins}
                        />
                    </div>
                </main>
            </div>
            <SettingsModalStyles />
        </div>
        <DataWorkbenchModal
            currentExchange={currentExchange}
            currentMarketType={currentMarketType}
            currentSymbol={currentSymbol}
            isOpen={dataWorkbenchOpen}
            onClose={() => setDataWorkbenchOpen(false)}
        />
      </>
    );
}
