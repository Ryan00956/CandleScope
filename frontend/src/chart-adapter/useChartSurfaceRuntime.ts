import { useCallback, useMemo, useRef } from "react";
import { callChartSurface, EMPTY_CHART_SURFACE_VIEW } from "./chartSurfaceContract";
import type { ExportSnapshot } from "../features/export/exportTypes.js";
import type { DrawingStylePatch } from "../features/drawings/drawingInteractionController.js";

export interface ChartSurfaceVisibleRange {
  barSpacing?: number;
  logical?: { from: number; to: number };
  rightOffset?: number;
  rightmostTime?: number;
  time?: { from: number; to: number };
}

export interface ChartSurfaceHandle {
  getVisibleRange(): ChartSurfaceVisibleRange | null;
  clearAllDrawings(): void;
  setDrawingsHidden(hidden: boolean): void;
  prepareExport(): void;
  updateSelectedDrawingStyle(patch: DrawingStylePatch): void;
  getExportSnapshot(): ExportSnapshot | null;
}

export function useChartSurfaceRuntime() {
  const ref = useRef<ChartSurfaceHandle | null>(null);

  const getVisibleRange = useCallback(() => (
    callChartSurface(ref, "getVisibleRange", null)
  ), []);

  const clearAllDrawings = useCallback(() => {
    callChartSurface(ref, "clearAllDrawings");
  }, []);

  const setDrawingsHidden = useCallback((hidden: boolean) => {
    callChartSurface(ref, "setDrawingsHidden", undefined, hidden);
  }, []);

  const prepareExport = useCallback(() => {
    callChartSurface(ref, "prepareExport");
  }, []);

  const updateSelectedDrawingStyle = useCallback((patch: DrawingStylePatch) => {
    callChartSurface(ref, "updateSelectedDrawingStyle", undefined, patch);
  }, []);

  const getExportSnapshot = useCallback(() => (
    callChartSurface(ref, "getExportSnapshot", null)
  ), []);

  const actions = useMemo(() => ({
    getVisibleRange,
    clearAllDrawings,
    setDrawingsHidden,
    prepareExport,
    updateSelectedDrawingStyle,
    getExportSnapshot,
  }), [
    clearAllDrawings,
    getExportSnapshot,
    getVisibleRange,
    prepareExport,
    setDrawingsHidden,
    updateSelectedDrawingStyle,
  ]);

  return {
    ref,
    view: EMPTY_CHART_SURFACE_VIEW,
    actions,
    status: {},
  };
}

export type ChartSurfaceRuntime = ReturnType<typeof useChartSurfaceRuntime>;
export type ChartSurfaceActions = ChartSurfaceRuntime["actions"];
