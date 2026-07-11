export const DEFAULT_MAIN_CHART_TYPE = "candlestick";

export const MAIN_CHART_TYPES = Object.freeze([
  "candlestick",
  "bar",
  "line",
  "area",
  "baseline",
  "histogram",
]);

const MAIN_CHART_TYPE_SET = new Set(MAIN_CHART_TYPES);

export function normalizeMainChartType(value) {
  return MAIN_CHART_TYPE_SET.has(value) ? value : DEFAULT_MAIN_CHART_TYPE;
}

export function isOhlcMainChartType(value) {
  const chartType = normalizeMainChartType(value);
  return chartType === "candlestick" || chartType === "bar";
}
