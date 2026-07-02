import {
  formatIndicatorError,
  isProvisionalChartData,
  normalizeIndicatorPayload,
  normalizeParamSchema,
  stringSignature,
} from "./indicatorPayloadRuntime.js";

export const INDICATOR_DATA_DEBOUNCE_MS = 500;
export const PROVISIONAL_INDICATOR_DELAY_MS = 1200;
export const SERIES_READY_COMPUTE_DELAY_MS = 50;

export function buildCandleColorKey(candleUpColor, candleDownColor) {
  return `${candleUpColor}|${candleDownColor}`;
}

export function buildIndicatorMutationSignature(indicators = []) {
  return indicators
    .map((indicator) => (
      `${indicator.id}:${stringSignature(indicator.script || "")}:${JSON.stringify(indicator.params || {})}`
    ))
    .join("|");
}

export function buildIndicatorOhlcv(chartData = []) {
  return chartData.map((bar) => ({
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume || 0,
  }));
}

export function buildIndicatorComputeParams(indicator, { candleUpColor, candleDownColor } = {}) {
  const params = indicator.params || {};
  if (
    (indicator.id !== "vol" && indicator.engineName !== "VOL")
    || (!candleUpColor && !candleDownColor)
  ) {
    return params;
  }

  return {
    ...params,
    up_color: candleUpColor || params.up_color || "#22c55e",
    down_color: candleDownColor || params.down_color || "#ef4444",
  };
}

export function hasVolumeIndicator(indicators = []) {
  return indicators.some((indicator) => indicator.id === "vol" || indicator.engineName === "VOL");
}

export function resolveIndicatorComputeDelay({ chartDataMeta, force }) {
  if (isProvisionalChartData(chartDataMeta)) return PROVISIONAL_INDICATOR_DELAY_MS;
  return force ? 0 : INDICATOR_DATA_DEBOUNCE_MS;
}

export function shouldDeferIndicatorCompute(chartDataMeta) {
  return isProvisionalChartData(chartDataMeta);
}

export function resolveSeriesReadyComputeDelay(chartDataMeta) {
  return isProvisionalChartData(chartDataMeta)
    ? PROVISIONAL_INDICATOR_DELAY_MS
    : SERIES_READY_COMPUTE_DELAY_MS;
}

export function collectIndicatorComputeResults(results) {
  const processedResults = [];
  const allMarkers = [];
  const allFills = [];
  const allHlines = [];
  const allBgcolors = [];
  const allBarcolors = [];
  const allSignals = [];
  const newParamSchemas = {};

  for (const item of results) {
    if (item.status !== "fulfilled") continue;
    const { id, result, visible } = item.value;
    const isOk = result.ok === true
      || (result.ok == null && (
        (result.lines && result.lines.length > 0)
        || (result.series && result.series.length > 0)
      ));

    if (!isOk) {
      processedResults.push({
        id,
        mappedLines: [],
        visible,
        error: formatIndicatorError(result, "Unknown error"),
      });
      continue;
    }

    const normalized = normalizeIndicatorPayload(result, id);
    processedResults.push({
      id,
      mappedLines: normalized.lines,
      normalized,
      visible,
      error: null,
    });

    if (visible) {
      allMarkers.push(...normalized.markers);
      allFills.push(...normalized.fills);
      allHlines.push(...normalized.hlines);
      allBgcolors.push(...normalized.bgcolors);
      allBarcolors.push(...normalized.barcolors);
      allSignals.push(...normalized.signals);
    }

    if (result.param_schema && result.param_schema.length > 0) {
      newParamSchemas[id] = normalizeParamSchema(result.param_schema);
    }
  }

  return {
    processedResults,
    allMarkers,
    allFills,
    allHlines,
    allBgcolors,
    allBarcolors,
    allSignals,
    newParamSchemas,
  };
}
