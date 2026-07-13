import type {
  SettingsCategory,
  SettingsCategoryDescriptor,
} from "./settingsTypes.js";

export const SETTINGS_CATEGORIES = [
  { key: "appearance", label: "外观显示", icon: "🎨" },
  { key: "network", label: "网络连接", icon: "🌐" },
  { key: "exchanges", label: "交易所", icon: "🏦" },
  { key: "data", label: "数据管理", icon: "💾" },
  { key: "database", label: "数据库工具", icon: "🗄️" },
  { key: "about", label: "关于", icon: "ℹ️" },
] as const satisfies readonly SettingsCategoryDescriptor[];

export function resolveSettingsTab(
  categoryKey: SettingsCategory | string,
): (typeof SETTINGS_CATEGORIES)[number] {
  return SETTINGS_CATEGORIES.find((category) => category.key === categoryKey) || SETTINGS_CATEGORIES[0];
}
