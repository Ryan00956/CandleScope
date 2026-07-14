import { useCallback, useEffect } from "react";
import { clearDrawingScopeAuthoritatively } from "./drawingScopePersistence.js";
import { useDrawingToolState } from "./drawingToolState.js";
import type { ChartSurfaceActions } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { DrawingToolStateRuntime } from "./drawingToolState.js";
import type { DrawingStylePatch } from "./drawingInteractionController.js";

export type DrawingRuntimeActions = DrawingToolStateRuntime["actions"] & {
  handleClearDrawing(): void;
  handleToggleDrawingsHidden(): void;
  handleSelectedDrawingStyleChange(patch: DrawingStylePatch): void;
  setDrawingsHiddenForExport(hidden: boolean): void;
  prepareExport(): void;
  handleIndicatorRemoved(indicatorId: string | null | undefined): void;
};

export interface DrawingRuntime {
  view: DrawingToolStateRuntime["view"];
  actions: DrawingRuntimeActions;
  status: Record<string, never>;
}

export function useDrawingRuntime({
  chartSurfaceActions,
  session,
}: {
  chartSurfaceActions: ChartSurfaceActions | null | undefined;
  session: ChartSessionRuntime | null | undefined;
}): DrawingRuntime {
  const toolState = useDrawingToolState();
  const { view } = toolState;
  const {
    setDrawingsHidden,
  } = toolState.actions;

  const handleClearDrawing = useCallback(() => {
    chartSurfaceActions?.clearAllDrawings?.();
  }, [chartSurfaceActions]);

  const handleToggleDrawingsHidden = useCallback(() => {
    setDrawingsHidden((prev) => !prev);
  }, [setDrawingsHidden]);

  const setDrawingsHiddenForExport = useCallback((hidden: boolean) => {
    const nextHidden = !!hidden;
    setDrawingsHidden(nextHidden);
    chartSurfaceActions?.setDrawingsHidden?.(nextHidden);
  }, [chartSurfaceActions, setDrawingsHidden]);

  const prepareExport = useCallback(() => {
    chartSurfaceActions?.prepareExport?.();
  }, [chartSurfaceActions]);

  useEffect(() => {
    chartSurfaceActions?.setDrawingsHidden?.(view.drawingsHidden);
  }, [chartSurfaceActions, view.drawingsHidden]);

  const handleSelectedDrawingStyleChange = useCallback((patch: DrawingStylePatch) => {
    chartSurfaceActions?.updateSelectedDrawingStyle?.(patch);
  }, [chartSurfaceActions]);

  const handleIndicatorRemoved = useCallback((indicatorId: string | null | undefined) => {
    const sessionView = session?.view;
    if (!sessionView || !indicatorId) return;
    const storageKeyBase = `${sessionView.exchange}:${sessionView.marketType}:${sessionView.symbol}`;
    clearDrawingScopeAuthoritatively(`${storageKeyBase}-separate-${indicatorId}`);
    clearDrawingScopeAuthoritatively(`${storageKeyBase}-volume-${indicatorId}`);
  }, [session]);

  const actions: DrawingRuntimeActions = {
    ...toolState.actions,
    handleClearDrawing,
    handleToggleDrawingsHidden,
    handleSelectedDrawingStyleChange,
    setDrawingsHiddenForExport,
    prepareExport,
    handleIndicatorRemoved,
  };

  return {
    view,
    actions,
    status: {},
  };
}
