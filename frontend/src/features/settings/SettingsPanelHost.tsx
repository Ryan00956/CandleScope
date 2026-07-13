import AboutSettingsPanel from "./panels/AboutSettingsPanel.js";
import CacheDiagnosticsPanel from "./panels/CacheDiagnosticsPanel.js";
import CacheLimitsPanel from "./panels/CacheLimitsPanel.js";
import ChartAppearancePanel from "./panels/ChartAppearancePanel.js";
import DatabaseManagementPanel from "./panels/DatabaseManagementPanel.js";
import ExchangeSettingsPanel from "./panels/ExchangeSettingsPanel.js";
import ProxySettingsPanel from "./panels/ProxySettingsPanel.js";
import StorageMaintenancePanel from "./panels/StorageMaintenancePanel.js";
import type { SettingsCategory, SettingsPanelViewModel } from "./settingsTypes.js";

export interface SettingsPanelHostProps {
  activeCategory: SettingsCategory;
  panelModel: SettingsPanelViewModel;
}

export default function SettingsPanelHost({ activeCategory, panelModel }: SettingsPanelHostProps) {
  switch (activeCategory) {
    case "appearance":
      return <ChartAppearancePanel {...panelModel.appearance} />;
    case "network":
      return <ProxySettingsPanel {...panelModel.network} />;
    case "exchanges":
      return <ExchangeSettingsPanel {...panelModel.exchanges} />;
    case "data":
      return (
        <>
          <CacheDiagnosticsPanel {...panelModel.data.cacheDiagnostics} />
          <CacheLimitsPanel {...panelModel.data.cacheLimits} />
          <StorageMaintenancePanel {...panelModel.data.maintenance} />
        </>
      );
    case "database":
      return <DatabaseManagementPanel {...panelModel.database} />;
    case "about":
      return <AboutSettingsPanel />;
    default:
      return <ChartAppearancePanel {...panelModel.appearance} />;
  }
}
