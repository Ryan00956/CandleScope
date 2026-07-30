import type { JsonScalar, PluginFieldFormat } from "./pluginPlatformTypes.js";

export function formatPluginValue(value: JsonScalar | undefined, format: PluginFieldFormat): string {
  if (value === null || value === undefined) return "—";
  if (format === "boolean") return value === true ? "Yes" : "No";
  if (format === "timestamp" && typeof value === "number") {
    const milliseconds = value > 100_000_000_000 ? value : value * 1_000;
    return new Date(milliseconds).toLocaleString();
  }
  if (typeof value === "number" && format === "percent") return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  if (typeof value === "number" && format === "price") return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
  if (typeof value === "number" && format === "number") return value.toLocaleString();
  return String(value);
}
