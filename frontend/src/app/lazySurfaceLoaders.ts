export function loadSettingsModal(): Promise<typeof import("../features/settings/SettingsModal")> {
  return import("../features/settings/SettingsModal");
}

export function loadIndicatorPanel(): Promise<typeof import("../features/indicators/IndicatorPanel")> {
  return import("../features/indicators/IndicatorPanel");
}

export function loadAlertsPanel(): Promise<typeof import("../components/alerts/AlertsPanel")> {
  return import("../components/alerts/AlertsPanel");
}
