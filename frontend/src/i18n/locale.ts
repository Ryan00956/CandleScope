import { DEFAULT_LOCALE, LOCALES, localeDefinition, type LocaleId } from "./registry.js";
import { resolveLocale } from "./localeResolution.js";

export { DEFAULT_LOCALE, LOCALES, LOCALE_OPTIONS, type LocaleId } from "./registry.js";

const registrations = LOCALES.map((id) => ({ id, aliases: localeDefinition(id).aliases ?? [] }));

const listeners = new Set<() => void>();
let current: LocaleId = DEFAULT_LOCALE;

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && LOCALES.some((locale) => locale === value);
}

export function normalizeLocale(value: unknown): LocaleId {
  return resolveLocale(value, registrations) ?? DEFAULT_LOCALE;
}

function applyDocumentLang(locale: LocaleId): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDefinition(locale).direction ?? "ltr";
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
