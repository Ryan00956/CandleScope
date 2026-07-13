import { normalizeExportOptions } from "./exportService.js";

const EXPORT_OPTIONS_PREF_KEY = "chartExportOptions";

export function loadExportOptions(loadUserPrefs) {
  const prefs = typeof loadUserPrefs === "function" ? loadUserPrefs() : null;
  return normalizeExportOptions(prefs?.[EXPORT_OPTIONS_PREF_KEY] || {});
}

export function saveExportOptions(updateUserPref, options) {
  if (typeof updateUserPref === "function") {
    updateUserPref(EXPORT_OPTIONS_PREF_KEY, options);
  }
}
