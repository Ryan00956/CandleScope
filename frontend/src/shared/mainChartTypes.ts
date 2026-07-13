export const MAIN_CHART_TYPES = Object.freeze([
  "candlestick",
  "hollow-candlestick",
  "heikin-ashi",
  "renko",
  "point-and-figure",
  "kagi",
  "line-break",
  "bar",
  "high-low",
  "line",
  "line-with-markers",
  "step-line",
  "area",
  "baseline",
  "histogram",
] as const);

export type MainChartType = (typeof MAIN_CHART_TYPES)[number];

export const DEFAULT_MAIN_CHART_TYPE: MainChartType = "candlestick";

const MAIN_CHART_TYPE_SET: ReadonlySet<string> = new Set(MAIN_CHART_TYPES);

function isMainChartType(value: unknown): value is MainChartType {
  return typeof value === "string" && MAIN_CHART_TYPE_SET.has(value);
}

export function normalizeMainChartType(value: unknown): MainChartType {
  return isMainChartType(value) ? value : DEFAULT_MAIN_CHART_TYPE;
}

export function isOhlcMainChartType(value: unknown): boolean {
  const chartType = normalizeMainChartType(value);
  return chartType === "candlestick"
    || chartType === "hollow-candlestick"
    || chartType === "heikin-ashi"
    || chartType === "renko"
    || chartType === "point-and-figure"
    || chartType === "kagi"
    || chartType === "line-break"
    || chartType === "bar"
    || chartType === "high-low";
}
