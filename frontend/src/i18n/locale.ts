export const LOCALES = ["zh-CN", "en"] as const;
export type LocaleId = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: LocaleId = "zh-CN";

export const LOCALE_OPTIONS = [
  { id: "zh-CN", nativeLabel: "简体中文" },
  { id: "en", nativeLabel: "English" },
] as const satisfies readonly { id: LocaleId; nativeLabel: string }[];

const listeners = new Set<() => void>();
let current: LocaleId = DEFAULT_LOCALE;

export function isLocaleId(value: unknown): value is LocaleId {
  return value === "zh-CN" || value === "en";
}

export function normalizeLocale(value: unknown): LocaleId {
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const trimmed = value.trim();
  if (trimmed === "en" || trimmed.toLowerCase().startsWith("en-")) return "en";
  if (
    trimmed === "zh"
    || trimmed === "zh-CN"
    || trimmed.toLowerCase() === "zh-hans"
    || trimmed.toLowerCase().startsWith("zh-hans-")
  ) return "zh-CN";
  return DEFAULT_LOCALE;
}

function applyDocumentLang(locale: LocaleId): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

export function getLocale(): LocaleId {
  return current;
}

export function setLocale(value: unknown): LocaleId {
  const locale = normalizeLocale(value);
  const changed = locale !== current;
  current = locale;
  applyDocumentLang(locale);
  if (changed) {
    for (const listener of listeners) listener();
  }
  return locale;
}

export function hydrateLocale(value: unknown): LocaleId {
  return setLocale(value);
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
