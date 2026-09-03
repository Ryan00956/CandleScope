import { getLocale } from "./locale.js";
import { localeDefinition, type LocaleId } from "./registry.js";

export function getDateTimeLocale(locale: LocaleId = getLocale()): string {
  return localeDefinition(locale).dateTimeLocale ?? locale;
}

export function getNumberLocale(locale: LocaleId = getLocale()): string {
  return localeDefinition(locale).numberLocale ?? locale;
}
