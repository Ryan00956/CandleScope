import { en } from "./catalogs/en.js";
import { zhCN } from "./catalogs/zh-CN.js";
import { zhTW } from "./catalogs/zh-TW.js";
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
  "zh-TW": {
    nativeLabel: "繁體中文",
    aliases: ["zh-Hant-TW"],
    dateTimeLocale: "zh-TW",
    numberLocale: "zh-TW",
    direction: "ltr",
    messages: zhTW,
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
