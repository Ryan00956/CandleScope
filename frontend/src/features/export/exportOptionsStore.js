import { DEFAULT_EXPORT_OPTIONS } from "./exportService";

const EXPORT_OPTIONS_PREF_KEY = "chartExportOptions";

export function loadExportOptions(loadUserPrefs) {
  const prefs = typeof loadUserPrefs === "function" ? loadUserPrefs() : null;
  return {
    ...DEFAULT_EXPORT_OPTIONS,
    ...(prefs?.[EXPORT_OPTIONS_PREF_KEY] || {}),
  };
}

export function saveExportOptions(updateUserPref, options) {
  if (typeof updateUserPref === "function") {
    updateUserPref(EXPORT_OPTIONS_PREF_KEY, options);
  }
}