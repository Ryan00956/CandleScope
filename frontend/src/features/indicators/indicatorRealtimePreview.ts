import type { KlineBar } from "../market-data/marketDataTypes.js";
import { resolveRealtimeHistogramColor } from "./indicatorRealtimeColor.js";
import {
  getBuiltinIndicatorName,
  resolveWsValue,
  upsertLinePoint,
} from "./indicatorPayloadRuntime.js";
import {
  normalizeIndicatorRevision,
} from "./indicatorRangeCoverage.js";
import type {
  IndicatorDefinition,
  IndicatorLine,
  IndicatorPayloadEnvelope,
  IndicatorValuePoint,
} from "./indicatorTypes.js";

export interface ProvisionalIndicatorPreview {
  bar?: KlineBar;
  barTime: number;
  values: Record<string, unknown>;
}

export interface ApplyRealtimeIndicatorValuesOptions {
  bar?: KlineBar | null;
  barTime: number;
  candleDownColor: string;
  candleUpColor: string;
  indicator: IndicatorDefinition;
  lines: IndicatorLine[];
  values: Record<string, unknown>;
}

function configuredVolumeUpColor(
  indicator: IndicatorDefinition,
  fallback: string,
): string {
  const value = indicator.params?.up_color;
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * A fresh chart can receive the acknowledged forming VOL preview before the
 * closed-history request has returned its line schema. VOL is a fixed builtin
 * with one documented histogram output, so it is safe to create only that
 * shell immediately; arbitrary/custom indicators remain history-driven.
 */
export function ensureRealtimeIndicatorLines(
  indicator: IndicatorDefinition,
  lines: IndicatorLine[],
  values: Record<string, unknown>,
  candleUpColor: string,
): IndicatorLine[] {
  if (lines.length > 0) return lines;
  if (getBuiltinIndicatorName(indicator).trim().toUpperCase() !== "VOL") {
    return lines;
  }
  if (values.vol === undefined && values.volume === undefined) return lines;
  return [{
    id: "vol",
    name: indicator.name || "VOL",
    title: indicator.name || "VOL",
    outputName: "vol",
    color: configuredVolumeUpColor(indicator, candleUpColor),
    type: "histogram",
    overlay: false,
    pane: "volume",
    data: [],
  }];
}

/**
 * Updates only matching timestamps. In particular, a missing main-series bar
 * must never cause indicator data to be shifted onto a neighboring candle.
 */
export function applyRealtimeIndicatorValuesToLines({
  bar,
  barTime,
  candleDownColor,
  candleUpColor,
  indicator,
  lines,
  values,
}: ApplyRealtimeIndicatorValuesOptions): IndicatorLine[] {
  const targetLines = ensureRealtimeIndicatorLines(
    indicator,
    lines,
    values,
    candleUpColor,
  );
  const isSingleLine = targetLines.length === 1 && Object.keys(values).length === 1;
  return targetLines.map((line) => {
    const value = resolveWsValue(line, values, isSingleLine);
    if (value === undefined) return line;
    const point: IndicatorValuePoint = { time: barTime, value: Number(value) };
    const histogramColor = resolveRealtimeHistogramColor({
      bar,
      downColor: candleDownColor,
      indicator,
      line,
      upColor: candleUpColor,
      value,
    });
    if (line.type === "histogram" && histogramColor) point.color = histogramColor;
    return { ...line, data: upsertLinePoint(line.data, point) };
  });
}

function hasPointAt(lines: IndicatorLine[], time: number): boolean {
  return lines.some((line) => line.data.some((point) => Number(point.time) === time));
}

/**
 * Historical responses contain closed bars only. Keep an in-flight preview if
 * that response did not actually include its timestamp; otherwise a delayed
 * history response can erase the newest VOL column. A closed-through revision
 * is authoritative and clears the preview once the server has finalized it.
 */
export function shouldRetainProvisionalIndicatorPreview(
  preview: ProvisionalIndicatorPreview | null | undefined,
  historicalLines: IndicatorLine[],
  payload: Partial<IndicatorPayloadEnvelope> | null | undefined,
): preview is ProvisionalIndicatorPreview {
  if (!preview || !Number.isFinite(preview.barTime) || preview.barTime <= 0) {
    return false;
  }
  const closedThrough = normalizeIndicatorRevision(payload)?.closedThrough;
  if (
    typeof closedThrough === "number"
    && Number.isFinite(closedThrough)
    && preview.barTime <= closedThrough
  ) {
    return false;
  }
  return !hasPointAt(historicalLines, preview.barTime);
}
