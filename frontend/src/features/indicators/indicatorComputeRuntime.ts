import {
  formatIndicatorError,
  isProvisionalChartData,
  normalizeIndicatorPayload,
  normalizeParsedIndicatorPayload,
  normalizeParamSchema,
  stringSignature,
} from "./indicatorPayloadRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  IndicatorDefinition,
  IndicatorParameterSchema,
  IndicatorPayloadEnvelope,
} from "./indicatorTypes.js";

interface IndicatorComputeColors {
  candleUpColor?: string;
  candleDownColor?: string;
}

interface IndicatorComputeResultItem {
  id: string;
  result: IndicatorPayloadEnvelope;
  visible: boolean;
}

// Indicator compute is viewport-window scoped; older history is filled by range requests.
export const INDICATOR_HISTORY_LIMIT = 2_000;
export const INDICATOR_DATA_DEBOUNCE_MS = 150;
export const PROVISIONAL_INDICATOR_DELAY_MS = 300;
export const SERIES_READY_COMPUTE_DELAY_MS = 50;

export function buildCandleColorKey(candleUpColor?: string, candleDownColor?: string): string {
  return `${candleUpColor}|${candleDownColor}`;
}

export function buildIndicatorMutationSignature(indicators: IndicatorDefinition[] = []): string {
  return indicators
    .map((indicator) => (
      `${indicator.id}:${indicator.language || ""}:${stringSignature(indicator.script || "")}:${JSON.stringify(indicator.params || {})}`
    ))
    .join("|");
}

export function limitIndicatorHistory(
  chartData: KlineBar[] = [],
  limit = INDICATOR_HISTORY_LIMIT,
): KlineBar[] {
  if (!Array.isArray(chartData)) return [];
  const maxBars = Math.max(1, Math.floor(Number(limit) || INDICATOR_HISTORY_LIMIT));
  return chartData.length > maxBars ? chartData.slice(-maxBars) : chartData;
}

export function buildIndicatorOhlcv(
  chartData: KlineBar[] = [],
  { limit = INDICATOR_HISTORY_LIMIT }: { limit?: number } = {},
) {
  return limitIndicatorHistory(chartData, limit).map((bar) => ({
    time: bar.time,
    open: Number(bar.open ?? 0),
    high: Number(bar.high ?? 0),
    low: Number(bar.low ?? 0),
    close: Number(bar.close ?? 0),
    volume: bar.volume || 0,
  }));
}

/** Hashes exactly the bounded OHLCV window sent to local compute. */
export function buildIndicatorOhlcvSignature(
  chartData: KlineBar[] = [],
  { limit = INDICATOR_HISTORY_LIMIT }: { limit?: number } = {},
): string {
  const bars = limitIndicatorHistory(chartData, limit);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const mixPart = (part: number) => {
    first = Math.imul(first ^ part, 0x01000193);
    second = Math.imul(second ^ part, 0x85ebca6b);
    second ^= second >>> 13;
  };
  const mix = (value: unknown) => {
    view.setFloat64(0, Number(value ?? 0), true);
    mixPart(view.getUint32(0, true));
    mixPart(view.getUint32(4, true));
  };
  for (const bar of bars) {
    mix(bar.time);
    mix(bar.open ?? 0);
    mix(bar.high ?? 0);
    mix(bar.low ?? 0);
    mix(bar.close ?? 0);
    mix(bar.volume || 0);
  }
  return [
    bars.length,
    bars[0]?.time ?? "",
    bars.at(-1)?.time ?? "",
    (first >>> 0).toString(36),
    (second >>> 0).toString(36),
  ].join(":");
}

export function chunkIndicatorComputeJobs<T>(
  jobs: readonly T[] = [],
  maxBatchSize = 32,
): T[][] {
  const size = Math.max(1, Math.floor(Number(maxBatchSize) || 32));
  const chunks: T[][] = [];
  for (let index = 0; index < jobs.length; index += size) {
    chunks.push(jobs.slice(index, index + size));
  }
  return chunks;
}

export function buildIndicatorComputeParams(
  indicator: IndicatorDefinition,
  { candleUpColor, candleDownColor }: IndicatorComputeColors = {},
) {
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

export function hasVolumeIndicator(indicators: IndicatorDefinition[] = []): boolean {
  return indicators.some((indicator) => indicator.id === "vol" || indicator.engineName === "VOL");
}

export function resolveIndicatorComputeDelay({
  chartDataMeta,
  force,
}: {
  chartDataMeta?: { status?: unknown } | null;
  force?: boolean;
}): number {
  if (isProvisionalChartData(chartDataMeta)) return PROVISIONAL_INDICATOR_DELAY_MS;
  return force ? 0 : INDICATOR_DATA_DEBOUNCE_MS;
}

export function shouldDeferIndicatorCompute(chartDataMeta?: { status?: unknown } | null): boolean {
  return isProvisionalChartData(chartDataMeta);
}

export function resolveSeriesReadyComputeDelay(chartDataMeta?: { status?: unknown } | null): number {
  return isProvisionalChartData(chartDataMeta)
    ? PROVISIONAL_INDICATOR_DELAY_MS
    : SERIES_READY_COMPUTE_DELAY_MS;
}

export function collectIndicatorComputeResults(
  results: PromiseSettledResult<IndicatorComputeResultItem>[],
  { parsed = false }: { parsed?: boolean } = {},
) {
  const processedResults = [];
  const allMarkers = [];
  const allFills = [];
  const allHlines = [];
  const allBgcolors = [];
  const allBarcolors = [];
  const allSignals = [];
  const newParamSchemas: Record<string, IndicatorParameterSchema[]> = {};

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

    const normalized = parsed
      ? normalizeParsedIndicatorPayload(result, id)
      : normalizeIndicatorPayload(result, id);
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
