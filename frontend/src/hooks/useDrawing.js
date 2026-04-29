/**
 * useDrawing — Unified React hook for ALL native drawing on the chart.
 *
 * Uses Lightweight Charts v5 Plugin API (ISeriesPrimitive) to render
 * everything directly inside the chart's Canvas pipeline — zero lag.
 *
 * Handles:
 *   - Freehand pen ("pen"): click-drag to draw polylines in data coords
 *   - Two-click lines ("line-segment" / "line-ray" / "line-infinite")
 *   - Text annotations ("text"): click to place, inline editing
 *   - Live preview while placing second point of a line
 *   - Selecting / dragging existing lines & text (endpoints or whole body)
 *   - Eraser ("eraser"): click to delete any drawing
 *   - Hover highlight for eraser
 *   - Delete selected element via Delete / Backspace / Escape
 *   - Double-click text to edit
 *   - Clear all drawings
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LineDrawingPrimitive } from "../components/primitives/LineDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "../components/primitives/FreehandDrawingPrimitive.js";
import { TextDrawingPrimitive } from "../components/primitives/TextDrawingPrimitive.js";
import { FibonacciDrawingPrimitive, DEFAULT_FIB_LEVELS } from "../components/primitives/FibonacciDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "../components/primitives/PositionDrawingPrimitive.js";
import { timeToCoordinateInterpolated } from "../components/primitives/coordinateUtils.js";
import { saveDrawings, loadDrawings, clearSavedDrawings } from "../services/drawingStorage.js";

const LINE_TOOL_IDS = new Set(["line-segment", "line-ray", "line-infinite"]);
const FIB_TOOL_IDS = new Set(["fibonacci"]);
const POSITION_TOOL_IDS = new Set(["position-long", "position-short"]);

let _idCounter = 0;
function nextId(prefix = "d") {
  return `${prefix}_${++_idCounter}`;
}

function setCursor(el, cursor) {
  if (el) el.style.setProperty("cursor", cursor);
}

function isTextOverlayTarget(target) {
  return target instanceof Element && !!target.closest(".text-format-bar, .text-edit-overlay");
}

const EMPTY_SELECTED_TEXT_UI = { snapshot: null, box: null };

/**
 * Build a lightweight description of the currently selected non-text drawing
 * (line / freehand / fibonacci) for the toolbar's style editor. Returns null
 * for primitives that don't expose color/lineWidth or for text (which has its
 * own dedicated UI).
 */
function selectedDrawingMetaFromPrimitive(prim) {
  if (!prim) return null;
  if (prim instanceof TextDrawingPrimitive) return null;
  if (prim instanceof PositionDrawingPrimitive) return null;
  if (typeof prim.setColor !== "function" && typeof prim.setLineWidth !== "function") {
    return null;
  }
  let type = "drawing";
  if (prim instanceof LineDrawingPrimitive) type = "line";
  else if (prim instanceof FreehandDrawingPrimitive) type = "freehand";
  else if (prim instanceof FibonacciDrawingPrimitive) type = "fibonacci";
  return {
    id: prim.id,
    type,
    color: prim.color,
    lineWidth: prim.lineWidth,
  };
}

function selectedTextUiFromPrimitive(prim) {
  if (!(prim instanceof TextDrawingPrimitive)) return EMPTY_SELECTED_TEXT_UI;
  let box = null;
  try {
    box = prim.getBoundingBoxScreen();
  } catch {
    box = null;
  }
  return {
    snapshot: {
      text: prim.text,
      color: prim.color,
      fontSize: prim.fontSize,
      fontFamily: prim.fontFamily,
      bold: prim.bold,
      italic: prim.italic,
      underline: prim.underline,
      align: prim.align,
      bgColor: prim.bgColor,
      borderColor: prim.borderColor,
      borderWidth: prim.borderWidth,
      widthPx: prim.widthPx,
      padding: prim.padding,
    },
    box,
  };
}

// ── Ramer-Douglas-Peucker point decimation ──
// Reduces freehand stroke point count by removing near-collinear
// points that don't contribute meaningfully to the curve shape.

