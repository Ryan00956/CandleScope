import { useCallback, useRef, useState } from "react";
import {
  CHART_TYPE_VARIANTS,
  CURSOR_TOOL_IDS,
  CURSOR_VARIANTS,
  FREEHAND_TOOL_IDS,
  FREEHAND_VARIANTS,
  LINE_TOOL_IDS,
  LINE_VARIANTS,
  LongPositionIcon,
  MouseDefaultIcon,
  PenIcon,
  POSITION_TOOL_IDS,
  POSITION_VARIANTS,
  RectangleIcon,
  SegmentIcon,
  SHAPE_TOOL_IDS,
  SHAPE_VARIANTS,
} from "./drawingToolbarDefinitions.jsx";

const findVariant = (variants, id) => variants.find((variant) => variant.id === id);

export function useDrawingToolbarController({ activeTool, onToolChange, onToggleExportPanel }) {
  const [cursorVariant, setCursorVariant] = useState("cursor-default");
  const [freehandVariant, setFreehandVariant] = useState("pen");
  const [lineVariant, setLineVariant] = useState("line-segment");
  const [shapeVariant, setShapeVariant] = useState("shape-rectangle");
  const [posVariant, setPosVariant] = useState("position-long");
  const [chartType, setChartType] = useState("candlestick");
  const [flyoutOpen, setFlyoutOpen] = useState(null);

  const chartTypeBtnRef = useRef(null);
  const cursorBtnRef = useRef(null);
  const freehandBtnRef = useRef(null);
  const lineBtnRef = useRef(null);
  const shapeBtnRef = useRef(null);
  const fibBtnRef = useRef(null);
  const posBtnRef = useRef(null);

  const cursorClickTimerRef = useRef(null);
  const freehandClickTimerRef = useRef(null);
  const clickTimerRef = useRef(null);
  const shapeClickTimerRef = useRef(null);
  const posClickTimerRef = useRef(null);

  const isCursorActive = CURSOR_TOOL_IDS.has(activeTool);
  const isFreehandActive = FREEHAND_TOOL_IDS.has(activeTool);
  const isEraserActive = activeTool === "eraser";
  const isLineActive = LINE_TOOL_IDS.has(activeTool);
  const isShapeActive = SHAPE_TOOL_IDS.has(activeTool);
  const isTextActive = activeTool === "text";
  const isFibonacciActive = activeTool === "fibonacci";
  const isPositionActive = POSITION_TOOL_IDS.has(activeTool);

  const currentChartType = findVariant(CHART_TYPE_VARIANTS, chartType) || CHART_TYPE_VARIANTS[0];

  const closeFlyout = useCallback(() => {
    setFlyoutOpen(null);
  }, []);

  const handleChartTypeClick = useCallback(() => {
    setFlyoutOpen((prev) => (prev === "chart-type" ? null : "chart-type"));
  }, []);

  const handleSelectChartType = useCallback((id) => {
    setChartType(id);
  }, []);

  const handleCursorClick = useCallback((event) => {
    if (event?.detail > 1) return;
    onToolChange(isCursorActive ? activeTool : cursorVariant);
    setFlyoutOpen(null);
  }, [activeTool, cursorVariant, isCursorActive, onToolChange]);

  const handleCursorDblClick = useCallback(() => {
    if (cursorClickTimerRef.current) {
      clearTimeout(cursorClickTimerRef.current);
      cursorClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "cursor" ? null : "cursor"));
  }, []);

  const handleCursorContextMenu = useCallback((event) => {
    event.preventDefault();
    if (cursorClickTimerRef.current) {
      clearTimeout(cursorClickTimerRef.current);
      cursorClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "cursor" ? null : "cursor"));
  }, []);

  const handleSelectCursorVariant = useCallback(
    (id) => {
      setCursorVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  const handleFreehandClick = useCallback((event) => {
    if (event?.detail > 1) return;
    if (!isFreehandActive) {
      onToolChange(freehandVariant);
      setFlyoutOpen(null);
      return;
    }
    if (freehandClickTimerRef.current) return;
    freehandClickTimerRef.current = setTimeout(() => {
      freehandClickTimerRef.current = null;
      onToolChange(null);
      setFlyoutOpen(null);
    }, 200);
  }, [freehandVariant, isFreehandActive, onToolChange]);

  const handleFreehandDblClick = useCallback(() => {
    if (freehandClickTimerRef.current) {
      clearTimeout(freehandClickTimerRef.current);
      freehandClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "freehand" ? null : "freehand"));
  }, []);

  const handleFreehandContextMenu = useCallback((event) => {
    event.preventDefault();
    if (freehandClickTimerRef.current) {
      clearTimeout(freehandClickTimerRef.current);
      freehandClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "freehand" ? null : "freehand"));
  }, []);

  const handleSelectFreehandVariant = useCallback(
    (id) => {
      setFreehandVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  const handleEraserClick = useCallback(() => {
    onToolChange(isEraserActive ? null : "eraser");
    setFlyoutOpen(null);
  }, [isEraserActive, onToolChange]);

  const handleTextClick = useCallback(() => {
    onToolChange(isTextActive ? null : "text");
    setFlyoutOpen(null);
  }, [isTextActive, onToolChange]);

  const handleFibonacciClick = useCallback(() => {
    onToolChange(isFibonacciActive ? null : "fibonacci");
    setFlyoutOpen(null);
  }, [isFibonacciActive, onToolChange]);

  const handleToggleFibonacciSettings = useCallback(() => {
    setFlyoutOpen((prev) => (prev === "fib-levels" ? null : "fib-levels"));
  }, []);

  const handleFibonacciSettingsContextMenu = useCallback(
    (event) => {
      event.preventDefault();
      handleToggleFibonacciSettings();
    },
    [handleToggleFibonacciSettings],
  );

  const handleLineClick = useCallback((event) => {
    if (event?.detail > 1) return;
    if (!isLineActive) {
      onToolChange(lineVariant);
      setFlyoutOpen(null);
      return;
    }
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onToolChange(null);
      setFlyoutOpen(null);
    }, 200);
  }, [isLineActive, lineVariant, onToolChange]);

  const handleLineDblClick = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "line" ? null : "line"));
  }, []);

  const handleLineContextMenu = useCallback((event) => {
    event.preventDefault();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "line" ? null : "line"));
  }, []);

  const handleSelectLineVariant = useCallback(
    (id) => {
      setLineVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  const handleShapeClick = useCallback((event) => {
    if (event?.detail > 1) return;
    if (!isShapeActive) {
      onToolChange(shapeVariant);
      setFlyoutOpen(null);
      return;
    }
    if (shapeClickTimerRef.current) return;
    shapeClickTimerRef.current = setTimeout(() => {
      shapeClickTimerRef.current = null;
      onToolChange(null);
      setFlyoutOpen(null);
    }, 200);
  }, [isShapeActive, onToolChange, shapeVariant]);

  const handleShapeDblClick = useCallback(() => {
    if (shapeClickTimerRef.current) {
      clearTimeout(shapeClickTimerRef.current);
      shapeClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "shape" ? null : "shape"));
  }, []);

  const handleShapeContextMenu = useCallback((event) => {
    event.preventDefault();
    if (shapeClickTimerRef.current) {
      clearTimeout(shapeClickTimerRef.current);
      shapeClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "shape" ? null : "shape"));
  }, []);

  const handleSelectShapeVariant = useCallback(
    (id) => {
      setShapeVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  const handlePositionClick = useCallback((event) => {
    if (event?.detail > 1) return;
    if (!isPositionActive) {
      onToolChange(posVariant);
      setFlyoutOpen(null);
      return;
    }
    if (posClickTimerRef.current) return;
    posClickTimerRef.current = setTimeout(() => {
      posClickTimerRef.current = null;
      onToolChange(null);
      setFlyoutOpen(null);
    }, 200);
  }, [isPositionActive, onToolChange, posVariant]);

  const handlePositionDblClick = useCallback(() => {
    if (posClickTimerRef.current) {
      clearTimeout(posClickTimerRef.current);
      posClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "position" ? null : "position"));
  }, []);

  const handlePositionContextMenu = useCallback((event) => {
    event.preventDefault();
    if (posClickTimerRef.current) {
      clearTimeout(posClickTimerRef.current);
      posClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "position" ? null : "position"));
  }, []);

  const handleSelectPositionVariant = useCallback(
    (id) => {
      setPosVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  const handleTogglePositionSettings = useCallback(() => {
    setFlyoutOpen((prev) => (prev === "position-settings" ? null : "position-settings"));
  }, []);

  const handleExportClick = useCallback(() => {
    setFlyoutOpen(null);
    onToggleExportPanel?.();
  }, [onToggleExportPanel]);

  const currentCursorId = isCursorActive ? activeTool : cursorVariant;
  const currentCursor = findVariant(CURSOR_VARIANTS, currentCursorId);
  const currentFreehandId = isFreehandActive ? activeTool : freehandVariant;
  const currentFreehand = findVariant(FREEHAND_VARIANTS, currentFreehandId);
  const currentLine = findVariant(LINE_VARIANTS, lineVariant);
  const currentShape = findVariant(SHAPE_VARIANTS, shapeVariant);
  const currentPosition = findVariant(POSITION_VARIANTS, posVariant);

  return {
    chartType,
    chartTypeBtnRef,
    closeFlyout,
    currentChartType,
    currentCursorIcon: currentCursor?.icon || MouseDefaultIcon,
    currentCursorId,
    currentCursorLabel: currentCursor?.label || "Default cursor",
    currentFreehandIcon: currentFreehand?.icon || PenIcon,
    currentFreehandId,
    currentFreehandLabel: currentFreehand?.label || "Pen",
    currentLineIcon: currentLine?.icon || SegmentIcon,
    currentLineLabel: currentLine?.label || "Segment",
    currentPosIcon: currentPosition?.icon || LongPositionIcon,
    currentPosLabel: currentPosition?.label || "Long position",
    currentShapeIcon: currentShape?.icon || RectangleIcon,
    currentShapeLabel: currentShape?.label || "Rectangle",
    cursorBtnRef,
    fibBtnRef,
    flyoutOpen,
    freehandBtnRef,
    freehandOptionLabel: currentFreehand?.label || "Pen",
    handleChartTypeClick,
    handleCursorClick,
    handleCursorContextMenu,
    handleCursorDblClick,
    handleEraserClick,
    handleExportClick,
    handleFibonacciClick,
    handleFibonacciSettingsContextMenu,
    handleFreehandClick,
    handleFreehandContextMenu,
    handleFreehandDblClick,
    handleLineClick,
    handleLineContextMenu,
    handleLineDblClick,
    handlePositionClick,
    handlePositionContextMenu,
    handlePositionDblClick,
    handleSelectChartType,
    handleSelectCursorVariant,
    handleSelectFreehandVariant,
    handleSelectLineVariant,
    handleSelectPositionVariant,
    handleSelectShapeVariant,
    handleShapeClick,
    handleShapeContextMenu,
    handleShapeDblClick,
    handleTextClick,
    handleToggleFibonacciSettings,
    handleTogglePositionSettings,
    isCursorActive,
    isEraserActive,
    isFibonacciActive,
    isFreehandActive,
    isLineActive,
    isPositionActive,
    isShapeActive,
    isTextActive,
    lineBtnRef,
    lineVariant,
    posBtnRef,
    posVariant,
    shapeBtnRef,
    shapeVariant,
    showFibonacciOptions: isFibonacciActive,
    showLineOptions: isLineActive,
    showPenOptions: isFreehandActive,
    showPositionOptions: isPositionActive,
    showShapeOptions: isShapeActive,
    showTextOptions: isTextActive,
  };
}
