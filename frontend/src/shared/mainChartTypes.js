export const DEFAULT_MAIN_CHART_TYPE = "candlestick";

export const MAIN_CHART_TYPES = Object.freeze([
  "candlestick",
  "hollow-candlestick",
  "heikin-ashi",
  "bar",
  "high-low",
  "line",
  "line-with-markers",
  "step-line",
  "area",
  "baseline",
  "histogram",
]);

const MAIN_CHART_SERIES_KINDS = Object.freeze({
  candlestick: "candlestick",
  "hollow-candlestick": "candlestick",
  "heikin-ashi": "candlestick",
  bar: "bar",
  "high-low": "high-low",
  line: "line",
  "line-with-markers": "line",
  "step-line": "line",
  area: "area",
  baseline: "baseline",
  histogram: "histogram",
});

const MAIN_CHART_TYPE_SET = new Set(MAIN_CHART_TYPES);

export function normalizeMainChartType(value) {
  return MAIN_CHART_TYPE_SET.has(value) ? value : DEFAULT_MAIN_CHART_TYPE;
}

export function mainChartSeriesKind(value) {
  return MAIN_CHART_SERIES_KINDS[normalizeMainChartType(value)];
}

export function isOhlcMainChartType(value) {
  const chartType = normalizeMainChartType(value);
  return chartType === "candlestick"
    || chartType === "hollow-candlestick"
    || chartType === "heikin-ashi"
    || chartType === "bar"
    || chartType === "high-low";
}