function _perpendicularDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function _rdp(pts, eps) {
  if (pts.length <= 2) return pts;
  let maxD = 0, maxI = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = _perpendicularDist(pts[i], a, b);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > eps) {
    const left = _rdp(pts.slice(0, maxI + 1), eps);
    const right = _rdp(pts.slice(maxI), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

export function useDrawing({
  chartRef,
  seriesRef,
  chartContainerRef,
  activeTool,
  penColor,
  penSize,
  textFontSize,
  textBold,
  textItalic,
  fibLevels,
  fibInverted,
  positionSize,
  symbol,
  seriesReady,
  // Optional callback so the hook can flip the active tool back to null after
  // committing a text edit (PPT-style: clicking elsewhere exits text mode).
  onToolChange,
}) {
  const onToolChangeRef = useRef(onToolChange);
  // ── All primitives (lines + freehand strokes + text) ──
  const primitivesRef = useRef([]); // (LineDrawingPrimitive | FreehandDrawingPrimitive | TextDrawingPrimitive)[]

  // ── Line-specific state ──
  const previewRef = useRef(null); // LineDrawingPrimitive (dashed preview)
  const anchorDataRef = useRef(null); // { logical, price } first click
  const selectedIdRef = useRef(null);
  const draggingRef = useRef(null); // { id, pointIndex, startMouse, origPoints | origDataPoint }

  // ── Selected primitive ID as React state (for toolbar sync) ──
  const [selectedPrimId, setSelectedPrimId] = useState(null);
  const [selectedTextUi, setSelectedTextUi] = useState(EMPTY_SELECTED_TEXT_UI);
  const [selectedDrawingMeta, setSelectedDrawingMeta] = useState(null);

  // Whenever the selection is cleared from any of the many code paths that
  // touch `selectedPrimId`, also drop the toolbar-facing meta so the style
  // editor goes away. selectPrimitive() sets meta directly, so this only
  // needs to handle the deselect case.
  useEffect(() => {
    if (selectedPrimId == null) {
      setSelectedDrawingMeta(null);
    }
  }, [selectedPrimId]);

  // ── Freehand-specific state ──
  const currentFreehandRef = useRef(null); // FreehandDrawingPrimitive being drawn
  const isDrawingFreehandRef = useRef(false);

  // ── Text editing state ──
  const [editingTextId, setEditingTextId] = useState(null);
  // Mirror of editingTextId for use inside event handlers (avoids stale
  // React state during the same mousedown frame that just blurred the editor).
  const editingTextIdRef = useRef(null);
  const [editingTextValue, setEditingTextValue] = useState("");
  const [editingTextPos, setEditingTextPos] = useState(null); // { x, y } screen coords
  const editInputRef = useRef(null);

  // ── Tool refs (avoid stale closures) ──
  const activeToolRef = useRef(activeTool);
  const penColorRef = useRef(penColor);
  const penSizeRef = useRef(penSize);
  const textFontSizeRef = useRef(textFontSize);
  const textBoldRef = useRef(textBold);
  const textItalicRef = useRef(textItalic);
  const fibLevelsRef = useRef(fibLevels);
  const fibInvertedRef = useRef(fibInverted);
  const positionSizeRef = useRef(positionSize);

  const symbolRef = useRef(symbol);

  useEffect(() => {
    onToolChangeRef.current = onToolChange;
    activeToolRef.current = activeTool;
    penColorRef.current = penColor;
    penSizeRef.current = penSize;
    textFontSizeRef.current = textFontSize;
    textBoldRef.current = textBold;
    textItalicRef.current = textItalic;
    fibLevelsRef.current = fibLevels;
    fibInvertedRef.current = fibInverted;
    positionSizeRef.current = positionSize;
    symbolRef.current = symbol;
  }, [onToolChange, activeTool, penColor, penSize, textFontSize, textBold, textItalic, fibLevels, fibInverted, positionSize, symbol]);

  // Track previous symbol so we can detect symbol switches and swap drawing sets
  const prevSymbolRef = useRef(symbol);

  const isLineTool = LINE_TOOL_IDS.has(activeTool);
  const isFibTool = FIB_TOOL_IDS.has(activeTool);
  const isPositionTool = POSITION_TOOL_IDS.has(activeTool);
  const isPenTool = activeTool === "pen";
  const isTextTool = activeTool === "text";
  const isEraserTool = activeTool === "eraser";

  // ── Coordinate helpers ──
  // Data points are stored as { time, price } so drawings survive timeframe switches.
  // time = Unix timestamp (seconds) — computed via interpolation so it is a
  // *continuous* value (not snapped to candle boundaries). This ensures
  // drawings render at the correct position even after the user switches
  // to a different K-line interval whose candle boundaries differ.
  //
  // During rendering, primitives use the helper `timeToCoordinateInterpolated`
  // to map the continuous timestamp back to a screen x-coordinate by
  // interpolating between the two bracketing candles in the current dataset.

  /**
   * Interpolate a continuous timestamp from a fractional logical index.
   * The logical index 0 corresponds to the first visible data point,
   * 1 to the second, etc. Fractional values (e.g. 3.4) sit between
   * candles. We look up the actual candle times from the series data
   * and linearly interpolate to produce a timestamp that is independent
   * of any particular timeframe.
   */
  const logicalToInterpolatedTime = useCallback(
    (logicalIndex) => {
      const chart = chartRef?.current;
      const series = seriesRef?.current;
      if (!chart || !series) return null;

      // Get the full data array from the series
      // Lightweight Charts v5: series.data() returns the current dataset
      let seriesData;
      try {
        seriesData = series.data();
      } catch {
        return null;
      }
      if (!seriesData || seriesData.length === 0) return null;

      // Compute the offset between logical index and data array index.
      // The first data point has a logical index that depends on how much
      // the chart has been scrolled. We find it via coordinateToLogical
      // round-tripping the first data point.
      const firstTime = seriesData[0].time;
      const firstCoord = chart.timeScale().timeToCoordinate(firstTime);
      if (firstCoord == null) return null;
      const firstLogical = chart.timeScale().coordinateToLogical(firstCoord);
      if (firstLogical == null) return null;

      // dataIndex is the (fractional) index into the seriesData array
      const dataIndex = logicalIndex - firstLogical;

      const floorIdx = Math.floor(dataIndex);
      const frac = dataIndex - floorIdx;

      // Clamp / edge cases
      if (floorIdx < 0) {
        // Extrapolate before the first candle
        if (seriesData.length >= 2) {
          const dt = seriesData[1].time - seriesData[0].time;
          return seriesData[0].time + dataIndex * dt;
        }
        return seriesData[0].time;
      }
      if (floorIdx >= seriesData.length - 1) {
        // Extrapolate after the last candle
        if (seriesData.length >= 2) {
          const dt = seriesData[seriesData.length - 1].time - seriesData[seriesData.length - 2].time;
          return seriesData[seriesData.length - 1].time + (dataIndex - (seriesData.length - 1)) * dt;
        }
        return seriesData[seriesData.length - 1].time;
      }

      const tA = seriesData[floorIdx].time;
      const tB = seriesData[floorIdx + 1].time;
      return tA + frac * (tB - tA);
    },
    [chartRef, seriesRef],
  );

  const screenToData = useCallback(
    (x, y) => {
      const chart = chartRef?.current;
      const series = seriesRef?.current;
      if (!chart || !series) return null;
      try {
        const ts = chart.timeScale();
        const intLogical = ts.coordinateToLogical(x);
        const price = series.coordinateToPrice(y);
        if (intLogical == null || price == null || !isFinite(intLogical) || !isFinite(price)) return null;

        // coordinateToLogical returns an integer (snapped to nearest candle).
        // To get sub-candle precision we compute a fractional offset by
        // checking where `x` falls between the pixel positions of the
        // two bracketing integer logical indices.
        let fracLogical = intLogical;
        const x0 = ts.logicalToCoordinate(intLogical);
        if (x0 != null && isFinite(x0)) {
          // Determine which direction the fraction goes
          const delta = x - x0;
          const neighbor = delta >= 0 ? intLogical + 1 : intLogical - 1;
          const x1 = ts.logicalToCoordinate(neighbor);
          if (x1 != null && isFinite(x1)) {
            const span = Math.abs(x1 - x0);
            if (span > 0) {
              fracLogical = intLogical + delta / (x1 - x0);
            }
          }
        }

        // Compute a *continuous* timestamp by interpolating between candle
        // boundaries using the fractional logical index.
        const time = logicalToInterpolatedTime(fracLogical);

        if (time != null && isFinite(time)) {
          return { time, price };
        }

        // Fallback: try coordinateToTime (snapped)
        const snappedTime = ts.coordinateToTime(x);
        if (snappedTime != null && isFinite(snappedTime)) {
          return { time: snappedTime, price };
        }

        return { time: null, price, logical: fracLogical };
      } catch {
        return null;
      }
    },
    [chartRef, seriesRef, logicalToInterpolatedTime],
  );

  const dataToScreen = useCallback(
    (dp) => {
      const chart = chartRef?.current;
      const series = seriesRef?.current;
      if (!chart || !series || !dp) return null;
      try {
        let x = null;
        if (dp.time != null) {
          // Try exact match first (fast path)
          x = chart.timeScale().timeToCoordinate(dp.time);

          // If exact match failed, interpolate between bracketing candles
          if (x == null || !isFinite(x)) {
            x = timeToCoordinateInterpolated(chart, series, dp.time);
          }
        }
        // Fallback to logical if time-based conversion failed
        if ((x == null || !isFinite(x)) && dp.logical != null) {
          x = chart.timeScale().logicalToCoordinate(dp.logical);
        }
        const y = series.priceToCoordinate(dp.price);
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null;
        return { x, y };
      } catch {
        return null;
      }
    },
    [chartRef, seriesRef],
  );

  // ── Attach / detach primitive helpers ──

  const attachPrim = useCallback(
    (prim) => {
      const series = seriesRef?.current;
      if (!series) return;
      series.attachPrimitive(prim);
    },
    [seriesRef],
  );

  const detachPrim = useCallback(
    (prim) => {
      const series = seriesRef?.current;
      if (!series) return;
      try {
        series.detachPrimitive(prim);
      } catch {
        // may already be detached
      }
    },
    [seriesRef],
  );

  // ── Persist drawings to localStorage ──

  const persistDrawings = useCallback(() => {
    saveDrawings(symbolRef.current, primitivesRef.current);
  }, []);

  // ── Restore saved drawings when series becomes available ──
  //
  // `seriesReady` is a counter that increments each time the chart
  // (and its candlestick series) is created, or when the drawing anchor
  // series changes (e.g. indicator series rebuilt on sub-panes).
  // By depending on it we guarantee this effect fires *after* the
  // series ref is populated, even on the very first mount and after
  // any chart re-creation (e.g. theme change, page refresh).

  useEffect(() => {
    const series = seriesRef?.current;
    if (!series || !symbol || !seriesReady) return;

    const prevSymbol = prevSymbolRef.current;
    const symbolChanged = prevSymbol && prevSymbol !== symbol;

    // ── Symbol changed: swap drawing sets ──
    // Save current drawings for the *old* symbol, detach everything,
    // then load the *new* symbol's drawings from localStorage.
    if (symbolChanged) {
      // Save old symbol's drawings before clearing
      if (primitivesRef.current.length > 0) {
        saveDrawings(prevSymbol, primitivesRef.current);
      }

      // Detach all primitives from whatever series they are attached to
      for (const prim of primitivesRef.current) {
        try {
          if (prim._series) {
            try { prim._series.detachPrimitive(prim); } catch { /* already detached */ }
          }
          // Also try detaching from the current series in case _series tracking is off
          try { series.detachPrimitive(prim); } catch { /* */ }
        } catch { /* */ }
      }

      // Clear in-memory state
      primitivesRef.current = [];
      selectedIdRef.current = null;
      setSelectedPrimId(null);
      setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      draggingRef.current = null;
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;

      // Update prev symbol tracker
      prevSymbolRef.current = symbol;

      // Now fall through to load the new symbol's drawings below
    }

    // ── Same symbol, but series was recreated (e.g. theme change): re-attach ──
    if (!symbolChanged && primitivesRef.current.length > 0) {
      for (const prim of primitivesRef.current) {
        try {
          if (prim._series && prim._series !== series) {
            try { prim._series.detachPrimitive(prim); } catch { /* already detached */ }
          }
          series.attachPrimitive(prim);
        } catch (err) {
          console.warn("Failed to re-attach drawing:", err);
        }
      }
      prevSymbolRef.current = symbol;
      return;
    }

    // ── Load drawings from localStorage for current symbol ──
    const saved = loadDrawings(symbol);
    if (!saved || saved.length === 0) {
      prevSymbolRef.current = symbol;
      return;
    }

    for (const item of saved) {
      let prim = null;
      try {
        if (item.type === "line") {
          prim = new LineDrawingPrimitive({
            id: item.id || nextId("ln"),
            lineType: item.lineType,
            dataPoints: item.dataPoints,
            color: item.color,
            lineWidth: item.lineWidth,
          });
        } else if (item.type === "text") {
          prim = new TextDrawingPrimitive({
            id: item.id || nextId("tx"),
            dataPoint: item.dataPoint,
            text: item.text,
            color: item.color,
            fontSize: item.fontSize,
            fontFamily: item.fontFamily,
            bold: item.bold,
            italic: item.italic,
            // Extended (PPT-style) fields — backward compatible with old saves.
            underline: item.underline,
            align: item.align,
            bgColor: item.bgColor,
            borderColor: item.borderColor,
            borderWidth: item.borderWidth,
            widthPx: item.widthPx,
            padding: item.padding,
          });
        } else if (item.type === "fibonacci") {
          prim = new FibonacciDrawingPrimitive({
            id: item.id || nextId("fib"),
            dataPoints: item.dataPoints,
            color: item.color,
            lineWidth: item.lineWidth,
            levels: item.levels,
            inverted: item.inverted || false,
          });
        } else if (item.type === "position") {
          prim = new PositionDrawingPrimitive({
            id: item.id || nextId("pos"),
            direction: item.direction,
            entryPrice: item.entryPrice,
            tpPrice: item.tpPrice,
            slPrice: item.slPrice,
            timeRange: item.timeRange,
            positionSize: item.positionSize,
          });
        } else if (item.type === "freehand") {
          prim = new FreehandDrawingPrimitive({
            id: item.id || nextId("fh"),
            dataPoints: item.dataPoints,
            color: item.color,
            lineWidth: item.lineWidth,
          });
        }
      } catch (err) {
        console.warn("Failed to restore drawing:", err, item);
      }
      if (prim) {
        series.attachPrimitive(prim);
        primitivesRef.current.push(prim);
      }
    }

    prevSymbolRef.current = symbol;
  }, [symbol, seriesRef, seriesReady]);

  // ── Selection helpers ──

  const selectPrimitive = useCallback((id) => {
    selectedIdRef.current = id;
    setSelectedPrimId(id);
    let selectedPrim = null;
    for (const prim of primitivesRef.current) {
      if (prim instanceof LineDrawingPrimitive || prim instanceof TextDrawingPrimitive || prim instanceof FibonacciDrawingPrimitive || prim instanceof PositionDrawingPrimitive) {
        prim.setSelected(prim.id === id);
        if (prim.id === id) selectedPrim = prim;
      }
    }
    if (!selectedPrim) {
      // Freehand strokes don't have setSelected; locate by id directly
      selectedPrim = primitivesRef.current.find((p) => p.id === id) || null;
    }
    setSelectedTextUi(selectedTextUiFromPrimitive(selectedPrim));
    setSelectedDrawingMeta(selectedDrawingMetaFromPrimitive(selectedPrim));
  }, []);

  const deselectAll = useCallback(() => {
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
    setSelectedDrawingMeta(null);
    for (const prim of primitivesRef.current) {
      if (prim instanceof LineDrawingPrimitive || prim instanceof TextDrawingPrimitive || prim instanceof FibonacciDrawingPrimitive || prim instanceof PositionDrawingPrimitive) {
        prim.setSelected(false);
      }
    }
  }, []);

  const getPrimitiveById = useCallback((id) => {
    return primitivesRef.current.find((p) => p.id === id) || null;
  }, []);

  const refreshSelectedTextUi = useCallback((id = selectedIdRef.current) => {
    const prim = id ? primitivesRef.current.find((p) => p.id === id) : null;
    setSelectedTextUi(selectedTextUiFromPrimitive(prim));
  }, []);

  // ── Hit-test all primitives ──

  const hitTestAll = useCallback(
    (x, y, hitRadius = 8) => {
      // Iterate in reverse (newest on top)
      for (let i = primitivesRef.current.length - 1; i >= 0; i--) {
        const prim = primitivesRef.current[i];

        if (prim instanceof PositionDrawingPrimitive) {
          const hit = prim.hitTest(x, y);
          if (hit) return { prim, type: "position", ...hit };
        } else if (prim instanceof LineDrawingPrimitive) {
          const hit = prim.hitTest(x, y);
          if (hit) return { prim, type: "line", ...hit };
        } else if (prim instanceof FibonacciDrawingPrimitive) {
          const hit = prim.hitTest(x, y);
          if (hit) return { prim, type: "fibonacci", ...hit };
        } else if (prim instanceof FreehandDrawingPrimitive) {
          if (prim.hitTest(x, y, hitRadius)) return { prim, type: "freehand" };
        } else if (prim instanceof TextDrawingPrimitive) {
          const hit = prim.hitTest(x, y);
          if (hit) return { prim, type: "text", ...hit };
        }
      }
      return null;
    },
    [],
  );

  // ── Remove line preview ──

  const removePreview = useCallback(() => {
    if (previewRef.current) {
      detachPrim(previewRef.current);
      previewRef.current = null;
    }
    anchorDataRef.current = null;
  }, [detachPrim]);

  // ── Cancel text editing ──

  const cancelTextEditing = useCallback((opts = {}) => {
    const { clearSelection = false, exitTool = true } = opts || {};
    const wasEditing = editingTextIdRef.current;
    if (wasEditing) {
      // If text was newly created and never confirmed, drop it.
      const prim = getPrimitiveById(wasEditing);
      if (prim && prim instanceof TextDrawingPrimitive) {
        // Make the underlying canvas text visible again.
        prim.setHidden(false);
        if (!prim.text || !prim.text.trim()) {
          const idx = primitivesRef.current.indexOf(prim);
          if (idx >= 0) {
            detachPrim(prim);
            primitivesRef.current.splice(idx, 1);
          }
          if (selectedIdRef.current === wasEditing) {
            selectedIdRef.current = null;
            setSelectedPrimId(null);
            setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
          }
        }
      }
    }
    editingTextIdRef.current = null;
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    if (clearSelection) {
      deselectAll();
    }
    // PPT behavior: leaving text edit mode also leaves the text *tool*.
    if (exitTool && activeToolRef.current === "text") {
      onToolChangeRef.current?.(null);
    }
    refreshSelectedTextUi();
  }, [getPrimitiveById, detachPrim, deselectAll, refreshSelectedTextUi]);

  // ── Commit text editing ──

  const commitTextEditing = useCallback((opts = {}) => {
    const { clearSelection = false, exitTool = true } = opts || {};
    const editingId = editingTextIdRef.current;
    if (!editingId) return false;
    const prim = getPrimitiveById(editingId);
    let removed = false;
    if (prim && prim instanceof TextDrawingPrimitive) {
      // Restore canvas rendering of the underlying text.
      prim.setHidden(false);
      const value = editingTextValue;
      const trimmed = value.replace(/\s+$/g, "");
      if (trimmed) {
        prim.setText(trimmed);
      } else {
        // Empty text → delete the annotation
        const idx = primitivesRef.current.indexOf(prim);
        if (idx >= 0) {
          detachPrim(prim);
          primitivesRef.current.splice(idx, 1);
          removed = true;
        }
      }
    }
    editingTextIdRef.current = null;
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    if (clearSelection || removed) {
      deselectAll();
    } else if (prim && !removed) {
      selectPrimitive(prim.id);
    }
    if (exitTool && activeToolRef.current === "text") {
      onToolChangeRef.current?.(null);
    }
    persistDrawings();
    refreshSelectedTextUi();
    return true;
  }, [editingTextValue, getPrimitiveById, detachPrim, deselectAll, selectPrimitive, persistDrawings, refreshSelectedTextUi]);

  // ── Get mouse position relative to chart container ──

  const getChartPos = useCallback(
    (e) => {
      const container = chartContainerRef?.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top };
    },
    [chartContainerRef],
  );

  // ── Start text editing for a specific text primitive ──

  const startTextEditing = useCallback(
    (prim) => {
      if (!(prim instanceof TextDrawingPrimitive)) return;
      const screenPos = dataToScreen(prim.dataPoint);
      if (!screenPos) return;

      editingTextIdRef.current = prim.id;
      setEditingTextId(prim.id);
      setEditingTextValue(prim.text === "Text" ? "" : prim.text);
      setEditingTextPos({ x: screenPos.x, y: screenPos.y });
      // Hide the canvas-rendered text so the editable textarea doesn't
      // appear duplicated on top of it.
      prim.setHidden(true);
      selectPrimitive(prim.id);

      // Focus the input after render
      setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 30);
    },
    [dataToScreen, selectPrimitive],
  );

  const beginTextDrag = useCallback((prim, hit, pos) => {
    if (!(prim instanceof TextDrawingPrimitive) || !hit || !pos) return false;

    const box = prim.getBoundingBoxScreen();
    if (hit.handle && box) {
      draggingRef.current = {
        id: prim.id,
        type: "text-handle",
        handle: hit.handle,
        startMouse: pos,
        origBox: box,
        origFontSize: prim.fontSize,
        origWidthPx: prim.widthPx,
        origDataPoint: { ...prim.dataPoint },
      };
    } else {
      draggingRef.current = {
        id: prim.id,
        type: "text",
        startMouse: pos,
        origDataPoint: { ...prim.dataPoint },
      };
    }
    return true;
  }, []);

  // ── While editing OR a text is selected, keep both the textarea AND the
  // floating format toolbar pinned to the underlying primitive, even on
  // wheel zoom / pan / auto-scale. We piggy-back on requestAnimationFrame
  // because Lightweight Charts does not expose a single subscription that
  // covers both time-scale changes and price-scale auto-scale updates.
  useEffect(() => {
    const activeId = editingTextId || selectedPrimId;
    if (!activeId) return;

    let raf = 0;
    let lastX = NaN;
    let lastY = NaN;

    const tick = () => {
      const prim = primitivesRef.current.find((p) => p.id === activeId);
      if (prim && prim instanceof TextDrawingPrimitive) {
        const sp = dataToScreen(prim.dataPoint);
        if (sp && (Math.abs(sp.x - lastX) > 0.5 || Math.abs(sp.y - lastY) > 0.5)) {
          lastX = sp.x;
          lastY = sp.y;
          if (editingTextId === activeId) {
            setEditingTextPos({ x: sp.x, y: sp.y });
          } else {
            refreshSelectedTextUi(activeId);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editingTextId, selectedPrimId, dataToScreen, refreshSelectedTextUi]);

  // ════════════════════════════════════════════════════
  //  MOUSE DOWN
  // ════════════════════════════════════════════════════

  const handleMouseDown = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      const pos = getChartPos(e);
      if (!pos) return;

      // Editing text owns the next chart click. Commit through the same path
      // for blank clicks, text clicks, and text-tool clicks so blur does not
      // become a separate hidden state transition.
      if (editingTextIdRef.current) {
        const hit = hitTestAll(pos.x, pos.y);
        const clickedTextId = hit?.type === "text" ? hit.prim.id : null;
        commitTextEditing({ clearSelection: !clickedTextId, exitTool: true });
        if (clickedTextId && primitivesRef.current.some((p) => p.id === clickedTextId)) {
          selectPrimitive(clickedTextId);
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // No drawing tool active: PPT-style click-away deselect for text boxes,
      // OR re-grab the selected text for move/resize so the floating format
      // toolbar mode stays useful (drag body to move, drag a handle to scale).
      if (!tool && selectedIdRef.current) {
        const sel = getPrimitiveById(selectedIdRef.current);
        if (sel instanceof TextDrawingPrimitive) {
          let hit = false;
          try { hit = sel.hitTest(pos.x, pos.y); } catch { /* ignore */ }
          if (hit) {
            beginTextDrag(sel, hit, pos);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          // Clicked outside the selected text → drop selection.
          deselectAll();
        } else if (sel) {
          let stillOnIt = false;
          try {
            if (typeof sel.hitTest === "function") {
              stillOnIt = !!sel.hitTest(pos.x, pos.y);
            }
          } catch { /* ignore */ }
          if (!stillOnIt) deselectAll();
        }
      }

      // ── ERASER: click to delete ──
      if (tool === "eraser") {
        const hit = hitTestAll(pos.x, pos.y);
        if (hit) {
          const idx = primitivesRef.current.indexOf(hit.prim);
          if (idx >= 0) {
            detachPrim(hit.prim);
            primitivesRef.current.splice(idx, 1);
            if (selectedIdRef.current === hit.prim.id) {
              selectedIdRef.current = null;
              setSelectedPrimId(null);
              setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
            }
            persistDrawings();
          }
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── PEN (freehand): start stroke ──
      if (tool === "pen") {
        const dataPoint = screenToData(pos.x, pos.y);
        if (!dataPoint) return;

        const freehand = new FreehandDrawingPrimitive({
          id: nextId("fh"),
          dataPoints: [dataPoint],
          color: penColorRef.current,
          lineWidth: penSizeRef.current,
        });
        attachPrim(freehand);
        primitivesRef.current.push(freehand);
        currentFreehandRef.current = freehand;
        isDrawingFreehandRef.current = true;

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── TEXT TOOL ──
      if (tool === "text") {
        // Check if clicking on existing text → select it (or grab a handle)
        const hit = hitTestAll(pos.x, pos.y);
        if (hit && hit.type === "text") {
          selectPrimitive(hit.prim.id);
          beginTextDrag(hit.prim, hit, pos);
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
        }

        // Place new text
        const dataPoint = screenToData(pos.x, pos.y);
        if (!dataPoint) return;

        const textPrim = new TextDrawingPrimitive({
          id: nextId("tx"),
          dataPoint,
          text: "",
          color: penColorRef.current,
          fontSize: textFontSizeRef.current || 14,
          bold: textBoldRef.current || false,
          italic: textItalicRef.current || false,
        });
        attachPrim(textPrim);
        primitivesRef.current.push(textPrim);

        // Immediately open text editor
        startTextEditing(textPrim);

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── POSITION TOOLS ──
      if (POSITION_TOOL_IDS.has(tool)) {
        // Clicking on existing position → select
        const hit = hitTestAll(pos.x, pos.y);
        if (hit && hit.type === "position") {
          selectPrimitive(hit.prim.id);

          // Start dragging TP or SL handle
          if (hit.zone === "tp") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-tp",
              startMouse: pos,
              origTpPrice: hit.prim.tpPrice,
            };
          } else if (hit.zone === "sl") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-sl",
              startMouse: pos,
              origSlPrice: hit.prim.slPrice,
            };
          } else if (hit.zone === "entry" || hit.zone === "body") {
            // Drag the whole position
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-move",
              startMouse: pos,
              origEntry: hit.prim.entryPrice,
              origTp: hit.prim.tpPrice,
              origSl: hit.prim.slPrice,
              origTimeRange: { ...hit.prim.timeRange },
            };
          } else if (hit.zone === "left") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-left",
              startMouse: pos,
              origTimeRange: { ...hit.prim.timeRange },
            };
          } else if (hit.zone === "right") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-right",
              startMouse: pos,
              origTimeRange: { ...hit.prim.timeRange },
            };
          }

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Place new position: click sets entry price
        const dataA = screenToData(pos.x, pos.y);
        if (!dataA) return;

        const isLong = tool === "position-long";
        const entryPrice = dataA.price;

        // Calculate visible time range to auto-span ~30% of visible chart
        const chart = chartRef?.current;
        let startTime = dataA.time;
        let endTime = dataA.time;
        if (chart) {
          const vr = chart.timeScale().getVisibleRange();
          if (vr) {
            const visibleSpan = vr.to - vr.from;
            endTime = dataA.time + visibleSpan * 0.15;
          }
        }

        // Default TP/SL based on visible price range — ensures proper proportions on any timeframe
        let tpOffset, slOffset;
        const series = seriesRef?.current;
        if (chart && series) {
          try {
            // Get the visible price range from the chart container's pixel height
            const container = chartContainerRef?.current;
            const chartHeight = container?.clientHeight || 400;
            const topPrice = series.coordinateToPrice(0);
            const bottomPrice = series.coordinateToPrice(chartHeight);
            if (topPrice != null && bottomPrice != null && isFinite(topPrice) && isFinite(bottomPrice)) {
              const visiblePriceRange = Math.abs(topPrice - bottomPrice);
              tpOffset = visiblePriceRange * 0.12;  // TP at ~12% of visible range
              slOffset = visiblePriceRange * 0.06;   // SL at ~6% of visible range
            }
          } catch { /* fallback below */ }
        }
        // Fallback if we couldn't determine visible range
        if (!tpOffset) tpOffset = entryPrice * 0.03;
        if (!slOffset) slOffset = entryPrice * 0.015;

        const tpPrice = isLong ? entryPrice + tpOffset : entryPrice - tpOffset;
        const slPrice = isLong ? entryPrice - slOffset : entryPrice + slOffset;

        const posPrim = new PositionDrawingPrimitive({
          id: nextId("pos"),
          direction: isLong ? "long" : "short",
          entryPrice,
          tpPrice,
          slPrice,
          timeRange: { start: startTime, end: endTime },
          positionSize: positionSizeRef.current || 1000,
        });

        attachPrim(posPrim);
        primitivesRef.current.push(posPrim);
        selectPrimitive(posPrim.id);
        persistDrawings();

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── LINE/FIB TOOLS ──
      if (LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool)) {
        // Second click — commit new line/fib
        if (anchorDataRef.current && previewRef.current) {
          const dataB = screenToData(pos.x, pos.y);
          if (!dataB) return;

          // Remove preview
          detachPrim(previewRef.current);
          previewRef.current = null;

          // Create final line primitive
          let finalPrim;
          if (FIB_TOOL_IDS.has(tool)) {
             finalPrim = new FibonacciDrawingPrimitive({
                id: nextId("fib"),
                dataPoints: [anchorDataRef.current, dataB],
                color: penColorRef.current,
                lineWidth: penSizeRef.current,
                levels: fibLevelsRef.current ? fibLevelsRef.current.map((l) => ({ ...l })) : undefined,
                inverted: fibInvertedRef.current || false,
             });
          } else {
             finalPrim = new LineDrawingPrimitive({
               id: nextId("ln"),
               lineType: tool,
               dataPoints: [anchorDataRef.current, dataB],
               color: penColorRef.current,
               lineWidth: penSizeRef.current,
             });
          }
          attachPrim(finalPrim);
          primitivesRef.current.push(finalPrim);

          anchorDataRef.current = null;
          selectPrimitive(finalPrim.id);
          persistDrawings();

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Hit existing element?
        const hit = hitTestAll(pos.x, pos.y);
        if (hit && (hit.type === "line" || hit.type === "fibonacci")) {
          selectPrimitive(hit.prim.id);

          if (hit.pointIndex >= 0) {
            // Start dragging endpoint
            draggingRef.current = {
              id: hit.prim.id,
              type: hit.type,
              pointIndex: hit.pointIndex,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
            };
          } else {
            // Start dragging entire line/fib
            draggingRef.current = {
              id: hit.prim.id,
              type: hit.type,
              pointIndex: -1,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
            };
          }

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        if (hit && hit.type === "text") {
          selectPrimitive(hit.prim.id);
          draggingRef.current = {
            id: hit.prim.id,
            type: "text",
            startMouse: pos,
            origDataPoint: { ...hit.prim.dataPoint },
          };
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // First click — set anchor
        const dataA = screenToData(pos.x, pos.y);
        if (!dataA) return;
        anchorDataRef.current = dataA;

        // Create preview primitive
        let preview;
        if (FIB_TOOL_IDS.has(tool)) {
           preview = new FibonacciDrawingPrimitive({
             id: "__preview__",
             dataPoints: [dataA, dataA],
             color: penColorRef.current,
             lineWidth: penSizeRef.current,
             isPreview: true,
             levels: fibLevelsRef.current ? fibLevelsRef.current.map((l) => ({ ...l })) : undefined,
             inverted: fibInvertedRef.current || false,
           });
        } else {
           preview = new LineDrawingPrimitive({
             id: "__preview__",
             lineType: tool,
             dataPoints: [dataA, dataA],
             color: penColorRef.current,
             lineWidth: penSizeRef.current,
             isPreview: true,
           });
        }
        previewRef.current = preview;
        attachPrim(preview);

        e.preventDefault();
        e.stopPropagation();
        return;
      }
    },
    [getChartPos, screenToData, detachPrim, attachPrim, hitTestAll, selectPrimitive, deselectAll, getPrimitiveById, beginTextDrag, startTextEditing, commitTextEditing, persistDrawings, chartRef, seriesRef, chartContainerRef],
  );

  // ════════════════════════════════════════════════════
  //  DOUBLE CLICK — edit text
  // ════════════════════════════════════════════════════

  const handleDblClick = useCallback(
    (e) => {
      const pos = getChartPos(e);
      if (!pos) return;

      const hit = hitTestAll(pos.x, pos.y);
      if (hit && hit.type === "text") {
        startTextEditing(hit.prim);
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [getChartPos, hitTestAll, startTextEditing],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE MOVE
  // ════════════════════════════════════════════════════

  const handleMouseMove = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      const pos = getChartPos(e);
      if (!pos) return;

      // ── ERASER: hover highlight ──
      if (tool === "eraser") {
        let hitId = null;
        for (let i = primitivesRef.current.length - 1; i >= 0; i--) {
          const prim = primitivesRef.current[i];
          let isHit = false;
          if (prim instanceof LineDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y) != null;
          } else if (prim instanceof FibonacciDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y) != null;
          } else if (prim instanceof PositionDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y) != null;
          } else if (prim instanceof FreehandDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y);
          } else if (prim instanceof TextDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y);
          }
          if (isHit && !hitId) {
            hitId = prim.id;
            prim.setHovered(true);
          } else {
            prim.setHovered(false);
          }
        }
        return;
      }

      // ── PEN (freehand): extend stroke ──
      if (tool === "pen" && isDrawingFreehandRef.current && currentFreehandRef.current) {
        const dataPoint = screenToData(pos.x, pos.y);
        if (dataPoint) {
          currentFreehandRef.current.addPoint(dataPoint);
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── TEXT TOOL: 8-handle resize drag (corners = scale, sides = wrap width) ──
      if (draggingRef.current && draggingRef.current.type === "text-handle") {
        const { id, handle, startMouse, origBox, origFontSize, origWidthPx, origDataPoint } = draggingRef.current;
        const prim = primitivesRef.current.find((p) => p.id === id);
        if (!prim || !(prim instanceof TextDrawingPrimitive)) return;

        const dx = pos.x - startMouse.x;
        const dy = pos.y - startMouse.y;

        // Side handles ( l / r ): change widthPx, anchor the opposite vertical edge.
        if (handle === "l" || handle === "r") {
          let newWidth;
          let anchorScreenX;
          if (handle === "r") {
            newWidth = Math.max(20, origBox.width + dx);
            anchorScreenX = origBox.x; // left edge stays
          } else {
            newWidth = Math.max(20, origBox.width - dx);
            anchorScreenX = origBox.x + origBox.width - newWidth; // shift left edge to follow mouse
          }
          prim.setWidthPx(newWidth);
          if (handle === "l") {
            const newDp = screenToData(anchorScreenX, origBox.y);
            if (newDp) prim.setDataPoint(newDp);
          }
          refreshSelectedTextUi(id);
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Top / bottom handles ( t / b ): adjust font height proportionally.
        if (handle === "t" || handle === "b") {
          let scale;
          if (handle === "b") scale = (origBox.height + dy) / origBox.height;
          else scale = (origBox.height - dy) / origBox.height;
          if (!isFinite(scale)) return;
          scale = Math.max(0.2, Math.min(8, scale));
          const newSize = Math.max(8, Math.min(200, Math.round(origFontSize * scale)));
          prim.setFontSize(newSize);
          if (origWidthPx) prim.setWidthPx(Math.max(20, origWidthPx * scale));
          if (handle === "t") {
            // Top edge moves with cursor; bottom stays.
            const newBoxH = origBox.height * scale;
            const newAnchorY = origBox.y + origBox.height - newBoxH;
            const newDp = screenToData(origBox.x, newAnchorY);
            if (newDp) prim.setDataPoint({ ...newDp, time: origDataPoint.time });
          }
          refreshSelectedTextUi(id);
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Corner handles: equi-scale font + width using the larger of the two
        // axis ratios so the box visually follows the mouse on the chosen corner.
        // The opposite corner stays anchored.
        let signX = 0, signY = 0;
        if (handle === "tl") { signX = -1; signY = -1; }
        if (handle === "tr") { signX =  1; signY = -1; }
        if (handle === "bl") { signX = -1; signY =  1; }
        if (handle === "br") { signX =  1; signY =  1; }
        const scaleX = (origBox.width + signX * dx) / origBox.width;
        const scaleY = (origBox.height + signY * dy) / origBox.height;
        let scale = Math.max(scaleX, scaleY);
        if (!isFinite(scale)) return;
        scale = Math.max(0.2, Math.min(8, scale));

        const newSize = Math.max(8, Math.min(200, Math.round(origFontSize * scale)));
        prim.setFontSize(newSize);
        if (origWidthPx) prim.setWidthPx(Math.max(20, origWidthPx * scale));

        // Recompute new box top-left so the opposite corner stays put.
        const newW = origBox.width * scale;
        const newH = origBox.height * scale;
        let newAnchorX = origBox.x;
        let newAnchorY = origBox.y;
        if (handle === "tl") { newAnchorX = origBox.x + origBox.width - newW; newAnchorY = origBox.y + origBox.height - newH; }
        if (handle === "tr") { newAnchorY = origBox.y + origBox.height - newH; }
        if (handle === "bl") { newAnchorX = origBox.x + origBox.width - newW; }
        // 'br' keeps anchor unchanged
        if (newAnchorX !== origBox.x || newAnchorY !== origBox.y) {
          const newDp = screenToData(newAnchorX, newAnchorY);
          if (newDp) prim.setDataPoint(newDp);
        }
        refreshSelectedTextUi(id);
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── TEXT TOOL: dragging body ──
      if (draggingRef.current && draggingRef.current.type === "text") {
        const { id, startMouse, origDataPoint } = draggingRef.current;
        const prim = primitivesRef.current.find((p) => p.id === id);
        if (!prim || !(prim instanceof TextDrawingPrimitive)) return;

        const dx = pos.x - startMouse.x;
        const dy = pos.y - startMouse.y;
        const origScreen = dataToScreen(origDataPoint);
        if (!origScreen) return;
        const newData = screenToData(origScreen.x + dx, origScreen.y + dy);
        if (!newData) return;
        prim.setDataPoint(newData);
        refreshSelectedTextUi(id);

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── POSITION TOOL: dragging TP/SL/entry/edges ──
      if (draggingRef.current && (draggingRef.current.type === "position-tp" || draggingRef.current.type === "position-sl" || draggingRef.current.type === "position-move" || draggingRef.current.type === "position-left" || draggingRef.current.type === "position-right")) {
        const { id, type } = draggingRef.current;
        const prim = primitivesRef.current.find((p) => p.id === id);
        if (!prim || !(prim instanceof PositionDrawingPrimitive)) return;

        const dataPoint = screenToData(pos.x, pos.y);
        if (!dataPoint) return;

        if (type === "position-tp") {
          const isLong = prim.direction === "long";
          let newTp = dataPoint.price;
          // Clamp: TP cannot cross entry
          if (isLong) newTp = Math.max(newTp, prim.entryPrice);
          else newTp = Math.min(newTp, prim.entryPrice);
          prim.setTpPrice(newTp);
        } else if (type === "position-sl") {
          const isLong = prim.direction === "long";
          let newSl = dataPoint.price;
          // Clamp: SL cannot cross entry
          if (isLong) newSl = Math.min(newSl, prim.entryPrice);
          else newSl = Math.max(newSl, prim.entryPrice);
          prim.setSlPrice(newSl);
        } else if (type === "position-left") {
          // Drag left edge: update timeRange.start
          prim.setTimeRange({ ...prim.timeRange, start: dataPoint.time });
        } else if (type === "position-right") {
          // Drag right edge: update timeRange.end
          prim.setTimeRange({ ...prim.timeRange, end: dataPoint.time });
        } else if (type === "position-move") {
          const { origEntry, origTp, origSl, startMouse: sm, origTimeRange } = draggingRef.current;
          const dy = pos.y - sm.y;
          const dx = pos.x - sm.x;
          // Convert dy to price difference
          const origScreen = dataToScreen({ time: origTimeRange.start, price: origEntry });
          if (origScreen) {
            const newEntryData = screenToData(origScreen.x + dx, origScreen.y + dy);
            if (newEntryData) {
              const priceDelta = newEntryData.price - origEntry;
              prim.setEntryPrice(origEntry + priceDelta);
              if (origTp != null) prim.setTpPrice(origTp + priceDelta);
              if (origSl != null) prim.setSlPrice(origSl + priceDelta);
              // Also shift time range horizontally
              const timeDelta = newEntryData.time - origTimeRange.start;
              prim.setTimeRange({
                start: origTimeRange.start + timeDelta,
                end: origTimeRange.end + timeDelta,
              });
            }
          }
        }

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── LINE / FIB TOOLS ──
      if (LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool)) {
        // Dragging
        if (draggingRef.current) {
          const { id, type, pointIndex, startMouse, origPoints, origDataPoint } = draggingRef.current;
          const prim = primitivesRef.current.find((p) => p.id === id);
          if (!prim) return;

          if (type === "text" && prim instanceof TextDrawingPrimitive) {
            const dx = pos.x - startMouse.x;
            const dy = pos.y - startMouse.y;
            const origScreen = dataToScreen(origDataPoint);
            if (!origScreen) return;
            const newData = screenToData(origScreen.x + dx, origScreen.y + dy);
            if (!newData) return;
            prim.setDataPoint(newData);
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (!(prim instanceof LineDrawingPrimitive) && !(prim instanceof FibonacciDrawingPrimitive)) return;

          if (pointIndex >= 0) {
            // Drag single endpoint
            const newData = screenToData(pos.x, pos.y);
            if (!newData) return;
            const newPoints = [...prim.dataPoints];
            newPoints[pointIndex] = newData;
            prim.setDataPoints(newPoints);
          } else {
            // Move entire line
            const dx = pos.x - startMouse.x;
            const dy = pos.y - startMouse.y;
            const sa0 = dataToScreen(origPoints[0]);
            const sb0 = dataToScreen(origPoints[1]);
            if (!sa0 || !sb0) return;
            const newA = screenToData(sa0.x + dx, sa0.y + dy);
            const newB = screenToData(sb0.x + dx, sb0.y + dy);
            if (!newA || !newB) return;
            prim.setDataPoints([newA, newB]);
          }

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Preview line: update second point
        if (anchorDataRef.current && previewRef.current) {
          const dataB = screenToData(pos.x, pos.y);
          if (dataB) {
            previewRef.current.setDataPoints([anchorDataRef.current, dataB]);
          }
          return;
        }

        // Hover feedback on lines, fibs and text
        const hit = hitTestAll(pos.x, pos.y);
        for (const prim of primitivesRef.current) {
          if (prim instanceof LineDrawingPrimitive || prim instanceof FibonacciDrawingPrimitive || prim instanceof PositionDrawingPrimitive) {
            prim.setHovered(hit?.prim?.id === prim.id);
          }
        }
      }

      // ── POSITION TOOL: hover feedback ──
      if (POSITION_TOOL_IDS.has(tool) && !draggingRef.current) {
        const container = chartContainerRef?.current;
        if (container) {
          const hit = hitTestAll(pos.x, pos.y);
          if (hit?.type === "position") {
            if (hit.zone === "tp" || hit.zone === "sl") {
              setCursor(container, "ns-resize");
            } else if (hit.zone === "left" || hit.zone === "right") {
              setCursor(container, "ew-resize");
            } else if (hit.zone === "entry" || hit.zone === "body") {
              setCursor(container, "move");
            }
          } else {
            setCursor(container, "crosshair");
          }
          // Hover feedback
          for (const prim of primitivesRef.current) {
            if (prim instanceof PositionDrawingPrimitive) {
              prim.setHovered(hit?.prim?.id === prim.id);
            }
          }
        }
      }

      // ── TEXT TOOL: hover feedback for existing text + handle cursors ──
      if (tool === "text" && !draggingRef.current) {
        const container = chartContainerRef?.current;
        if (container) {
          const hit = hitTestAll(pos.x, pos.y);
          if (hit?.type === "text") {
            if (hit.handle === "l" || hit.handle === "r") setCursor(container, "ew-resize");
            else if (hit.handle === "t" || hit.handle === "b") setCursor(container, "ns-resize");
            else if (hit.handle === "tl" || hit.handle === "br") setCursor(container, "nwse-resize");
            else if (hit.handle === "tr" || hit.handle === "bl") setCursor(container, "nesw-resize");
            else setCursor(container, "move");
          } else {
            setCursor(container, "crosshair");
          }
        }
      }
    },
    [getChartPos, screenToData, dataToScreen, hitTestAll, refreshSelectedTextUi, chartContainerRef],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE UP
  // ════════════════════════════════════════════════════

  const handleMouseUp = useCallback(() => {
    let changed = false;
    // End freehand drawing
    if (isDrawingFreehandRef.current) {
      // ── Decimate stroke via RDP to reduce render cost ──
      const prim = currentFreehandRef.current;
      if (prim && prim.dataPoints.length > 3) {
        // Convert data points to screen coordinates for pixel-space RDP
        const indexed = [];
        for (let i = 0; i < prim.dataPoints.length; i++) {
          const s = dataToScreen(prim.dataPoints[i]);
          if (s) indexed.push({ x: s.x, y: s.y, _i: i });
        }
        if (indexed.length > 3) {
          const kept = _rdp(indexed, 1.5); // ~1.5px tolerance
          const decimated = kept.map((sp) => prim.dataPoints[sp._i]);
          prim.setDataPoints(decimated);
        }
      }
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
      changed = true;
    }
    // End dragging
    if (draggingRef.current) {
      draggingRef.current = null;
      changed = true;
    }
    if (changed) {
      persistDrawings();
    }
  }, [persistDrawings, dataToScreen]);

  const handleMouseLeave = useCallback((e) => {
    // Text overlays are siblings of the chart canvas container. Moving the
    // pointer over the floating format/edit bar fires mouseleave on the chart
    // container, but it should not terminate an in-progress text drag/resize.
    if (draggingRef.current && isTextOverlayTarget(e.relatedTarget)) {
      return;
    }
    handleMouseUp();
  }, [handleMouseUp]);

  // ── RIGHT-CLICK: cancel line placement ──

  const handleContextMenu = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      if ((LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool)) && anchorDataRef.current) {
        e.preventDefault();
        removePreview();
      }
    },
    [removePreview],
  );

  // ── KEYBOARD: Escape / Delete ──

  useEffect(() => {
    if (!isLineTool && !isFibTool && !isPenTool && !isEraserTool && !isTextTool && !isPositionTool && !selectedPrimId && !editingTextId) return;

    const handleKeyDown = (e) => {
      // Don't intercept if editing text
      if (editingTextIdRef.current) return;

      if (e.key === "Escape") {
        if (anchorDataRef.current) {
          removePreview();
        } else if (selectedIdRef.current) {
          deselectAll();
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIdRef.current) {
        // Don't delete if focused on an input
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;

        const id = selectedIdRef.current;
        const idx = primitivesRef.current.findIndex((p) => p.id === id);
        if (idx >= 0) {
          detachPrim(primitivesRef.current[idx]);
          primitivesRef.current.splice(idx, 1);
          persistDrawings();
        }
        selectedIdRef.current = null;
        setSelectedPrimId(null);
        setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isLineTool, isFibTool, isPenTool, isEraserTool, isTextTool, isPositionTool, selectedPrimId, editingTextId, removePreview, deselectAll, detachPrim, persistDrawings]);

  // ── Clean up when tool changes ──

  useEffect(() => {
    if (!isLineTool && !isFibTool) {
      removePreview();
      draggingRef.current = null;
    }
    if (!isLineTool && !isFibTool && !isTextTool && !isPositionTool) {
      // Keep a currently-selected text primitive selected even after we
      // leave the text tool — so the floating format toolbar remains
      // visible right after committing a freshly-created text annotation
      // (PPT-style "click out of edit mode → still selected").
      const sel = selectedIdRef.current
        ? primitivesRef.current.find((p) => p.id === selectedIdRef.current)
        : null;
      if (!(sel instanceof TextDrawingPrimitive)) {
        deselectAll();
      }
    }
    if (!isPenTool) {
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
    }
    if (!isTextTool) {
      cancelTextEditing();
    }
    if (!isEraserTool) {
      // Clear hover state
      for (const prim of primitivesRef.current) {
        prim.setHovered(false);
      }
    }
  }, [isLineTool, isFibTool, isPenTool, isEraserTool, isTextTool, isPositionTool, removePreview, deselectAll, cancelTextEditing]);

  // ── Attach event listeners to chart container ──

  useEffect(() => {
    const container = chartContainerRef?.current;
    if (!container) return;

    container.addEventListener("mousedown", handleMouseDown, true);
    // Listen for mousemove/mouseup on `document` in the CAPTURE phase so we
    // run *before* any sibling React component (e.g. the floating
    // TextFormatBar / TextEditOverlay) calls stopPropagation on its own
    // mouseup handler. Without capture, releasing the mouse while the
    // cursor is over those overlays would silently drop the mouseup and
    // leave the drag stuck mid-motion.
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    container.addEventListener("mouseleave", handleMouseLeave);
    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("contextmenu", handleContextMenu);
    container.addEventListener("touchstart", handleMouseDown, { passive: false, capture: true });
    container.addEventListener("touchmove", handleMouseMove, { passive: false });
    container.addEventListener("touchend", handleMouseUp);
    container.addEventListener("touchcancel", handleMouseUp);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
      container.removeEventListener("mouseleave", handleMouseLeave);
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("touchstart", handleMouseDown, true);
      container.removeEventListener("touchmove", handleMouseMove);
      container.removeEventListener("touchend", handleMouseUp);
      container.removeEventListener("touchcancel", handleMouseUp);
    };
  }, [chartContainerRef, handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeave, handleDblClick, handleContextMenu]);

  // ── Public API ──

  /** Clear all drawings (lines + freehand + text) */
  const clearAll = useCallback(() => {
    for (const prim of primitivesRef.current) {
      detachPrim(prim);
    }
    primitivesRef.current = [];
    removePreview();
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
    draggingRef.current = null;
    isDrawingFreehandRef.current = false;
    currentFreehandRef.current = null;
    cancelTextEditing();
    clearSavedDrawings(symbolRef.current);
  }, [detachPrim, removePreview, cancelTextEditing]);

  // ── Selected-text helpers (consumed by floating format toolbar) ──

  /**
   * Apply a partial style/text patch to the currently selected text primitive.
   * Triggers persistence + a React re-render of the format bar snapshot.
   */
  const updateSelectedText = useCallback((patch) => {
    const id = selectedIdRef.current;
    if (!id) return;
    const prim = getPrimitiveById(id);
    if (!prim || !(prim instanceof TextDrawingPrimitive)) return;
    const changed = prim.applyPatch(patch);
    if (changed) {
      refreshSelectedTextUi(id);
      persistDrawings();
    }
  }, [getPrimitiveById, refreshSelectedTextUi, persistDrawings]);

  /** Delete the currently selected primitive (any type). */
  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    const idx = primitivesRef.current.findIndex((p) => p.id === id);
    if (idx < 0) return;
    detachPrim(primitivesRef.current[idx]);
    primitivesRef.current.splice(idx, 1);
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
    persistDrawings();
  }, [detachPrim, persistDrawings]);

  /**
   * Update the color and/or lineWidth of the currently selected
   * line / freehand / fibonacci drawing. Persists the change and refreshes
   * the toolbar's meta snapshot.
   */
  const updateSelectedDrawingStyle = useCallback((patch) => {
    const id = selectedIdRef.current;
    if (!id || !patch) return;
    const prim = primitivesRef.current.find((p) => p.id === id);
    if (!prim) return;
    let changed = false;
    if (typeof patch.color === "string" && typeof prim.setColor === "function" && patch.color !== prim.color) {
      prim.setColor(patch.color);
      changed = true;
    }
    if (typeof patch.lineWidth === "number" && typeof prim.setLineWidth === "function" && patch.lineWidth !== prim.lineWidth) {
      prim.setLineWidth(patch.lineWidth);
      changed = true;
    }
    if (changed) {
      setSelectedDrawingMeta(selectedDrawingMetaFromPrimitive(prim));
      persistDrawings();
    }
  }, [persistDrawings]);

  const selectedTextSnapshot = selectedTextUi.snapshot;
  const selectedTextBox = selectedTextUi.box;

  return {
    clearAll,
    primitivesRef,
    selectedPrimId,
    selectedDrawingMeta,
    // Text editing state (for rendering the inline editor in the component)
    editingTextId,
    editingTextValue,
    editingTextPos,
    setEditingTextValue,
    commitTextEditing,
    cancelTextEditing,
    editInputRef,
    // Selected-text bag (for the floating format toolbar)
    selectedTextSnapshot,
    selectedTextBox,
    updateSelectedText,
    updateSelectedDrawingStyle,
    deleteSelected,
  };
}

export default useDrawing;
