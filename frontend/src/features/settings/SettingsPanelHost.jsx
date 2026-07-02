import AboutSettingsPanel from "./panels/AboutSettingsPanel";
import CacheDiagnosticsPanel from "./panels/CacheDiagnosticsPanel";
import CacheLimitsPanel from "./panels/CacheLimitsPanel";
import ChartAppearancePanel from "./panels/ChartAppearancePanel";
import DatabaseManagementPanel from "./panels/DatabaseManagementPanel";
import ExchangeSettingsPanel from "./panels/ExchangeSettingsPanel";
import ProxySettingsPanel from "./panels/ProxySettingsPanel";
import StorageMaintenancePanel from "./panels/StorageMaintenancePanel";

export default function SettingsPanelHost({ activeCategory, panelModel }) {
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
