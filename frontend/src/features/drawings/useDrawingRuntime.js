import { useCallback, useEffect } from "react";
import { clearSavedDrawings } from "./drawingPersistence.js";
import { useDrawingToolState } from "./drawingToolState.js";

export function useDrawingRuntime({ chartSurfaceActions, session }) {
  const toolState = useDrawingToolState();
  const { view } = toolState;
  const {
    setDrawingsHidden,
    handleSelectedDrawingChange,
  } = toolState.actions;

  const handleClearDrawing = useCallback(() => {
    chartSurfaceActions?.clearAllDrawings?.();
  }, [chartSurfaceActions]);

  const handleToggleDrawingsHidden = useCallback(() => {
    setDrawingsHidden((prev) => !prev);
  }, [setDrawingsHidden]);

  const setDrawingsHiddenForExport = useCallback((hidden) => {
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

  const handleSelectedDrawingStyleChange = useCallback((patch) => {
    chartSurfaceActions?.updateSelectedDrawingStyle?.(patch);
  }, [chartSurfaceActions]);

  const handleIndicatorRemoved = useCallback((indicatorId) => {
    const sessionView = session?.view;
    if (!sessionView || !indicatorId) return;
    const storageKeyBase = `${sessionView.exchange}:${sessionView.marketType}:${sessionView.symbol}`;
    clearSavedDrawings(`${storageKeyBase}-separate-${indicatorId}`);
    clearSavedDrawings(`${storageKeyBase}-volume-${indicatorId}`);
  }, [session]);

  const actions = {
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
    drawingTool: view.drawingTool,
    setDrawingTool: actions.setDrawingTool,
    penColor: view.penColor,
    setPenColor: actions.setPenColor,
    penSize: view.penSize,
    setPenSize: actions.setPenSize,
    textFontSize: view.textFontSize,
    setTextFontSize: actions.setTextFontSize,
    textBold: view.textBold,
    setTextBold: actions.setTextBold,
    textItalic: view.textItalic,
    setTextItalic: actions.setTextItalic,
    fibLevels: view.fibLevels,
    handleFibLevelsChange: actions.handleFibLevelsChange,
    fibInverted: view.fibInverted,
    handleFibInvertedChange: actions.handleFibInvertedChange,
    positionSize: view.positionSize,
    handlePositionSizeChange: actions.handlePositionSizeChange,
    drawingsHidden: view.drawingsHidden,
    setDrawingsHidden: actions.setDrawingsHidden,
    drawingSnapEnabled: view.drawingSnapEnabled,
    handleDrawingSnapEnabledChange: actions.handleDrawingSnapEnabledChange,
    selectedDrawing: view.selectedDrawing,
    handleSelectedDrawingChange,
    handleSelectedDrawingStyleChange,
    handleClearDrawing,
    handleToggleDrawingsHidden,
    handleIndicatorRemoved,
  };
}
