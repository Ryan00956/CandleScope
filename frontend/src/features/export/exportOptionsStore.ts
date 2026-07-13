import { normalizeExportOptions } from "./exportService.js";
import type { ExportOptions } from "./exportTypes.js";

const EXPORT_OPTIONS_PREF_KEY = "chartExportOptions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadExportOptions(
  loadUserPrefs?: (() => unknown) | null,
): ExportOptions {
  const prefs = typeof loadUserPrefs === "function" ? loadUserPrefs() : null;
  const stored = isRecord(prefs) ? prefs[EXPORT_OPTIONS_PREF_KEY] : null;
  return normalizeExportOptions(stored);
}

export function saveExportOptions(
  updateUserPref: ((key: string, value: ExportOptions) => void) | null | undefined,
  options: ExportOptions,
): void {
  if (typeof updateUserPref === "function") {
    updateUserPref(EXPORT_OPTIONS_PREF_KEY, options);
  }
}
