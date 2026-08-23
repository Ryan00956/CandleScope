import { sourceTimeFromChartTime } from "../chart-adapter/chartTime.js";
import { t } from "../i18n/index.js";
import type { IndicatorDataEntry, IndicatorLine } from "../chart-adapter/chartAdapterTypes.js";

export interface ChartPaneLegendValue {
  color: string | null;
  id: string;
  indicatorId: string | null;
  label: string;
  overlay: boolean;
  pane: string | null;
  type: string | null;
  value: number | null;
  valueFormat: string | null;
}

export interface ResolveChartPaneLegendOptions {
  overlay?: boolean;
}

export interface ChartPaneLegendGroup {
  entries: readonly ChartPaneLegendValue[];
  id: string;
}

/**
 * Future-time carrier points are intentionally absent from both the rendered
 * projection and the source bar window. They should behave like an inactive
 * crosshair so every chart-pane legend continues to show its latest value.
 */
export function shouldUseLatestChartPaneLegend(
  sourceTime: number | null,
  displayRow: unknown | null,
  sourceRow: unknown | null,
): boolean {
  return sourceTime === null || (displayRow === null && sourceRow === null);
}

function finitePoint(point: IndicatorDataEntry | null | undefined): IndicatorDataEntry | null {
  return point && typeof point.value === "number" && Number.isFinite(point.value) ? point : null;
}

function latestFinitePoint(points: readonly IndicatorDataEntry[] | null | undefined): IndicatorDataEntry | null {
  if (!points) return null;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = finitePoint(points[index]);
    if (point) return point;
  }
  return null;
}

function exactFinitePoint(
  points: readonly IndicatorDataEntry[] | null | undefined,
  time: number,
): IndicatorDataEntry | null {
  if (!points) return null;
  for (const point of points) {
    if (sourceTimeFromChartTime(point.time) !== time) continue;
    return finitePoint(point);
  }
  return null;
}

function legendLineLabel(line: IndicatorLine, index: number): string {
  const candidate = line.title || line.name || line.outputName || line.id || line.localId || line.indicatorId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : t("legend.line", { n: index + 1 });
}

function legendLineId(line: IndicatorLine, index: number): string {
  const candidate = line.id || line.localId || line.outputName || line.name || line.title || line.indicatorId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : `line-${index + 1}`;
}

function legendIndicatorId(line: IndicatorLine): string | null {
  const candidate = line.indicatorId;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

/**
 * Resolves only the exact crosshair point while the crosshair is active.
 * This deliberately avoids silently presenting a latest value for a sparse
 * series at a historical time.
 */
export function resolveChartPaneLegendValues(
  lines: readonly IndicatorLine[] | null | undefined,
  crosshairTime: number | null,
  options: ResolveChartPaneLegendOptions = {},
): ChartPaneLegendValue[] {
  return (lines || []).map((line, index) => {
    const point = crosshairTime === null
      ? latestFinitePoint(line.data)
      : exactFinitePoint(line.data, crosshairTime);
    return {
      color: point?.color || line.color || null,
      id: legendLineId(line, index),
      indicatorId: legendIndicatorId(line),
      label: legendLineLabel(line, index),
      overlay: options.overlay === true || line.overlay === true || line.pane === "main",
      pane: line.pane || null,
      type: line.type || null,
      value: point?.value ?? null,
      valueFormat: line.valueFormat || null,
    };
  });
}

/**
 * Main-pane indicators can produce multiple output lines (for example BOLL's
 * upper, middle, and lower bands). Keep those outputs together so one
 * indicator always occupies one legend row.
 */
export function groupChartPaneLegendValues(
  entries: readonly ChartPaneLegendValue[],
): ChartPaneLegendGroup[] {
  const groups: ChartPaneLegendGroup[] = [];
  const groupsById = new Map<string, number>();

  entries.forEach((entry, index) => {
    const id = entry.indicatorId ? `indicator:${entry.indicatorId}` : `line:${entry.id}:${index}`;
    const groupIndex = groupsById.get(id);
    if (groupIndex === undefined) {
      groupsById.set(id, groups.length);
      groups.push({ id, entries: [entry] });
      return;
    }
    const group = groups[groupIndex];
    if (!group) return;
    groups[groupIndex] = { ...group, entries: [...group.entries, entry] };
  });

  return groups;
}
