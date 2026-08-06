import { useCallback, useMemo, useRef } from "react";
import { callChartSurface, EMPTY_CHART_SURFACE_VIEW } from "./chartSurfaceContract";
import type { ExportSnapshot } from "../features/export/exportTypes.js";
import type {
  DrawingExportLease,
  DrawingExportPrepareOptions,
  DrawingStylePatch,
} from "../features/drawings/drawingInteractionController.js";
import type { SurfaceViewportSnapshot } from "../features/chart-representation/chartRepresentationTypes.js";

export interface ChartSurfaceVisibleRange {
  barSpacing?: number;
  logical?: { from: number; to: number };
  rightOffset?: number;
  rightmostTime?: number;
  time?: { from: number; to: number };
}

export interface ChartSurfaceLinkedTimeRange {
  from: number;
  to: number;
}

export interface ChartSurfaceHandle {
  getVisibleRange(): ChartSurfaceVisibleRange | null;
  setLinkedCrosshairTime(time: number | null): boolean;
  setLinkedVisibleTimeAnchor(time: number): boolean;
  setLinkedVisibleTimeRange(range: ChartSurfaceLinkedTimeRange): boolean;
  captureViewportTransfer(): SurfaceViewportSnapshot | null;
  clearAllDrawings(): void;
  setDrawingsHidden(hidden: boolean): void;
  prepareExport(options?: DrawingExportPrepareOptions): Promise<DrawingExportLease | null>;
  updateSelectedDrawingStyle(patch: DrawingStylePatch): void;
  getExportSnapshot(): ExportSnapshot | null;
}

export function useChartSurfaceRuntime() {
  const ref = useRef<ChartSurfaceHandle | null>(null);

  const getVisibleRange = useCallback(() => (
    callChartSurface(ref, "getVisibleRange", null)
  ), []);

  const setLinkedCrosshairTime = useCallback((time: number | null) => (
    callChartSurface(ref, "setLinkedCrosshairTime", false, time)
  ), []);

  const setLinkedVisibleTimeAnchor = useCallback((time: number) => (
    callChartSurface(ref, "setLinkedVisibleTimeAnchor", false, time)
  ), []);

  const setLinkedVisibleTimeRange = useCallback((range: ChartSurfaceLinkedTimeRange) => (
    callChartSurface(ref, "setLinkedVisibleTimeRange", false, range)
  ), []);

  const captureViewportTransfer = useCallback(() => (
    callChartSurface(ref, "captureViewportTransfer", null)
  ), []);

  const clearAllDrawings = useCallback(() => {
    callChartSurface(ref, "clearAllDrawings");
  }, []);

  const setDrawingsHidden = useCallback((hidden: boolean) => {
    callChartSurface(ref, "setDrawingsHidden", undefined, hidden);
  }, []);

  const prepareExport = useCallback((options?: DrawingExportPrepareOptions) => {
    return callChartSurface(
      ref,
      "prepareExport",
      Promise.resolve(null),
      options,
    );
  }, []);

  const updateSelectedDrawingStyle = useCallback((patch: DrawingStylePatch) => {
    callChartSurface(ref, "updateSelectedDrawingStyle", undefined, patch);
  }, []);

  const getExportSnapshot = useCallback(() => (
    callChartSurface(ref, "getExportSnapshot", null)
  ), []);

  const actions = useMemo(() => ({
    getVisibleRange,
    setLinkedCrosshairTime,
    setLinkedVisibleTimeAnchor,
    setLinkedVisibleTimeRange,
    captureViewportTransfer,
    clearAllDrawings,
    setDrawingsHidden,
    prepareExport,
    updateSelectedDrawingStyle,
    getExportSnapshot,
  }), [
    captureViewportTransfer,
    clearAllDrawings,
    getExportSnapshot,
    getVisibleRange,
    setLinkedCrosshairTime,
    setLinkedVisibleTimeAnchor,
    setLinkedVisibleTimeRange,
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
