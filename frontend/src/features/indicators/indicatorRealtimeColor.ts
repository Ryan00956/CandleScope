import type { KlineBar } from "../market-data/marketDataTypes.js";
import { getBuiltinIndicatorName } from "./indicatorPayloadRuntime.js";
import type { IndicatorDefinition, IndicatorLine } from "./indicatorTypes.js";

interface RealtimeHistogramColorOptions {
  bar: KlineBar | null | undefined;
  downColor: string;
  indicator: IndicatorDefinition;
  line: IndicatorLine;
  upColor: string;
  value: unknown;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function colorParam(
  indicator: IndicatorDefinition,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = indicator.params?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function resolveRealtimeHistogramColor({
  bar,
  downColor,
  indicator,
  line,
  upColor,
  value,
}: RealtimeHistogramColorOptions): string | undefined {
  if (line.type !== "histogram") return undefined;

  const builtinName = getBuiltinIndicatorName(indicator).trim().toUpperCase();
  const resolvedUpColor = colorParam(indicator, ["hist_up_color", "up_color"])
    || line.color
    || upColor;
  const resolvedDownColor = colorParam(indicator, ["hist_down_color", "down_color"])
    || downColor;

  if (builtinName === "VOL" || line.pane === "volume") {
    const open = finiteNumber(bar?.open);
    const close = finiteNumber(bar?.close);
    if (open == null || close == null) return undefined;
    return close >= open ? resolvedUpColor : resolvedDownColor;
  }

  const numericValue = finiteNumber(value);
  if (numericValue == null) return undefined;
  return numericValue >= 0 ? resolvedUpColor : resolvedDownColor;
}
