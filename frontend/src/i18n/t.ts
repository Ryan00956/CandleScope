import { zhCN, type MessageKey } from "./catalogs/zh-CN.js";
import { getLocale, type LocaleId } from "./locale.js";
import { localeDefinition } from "./registry.js";
import { formatCatalogMessage, formatCatalogPlural } from "./messageFormat.js";
import type { PluralMessageKey } from "./messageCatalog.js";

export type { MessageKey };

export function messageKeys(): readonly MessageKey[] {
  return Object.keys(zhCN) as MessageKey[];
}

export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(zhCN, key);
}

export function t(
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
  locale: LocaleId = getLocale(),
): string {
  return formatCatalogMessage(localeDefinition(locale).messages, key, vars);
}

export function tKey(
  key: string,
  vars?: Readonly<Record<string, string | number>>,
  locale: LocaleId = getLocale(),
): string {
  return hasMessage(key) ? t(key, vars, locale) : key;
}

export function tPlural(
  key: PluralMessageKey,
  count: number,
  vars?: Readonly<Record<string, string | number>>,
  locale: LocaleId = getLocale(),
): string {
  return formatCatalogPlural(localeDefinition(locale).messages, locale, key, count, vars);
}

const WS_STATUS_KEYS = {
  idle: "status.ws.idle",
  loading: "status.ws.loading",
  connecting: "status.ws.connecting",
  live: "status.ws.live",
  reconnecting: "status.ws.reconnecting",
  disconnected: "status.ws.disconnected",
  fallback: "status.ws.fallback",
  mock: "status.ws.mock",
} as const satisfies Record<string, MessageKey>;

export function translateWsStatus(status: string, locale: LocaleId = getLocale()): string {
  const key = Object.prototype.hasOwnProperty.call(WS_STATUS_KEYS, status)
    ? WS_STATUS_KEYS[status as keyof typeof WS_STATUS_KEYS]
    : "status.ws.unknown";
  return t(key, {}, locale);
}

export function translateMarketType(marketType: string, locale: LocaleId = getLocale()): string {
  if (marketType === "spot") return t("market.spot", {}, locale);
  if (marketType === "futures") return t("market.futures", {}, locale);
  if (marketType === "swap") return t("market.swap", {}, locale);
  return marketType;
}

export function translateExchangeName(exchange: string, locale: LocaleId = getLocale()): string {
  if (exchange === "binance") return t("exchange.binance", {}, locale);
  if (exchange === "okx") return "OKX";
  if (!exchange) return exchange;
  return exchange.charAt(0).toUpperCase() + exchange.slice(1);
}
