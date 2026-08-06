import type {
  ChartWorkspaceLayout,
  ChartWorkspaceLayoutRatios,
} from "./chartWorkspaceTypes.js";

export const MIN_CHART_SPLIT_RATIO = 0.2;
export const MAX_CHART_SPLIT_RATIO = 0.8;

export type ChartWorkspaceSplitAxis = "columns" | "rows";

export function normalizeChartSplitRatio(value: unknown, fallback = 0.5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CHART_SPLIT_RATIO, Math.max(MIN_CHART_SPLIT_RATIO, parsed));
}

export function ratioFromPointerPosition(
  pointerPosition: number,
  containerStart: number,
  containerSize: number,
): number | null {
  if (!Number.isFinite(pointerPosition)
    || !Number.isFinite(containerStart)
    || !Number.isFinite(containerSize)
    || containerSize <= 0) return null;
  return normalizeChartSplitRatio((pointerPosition - containerStart) / containerSize);
}

export function layoutRatioKey(
  layout: ChartWorkspaceLayout,
  axis: ChartWorkspaceSplitAxis,
): keyof ChartWorkspaceLayoutRatios | null {
  if (layout === "split-vertical" && axis === "columns") return "splitVertical";
  if (layout === "split-horizontal" && axis === "rows") return "splitHorizontal";
  if (layout === "quad") return axis === "columns" ? "quadColumns" : "quadRows";
  return null;
}
