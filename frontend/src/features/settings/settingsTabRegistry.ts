import type {
  SettingsCategory,
  SettingsCategoryDescriptor,
} from "./settingsTypes.js";

export const SETTINGS_CATEGORIES = [
  { key: "appearance", labelKey: "settings.category.appearance", icon: "🎨" },
  { key: "network", labelKey: "settings.category.network", icon: "🌐" },
  { key: "exchanges", labelKey: "settings.category.exchanges", icon: "🏦" },
  { key: "data", labelKey: "settings.category.data", icon: "💾" },
  { key: "plugins", labelKey: "settings.category.plugins", icon: "" },
  { key: "about", labelKey: "settings.category.about", icon: "ℹ️" },
] as const satisfies readonly SettingsCategoryDescriptor[];

export function resolveSettingsTab(
  categoryKey: SettingsCategory | string,
): (typeof SETTINGS_CATEGORIES)[number] {
  return SETTINGS_CATEGORIES.find((category) => category.key === categoryKey) || SETTINGS_CATEGORIES[0];
}
