import { SETTINGS_CATEGORIES } from "./useSettingsRuntime";

export { SETTINGS_CATEGORIES };

export function resolveSettingsTab(categoryKey) {
  return SETTINGS_CATEGORIES.find((category) => category.key === categoryKey) || SETTINGS_CATEGORIES[0];
}
