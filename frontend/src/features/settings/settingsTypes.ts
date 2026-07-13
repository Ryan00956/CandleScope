export type SettingsActionType = "mock" | "local_only" | "backend_endpoint";

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

type SettingsPanelFields = Record<string, unknown>;

export interface SettingsRuntimeView {
  appearance: SettingsPanelFields;
  proxy: SettingsPanelFields;
  exchanges: SettingsPanelFields;
  cacheLimits: SettingsPanelFields;
  cacheDiagnostics: SettingsPanelFields;
  maintenance: SettingsPanelFields;
  database: SettingsPanelFields;
}

export interface SettingsRuntimeActions {
  proxy: SettingsPanelFields;
  exchanges: SettingsPanelFields;
  cacheLimits: SettingsPanelFields;
  cacheDiagnostics: SettingsPanelFields;
  maintenance: SettingsPanelFields;
}

export interface SettingsPanelViewModel {
  appearance: SettingsPanelFields;
  network: SettingsPanelFields;
  exchanges: SettingsPanelFields;
  data: {
    cacheLimits: SettingsPanelFields;
    cacheDiagnostics: SettingsPanelFields;
    maintenance: SettingsPanelFields;
  };
  database: SettingsPanelFields;
  about: SettingsPanelFields;
}
