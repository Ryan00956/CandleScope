import type {
  ScriptLanguageDescriptor,
  ScriptRuntimeCatalog,
  ScriptRuntimeDescriptor,
} from "./indicatorTypes.js";

export interface ScriptEditorProfile {
  monacoLanguage: string;
  theme: string;
  starterSource: string;
  pyneEnhancements: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function runtimeForScriptLanguage(
  catalog: ScriptRuntimeCatalog,
  language: ScriptLanguageDescriptor,
): ScriptRuntimeDescriptor | null {
  if (language.runtimeId === null) return null;
  return catalog.runtimes.find((runtime) => runtime.id === language.runtimeId) ?? null;
}

export function resolveAvailableScriptLanguage(
  catalog: ScriptRuntimeCatalog,
  requestedLanguage?: string | null,
): ScriptLanguageDescriptor | null {
  const requested = requestedLanguage?.trim();
  if (requested) {
    const match = catalog.languages.find(
      (language) => language.id === requested && language.available,
    );
    if (match) return match;
  }
  return catalog.languages.find(
    (language) => language.id === catalog.defaultLanguage && language.available,
  ) ?? catalog.languages.find((language) => language.available) ?? null;
}

function descriptorUiProfile(
  runtime: ScriptRuntimeDescriptor | null,
  languageId: string,
): Record<string, unknown> | null {
  if (!runtime) return null;
  const ui = runtime.meta.ui;
  if (!isRecord(ui) || !isRecord(ui.languages)) return null;
  const profile = ui.languages[languageId];
  return isRecord(profile) ? profile : null;
}

export function resolveScriptEditorProfile(
  catalog: ScriptRuntimeCatalog,
  language: ScriptLanguageDescriptor,
): ScriptEditorProfile {
  const runtime = runtimeForScriptLanguage(catalog, language);
  const advertised = descriptorUiProfile(runtime, language.id);
  const pyneEnhancements = language.id === "pyne";
  return {
    monacoLanguage:
      optionalString(advertised?.monacoLanguage)
      ?? (pyneEnhancements ? "python" : "plaintext"),
    theme: pyneEnhancements ? "pyne-dark" : "vs-dark",
    starterSource: optionalString(advertised?.starterSource) ?? "",
    pyneEnhancements,
  };
}
