import type {
  SettingsPanelViewModel,
  SettingsRuntimeActions,
  SettingsRuntimeView,
} from "./settingsTypes.js";

export function buildSettingsPanelViewModel({
  view,
  actions,
}: {
  view: SettingsRuntimeView;
  actions: SettingsRuntimeActions;
}): SettingsPanelViewModel {
  return {
    appearance: view.appearance,
    network: {
      ...view.proxy,
      ...actions.proxy,
    },
    exchanges: {
      ...view.exchanges,
      ...actions.exchanges,
    },
    data: {
      cacheLimits: {
        ...view.cacheLimits,
        ...actions.cacheLimits,
      },
      cacheDiagnostics: {
        ...view.cacheDiagnostics,
        ...actions.cacheDiagnostics,
      },
      maintenance: {
        ...view.maintenance,
        ...actions.maintenance,
      },
    },
    about: {},
  };
}
