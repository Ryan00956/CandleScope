import { useCallback, useRef, useState } from "react";
import { CURSOR_TOOL_IDS, DEFAULT_CURSOR_TOOL } from "./drawingModel.js";

function loadJsonPreference(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

function loadBooleanPreference(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved == null ? fallback : saved === "true";
  } catch {
    return fallback;
  }
}

function loadNumberPreference(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? Number(saved) : fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable local preferences.
  }
}

export function useDrawingToolState() {
  const [drawingTool, setDrawingToolState] = useState(DEFAULT_CURSOR_TOOL);
  const lastCursorToolRef = useRef(DEFAULT_CURSOR_TOOL);
  const [penColor, setPenColor] = useState("#f59e0b");
  const [penSize, setPenSize] = useState(2);
  const [textFontSize, setTextFontSize] = useState(14);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [fibLevels, setFibLevels] = useState(() => loadJsonPreference("candlescope-fib-levels", null));
  const [fibInverted, setFibInverted] = useState(() => loadBooleanPreference("candlescope-fib-inverted", false));
  const [positionSize, setPositionSize] = useState(() => loadNumberPreference("candlescope-position-size", 1000));
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const [drawingSnapEnabled, setDrawingSnapEnabled] = useState(() => loadBooleanPreference("candlescope-drawing-snap-enabled", true));
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
    savePreference("candlescope-fib-levels", JSON.stringify(levels));
  }, []);

  const handleFibInvertedChange = useCallback((value) => {
    setFibInverted(value);
    savePreference("candlescope-fib-inverted", String(value));
  }, []);

  const handlePositionSizeChange = useCallback((size) => {
    setPositionSize(size);
    savePreference("candlescope-position-size", String(size));
  }, []);

  const handleDrawingSnapEnabledChange = useCallback((enabled) => {
    setDrawingSnapEnabled(enabled);
    savePreference("candlescope-drawing-snap-enabled", String(enabled));
  }, []);

  const handleSelectedDrawingChange = useCallback((drawing) => {
    setSelectedDrawing(drawing);
    if (!drawing) return;
    if (drawing.color) setPenColor(drawing.color);
    if (typeof drawing.lineWidth === "number") setPenSize(drawing.lineWidth);
  }, []);

  return {
    view: {
      drawingTool,
      penColor,
      penSize,
      textFontSize,
      textBold,
      textItalic,
      fibLevels,
      fibInverted,
      positionSize,
      drawingsHidden,
      drawingSnapEnabled,
      selectedDrawing,
    },
    actions: {
      setDrawingTool,
      setPenColor,
      setPenSize,
      setTextFontSize,
      setTextBold,
      setTextItalic,
      setDrawingsHidden,
      handleFibLevelsChange,
      handleFibInvertedChange,
      handlePositionSizeChange,
      handleDrawingSnapEnabledChange,
      handleSelectedDrawingChange,
      setSelectedDrawing,
    },
  };
}
