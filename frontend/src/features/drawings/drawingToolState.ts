import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { CURSOR_TOOL_IDS, DEFAULT_CURSOR_TOOL } from "./drawingModel.js";
import type { DrawingToolId, FibonacciLevel, PassiveCursorToolId } from "./drawingTypes.js";
import type { SelectedDrawingMeta } from "./drawingSelectionController.js";

function loadJsonPreference<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : fallback;
  } catch {
    return fallback;
  }
}

function loadBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key);
    return saved == null ? fallback : saved === "true";
  } catch {
    return fallback;
  }
}

function loadNumberPreference(key: string, fallback: number): number {
  try {
    const saved = localStorage.getItem(key);
    return saved ? Number(saved) : fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable local preferences.
  }
}

export interface DrawingToolStateRuntime {
  view: {
    drawingTool: DrawingToolId;
    penColor: string;
    penSize: number;
    textFontSize: number;
    textBold: boolean;
    textItalic: boolean;
    fibLevels: FibonacciLevel[] | null;
    fibInverted: boolean;
    positionSize: number;
    drawingsHidden: boolean;
    drawingSnapEnabled: boolean;
    drawingContinuousEnabled: boolean;
    selectedDrawing: SelectedDrawingMeta | null;
  };
  actions: {
    setDrawingTool(tool: DrawingToolId | null): void;
    setPenColor: Dispatch<SetStateAction<string>>;
    setPenSize: Dispatch<SetStateAction<number>>;
    setTextFontSize: Dispatch<SetStateAction<number>>;
    setTextBold: Dispatch<SetStateAction<boolean>>;
    setTextItalic: Dispatch<SetStateAction<boolean>>;
    setDrawingsHidden: Dispatch<SetStateAction<boolean>>;
    handleFibLevelsChange(levels: FibonacciLevel[] | null): void;
    handleFibInvertedChange(value: boolean): void;
    handlePositionSizeChange(size: number): void;
    handleDrawingSnapEnabledChange(enabled: boolean): void;
    handleDrawingContinuousEnabledChange(enabled: boolean): void;
    handleSelectedDrawingChange(drawing: SelectedDrawingMeta | null): void;
    setSelectedDrawing: Dispatch<SetStateAction<SelectedDrawingMeta | null>>;
  };
}

export function useDrawingToolState(): DrawingToolStateRuntime {
  const [drawingTool, setDrawingToolState] = useState<DrawingToolId>(DEFAULT_CURSOR_TOOL);
  const lastCursorToolRef = useRef<PassiveCursorToolId>(DEFAULT_CURSOR_TOOL);
  const [penColor, setPenColor] = useState("#f59e0b");
  const [penSize, setPenSize] = useState(2);
  const [textFontSize, setTextFontSize] = useState(14);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [fibLevels, setFibLevels] = useState<FibonacciLevel[] | null>(() => (
    loadJsonPreference<FibonacciLevel[] | null>("candlescope-fib-levels", null)
  ));
  const [fibInverted, setFibInverted] = useState(() => loadBooleanPreference("candlescope-fib-inverted", false));
  const [positionSize, setPositionSize] = useState(() => loadNumberPreference("candlescope-position-size", 1000));
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const [drawingSnapEnabled, setDrawingSnapEnabled] = useState(() => loadBooleanPreference("candlescope-drawing-snap-enabled", true));
  const [drawingContinuousEnabled, setDrawingContinuousEnabled] = useState(() => loadBooleanPreference(
    "candlescope-drawing-continuous-enabled",
    false,
  ));
  const [selectedDrawing, setSelectedDrawing] = useState<SelectedDrawingMeta | null>(null);

  const setDrawingTool = useCallback((nextTool: DrawingToolId | null) => {
    const normalizedTool = nextTool || lastCursorToolRef.current || DEFAULT_CURSOR_TOOL;
    if (CURSOR_TOOL_IDS.has(normalizedTool as PassiveCursorToolId)) {
      lastCursorToolRef.current = normalizedTool as PassiveCursorToolId;
    }
    setDrawingToolState(normalizedTool);
  }, []);

  const handleFibLevelsChange = useCallback((levels: FibonacciLevel[] | null) => {
    setFibLevels(levels);
    savePreference("candlescope-fib-levels", JSON.stringify(levels));
  }, []);

  const handleFibInvertedChange = useCallback((value: boolean) => {
    setFibInverted(value);
    savePreference("candlescope-fib-inverted", String(value));
  }, []);

  const handlePositionSizeChange = useCallback((size: number) => {
    setPositionSize(size);
    savePreference("candlescope-position-size", String(size));
  }, []);

  const handleDrawingSnapEnabledChange = useCallback((enabled: boolean) => {
    setDrawingSnapEnabled(enabled);
    savePreference("candlescope-drawing-snap-enabled", String(enabled));
  }, []);

  const handleDrawingContinuousEnabledChange = useCallback((enabled: boolean) => {
    setDrawingContinuousEnabled(enabled);
    savePreference("candlescope-drawing-continuous-enabled", String(enabled));
  }, []);

  const handleSelectedDrawingChange = useCallback((drawing: SelectedDrawingMeta | null) => {
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
      drawingContinuousEnabled,
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
      handleDrawingContinuousEnabledChange,
      handleSelectedDrawingChange,
      setSelectedDrawing,
    },
  };
}
