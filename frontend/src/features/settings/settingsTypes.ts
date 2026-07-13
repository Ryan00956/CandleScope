export type SettingsActionType = "mock" | "local_only" | "backend_endpoint";

import type { AboutSettingsPanelProps } from "../../components/settings/AboutSettingsPanel.js";
import type { CacheDiagnosticsPanelProps } from "../../components/settings/CacheDiagnosticsPanel.js";
import type { CacheLimitsPanelProps } from "../../components/settings/CacheLimitsPanel.js";
import type { ChartAppearancePanelProps } from "../../components/settings/ChartAppearancePanel.js";
import type { DatabaseManagementPanelProps } from "../../components/settings/DatabaseManagementPanel.js";
import type { ExchangeSettingsPanelProps } from "../../components/settings/ExchangeSettingsPanel.js";
import type { ProxySettingsPanelProps } from "../../components/settings/ProxySettingsPanel.js";
import type { StorageMaintenancePanelProps } from "../../components/settings/StorageMaintenancePanel.js";

export type SettingsCategory =
  | "appearance"
  | "network"
  | "exchanges"
  | "data"
  | "database"
  | "about";

export interface SettingsActionDescriptor {
  type: SettingsActionType;
  label: string;
  description: string;
}

export interface SettingsCategoryDescriptor {
  key: SettingsCategory;
  label: string;
  icon: string;
}

export interface SettingsRuntimeView {
  appearance: ChartAppearancePanelProps;
  proxy: Omit<ProxySettingsPanelProps,
    "onProxyModeChange" | "onCustomProxyChange" | "onProxyTest" | "onProxySave">;
  exchanges: Omit<ExchangeSettingsPanelProps, "onRefreshExchanges">;
  cacheLimits: Omit<CacheLimitsPanelProps, "onToggleAdvanced">;
  cacheDiagnostics: CacheDiagnosticsPanelProps;
  maintenance: Omit<StorageMaintenancePanelProps,
    "onStorageRepair" | "onGapScan" | "onExchangeRefresh">;
  database: DatabaseManagementPanelProps;
}

export interface SettingsRuntimeActions {
  proxy: Pick<ProxySettingsPanelProps,
    "onProxyModeChange" | "onCustomProxyChange" | "onProxyTest" | "onProxySave">;
  exchanges: Pick<ExchangeSettingsPanelProps, "onRefreshExchanges">;
  cacheLimits: Pick<CacheLimitsPanelProps, "onToggleAdvanced">;
  cacheDiagnostics: Pick<CacheDiagnosticsPanelProps,
    | "onPlanBackendMemoryGc"
    | "onPlanFrontendGc"
    | "onPlanStorageGc"
    | "onRunBackendMemoryGc"
    | "onRunFrontendGc"
    | "onRunStorageGc"
    | "onRefresh"
    | "onVacuumStorage">;
  maintenance: Pick<StorageMaintenancePanelProps,
    "onStorageRepair" | "onGapScan" | "onExchangeRefresh">;
}

export interface SettingsPanelViewModel {
  appearance: ChartAppearancePanelProps;
  network: ProxySettingsPanelProps;
  exchanges: ExchangeSettingsPanelProps;
  data: {
    cacheLimits: CacheLimitsPanelProps;
    cacheDiagnostics: CacheDiagnosticsPanelProps;
    maintenance: StorageMaintenancePanelProps;
  };
  database: DatabaseManagementPanelProps;
  about: AboutSettingsPanelProps;
}
