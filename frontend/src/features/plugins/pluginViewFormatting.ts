import type { JsonScalar, PluginFieldFormat } from "./pluginPlatformTypes.js";
import { getLocale, t, type LocaleId } from "../../i18n/index.js";

export function formatPluginValue(
  value: JsonScalar | undefined,
  format: PluginFieldFormat,
  locale: LocaleId = getLocale(),
): string {
  if (value === null || value === undefined) return "—";
  if (format === "boolean") return t(value === true ? "plugin.host.booleanYes" : "plugin.host.booleanNo", {}, locale);
  if (format === "timestamp" && typeof value === "number") {
    const milliseconds = value > 100_000_000_000 ? value : value * 1_000;
    return new Date(milliseconds).toLocaleString(locale === "en" ? "en-GB" : "zh-CN");
  }
  if (typeof value === "number" && format === "percent") return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  if (typeof value === "number" && format === "price") return value.toLocaleString(locale, { maximumFractionDigits: 8 });
  if (typeof value === "number" && format === "number") return value.toLocaleString(locale);
  return String(value);
}
