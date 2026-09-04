import { en } from "./catalogs/en.js";
import { es } from "./catalogs/es.js";
import { fr } from "./catalogs/fr.js";
import { ja } from "./catalogs/ja.js";
import { ko } from "./catalogs/ko.js";
import { ptBR } from "./catalogs/pt-BR.js";
import { ru } from "./catalogs/ru.js";
import { zhCN } from "./catalogs/zh-CN.js";
import type { MessageCatalog } from "./messageCatalog.js";

export interface LocaleDefinition {
  readonly nativeLabel: string;
  readonly aliases?: readonly string[];
  readonly dateTimeLocale?: string;
  readonly numberLocale?: string;
  readonly direction?: "ltr" | "rtl";
  readonly messages: MessageCatalog;
}

/** Add a complete catalog here to register a language throughout the Host. */
export const LOCALE_REGISTRY = {
  "zh-CN": {
    nativeLabel: "简体中文",
    aliases: ["zh", "zh-Hans"],
    messages: zhCN,
  },
  en: {
    nativeLabel: "English",
    dateTimeLocale: "en-GB",
    numberLocale: "en-US",
    messages: en,
  },
  es: {
    nativeLabel: "Español",
    dateTimeLocale: "es-ES",
    numberLocale: "es-ES",
    direction: "ltr",
    messages: es,
  },
  fr: {
    nativeLabel: "Français",
    dateTimeLocale: "fr-FR",
    numberLocale: "fr-FR",
    direction: "ltr",
    messages: fr,
  },
  ja: {
    nativeLabel: "日本語",
    aliases: ["ja-JP"],
    dateTimeLocale: "ja-JP",
    numberLocale: "ja-JP",
    direction: "ltr",
    messages: ja,
  },
  ko: {
    nativeLabel: "한국어",
    dateTimeLocale: "ko-KR",
    numberLocale: "ko-KR",
    direction: "ltr",
    messages: ko,
  },
  "pt-BR": {
    nativeLabel: "Português (Brasil)",
    dateTimeLocale: "pt-BR",
    numberLocale: "pt-BR",
    direction: "ltr",
    messages: ptBR,
  },
  ru: {
    nativeLabel: "Русский",
    aliases: ["ru-RU"],
    dateTimeLocale: "ru-RU",
    numberLocale: "ru-RU",
    direction: "ltr",
    messages: ru,
  },
} as const satisfies Readonly<Record<string, LocaleDefinition>>;

export type LocaleId = keyof typeof LOCALE_REGISTRY;
export const DEFAULT_LOCALE: LocaleId = "zh-CN";
export const LOCALES: readonly LocaleId[] = Object.freeze(Object.keys(LOCALE_REGISTRY) as LocaleId[]);
export const LOCALE_OPTIONS = Object.freeze(LOCALES.map((id) => ({
  id,
  nativeLabel: LOCALE_REGISTRY[id].nativeLabel,
})));

export function localeDefinition(locale: LocaleId): LocaleDefinition {
  return LOCALE_REGISTRY[locale];
}
