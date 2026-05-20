import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_CURSOR_TOOL = "cursor-default";
const CURSOR_TOOL_IDS = new Set([
  DEFAULT_CURSOR_TOOL,
  "cursor-crosshair",
  "cursor-dot",
  "cursor-highlighter",
  "cursor-plain",
]);

export function useDrawingRuntime({ chartWidgetRef }) {
  const [drawingTool, setDrawingToolState] = useState(DEFAULT_CURSOR_TOOL);
  const lastCursorToolRef = useRef(DEFAULT_CURSOR_TOOL);
  const [penColor, setPenColor] = useState("#f59e0b");
  const [penSize, setPenSize] = useState(2);
  const [textFontSize, setTextFontSize] = useState(14);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [fibLevels, setFibLevels] = useState(() => {
    try {
      const saved = localStorage.getItem("candlescope-fib-levels");
      if (saved) return JSON.parse(saved);
    } catch {
      // Ignore malformed local preferences.
    }
    return null;
  });
  const [fibInverted, setFibInverted] = useState(() => {
    try {
      return localStorage.getItem("candlescope-fib-inverted") === "true";
    } catch {
      return false;
    }
  });
  const [positionSize, setPositionSize] = useState(() => {
    try {
      const saved = localStorage.getItem("candlescope-position-size");
      if (saved) return Number(saved);
    } catch {
      // Ignore malformed local preferences.
    }
    return 1000;
  });
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const [drawingSnapEnabled, setDrawingSnapEnabled] = useState(() => {
    try {
      const saved = localStorage.getItem("candlescope-drawing-snap-enabled");
      return saved == null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [selectedDrawing, setSelectedDrawing] = useState(null);

  const setDrawingTool = useCallback((nextTool) => {
    const normalizedTool = nextTool || lastCursorToolRef.current || DEFAULT_CURSOR_TOOL;
    if (CURSOR_TOOL_IDS.has(normalizedTool)) {
      lastCursorToolRef.current = normalizedTool;
    }
    setDrawingToolState(normalizedTool);
  }, []);

  const handleFibLevelsChange = useCallback((levels) => {
    setFibLevels(levels);
    try { localStorage.setItem("candlescope-fib-levels", JSON.stringify(levels)); } catch { /* ignore */ }
  }, []);

  const handleFibInvertedChange = useCallback((value) => {
    setFibInverted(value);
    try { localStorage.setItem("candlescope-fib-inverted", String(value)); } catch { /* ignore */ }
  }, []);

  const handlePositionSizeChange = useCallback((size) => {
    setPositionSize(size);
    try { localStorage.setItem("candlescope-position-size", String(size)); } catch { /* ignore */ }
  }, []);

  const handleClearDrawing = useCallback(() => {
    chartWidgetRef.current?.clearAllDrawings();
  }, [chartWidgetRef]);

  const handleToggleDrawingsHidden = useCallback(() => {
    setDrawingsHidden((prev) => !prev);
  }, []);

  useEffect(() => {
    chartWidgetRef.current?.setDrawingsHidden?.(drawingsHidden);
  }, [chartWidgetRef, drawingsHidden]);

  const handleDrawingSnapEnabledChange = useCallback((enabled) => {
    setDrawingSnapEnabled(enabled);
    try { localStorage.setItem("candlescope-drawing-snap-enabled", String(enabled)); } catch { /* ignore */ }
  }, []);

  const handleSelectedDrawingChange = useCallback((drawing) => {
    setSelectedDrawing(drawing);
    if (!drawing) return;
    if (drawing.color) setPenColor(drawing.color);
    if (typeof drawing.lineWidth === "number") setPenSize(drawing.lineWidth);
  }, []);

  const handleSelectedDrawingStyleChange = useCallback((patch) => {
    chartWidgetRef.current?.updateSelectedDrawingStyle?.(patch);
  }, [chartWidgetRef]);

  return {
    drawingTool,
    setDrawingTool,
    penColor,
    setPenColor,
    penSize,
    setPenSize,
    textFontSize,
    setTextFontSize,
    textBold,
    setTextBold,
    textItalic,
    setTextItalic,
    fibLevels,
    handleFibLevelsChange,
    fibInverted,
    handleFibInvertedChange,
    positionSize,
    handlePositionSizeChange,
    drawingsHidden,
    setDrawingsHidden,
    drawingSnapEnabled,
    handleDrawingSnapEnabledChange,
    selectedDrawing,
    handleSelectedDrawingChange,
    handleSelectedDrawingStyleChange,
    handleClearDrawing,
    handleToggleDrawingsHidden,
  };
}
