import { useCallback, useMemo, useRef } from "react";
import { callChartSurface, EMPTY_CHART_SURFACE_VIEW } from "./chartSurfaceContract";

export interface ChartSurfaceHandle {
  getVisibleRange(): unknown;
  clearAllDrawings(): void;
  setDrawingsHidden(hidden: boolean): void;
  prepareExport(): void;
  updateSelectedDrawingStyle(patch: Record<string, unknown>): void;
  getExportSnapshot(): unknown;
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

  const updateSelectedDrawingStyle = useCallback((patch: Record<string, unknown>) => {
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
