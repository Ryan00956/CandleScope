/**
 * useDrawing — Unified React hook for ALL native drawing on the chart.
 *
 * Uses Lightweight Charts v5 Plugin API (ISeriesPrimitive) to render
 * everything directly inside the chart's Canvas pipeline — zero lag.
 *
 * Handles:
 *   - Freehand pen ("pen") and highlighter ("highlighter"): click-drag polylines in data coords
 *   - Two-click lines ("line-segment" / "line-ray" / "line-infinite")
 *   - One-point axis lines ("line-horizontal" / "line-vertical" / "line-cross")
 *   - Angle measurement ("angle-measure") with a visual degree label
 *   - Text annotations ("text"): click to place, inline editing
 *   - Live preview while placing second point of a line
 *   - Magnet snapping to nearby candle OHLC / series values (except pen)
 *   - Selecting / dragging existing lines & text (endpoints or whole body)
 *   - Eraser ("eraser"): click to delete any drawing
 *   - Hover highlight for eraser
 *   - Delete selected element via Delete / Backspace / Escape
 *   - Double-click text to edit
 *   - Clear all drawings
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LineDrawingPrimitive } from "../../components/primitives/LineDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "../../components/primitives/FreehandDrawingPrimitive.js";
import { TextDrawingPrimitive } from "../../components/primitives/TextDrawingPrimitive.js";
import { FibonacciDrawingPrimitive } from "../../components/primitives/FibonacciDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "../../components/primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "../../components/primitives/ShapeDrawingPrimitive.js";
import { AxisLineDrawingPrimitive } from "../../components/primitives/AxisLineDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "../../components/primitives/AngleMeasurementPrimitive.js";
import { clearSavedDrawings } from "./drawingPersistence.js";
import {
  AXIS_LINE_TOOL_IDS,
  FIB_TOOL_IDS,
  LINE_TOOL_IDS,
  POSITION_TOOL_IDS,
  SHAPE_TOOL_IDS,
  axisLineTypeFromTool,
  constrainShapeScreenPoint,
  cursorStyleForPassiveTool,
  decimateScreenPoints,
  isPassiveCursorTool,
  isTextOverlayTarget,
  resizedShapeBoxFromHandle,
  setCursor,
  shapeTypeFromTool,
} from "./drawingModel.js";
import {
  EMPTY_SELECTED_TEXT_UI,
  hitTestDrawingPrimitives,
  isSelectablePrimitive,
  selectedDrawingMetaFromPrimitive,
  selectedTextUiFromPrimitive,
} from "./drawingSelectionController.js";
import {
  createAxisLinePrimitive,
  createFreehandPrimitive,
  createPositionPrimitive,
  createPreviewPrimitive,
  createTextPrimitive,
  createTwoPointDrawingPrimitive,
} from "./drawingPrimitiveFactory.js";
import { snapDataPointAtPointer } from "./drawingSnapController.js";
import { useDrawingPersistenceLifecycle } from "./useDrawingPersistenceLifecycle.js";

export function useDrawing({
  chartAdapter,
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
  drawingSnapEnabled = true,
  symbol,
  seriesReady,
  // Optional callback so the hook can flip the active tool back to null after
  // committing a text edit (PPT-style: clicking elsewhere exits text mode).
  onToolChange,
}) {
  const onToolChangeRef = useRef(onToolChange);
  const getChartAdapter = useCallback(() => chartAdapter || null, [chartAdapter]);
  // ── All primitives (lines + freehand strokes + text) ──
  const primitivesRef = useRef([]); // (LineDrawingPrimitive | FreehandDrawingPrimitive | TextDrawingPrimitive)[]

  // ── Visibility toggle (hide all without deleting) ──
  const hiddenRef = useRef(false);

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
  const drawingSnapEnabledRef = useRef(drawingSnapEnabled);

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
    drawingSnapEnabledRef.current = drawingSnapEnabled;
    symbolRef.current = symbol;
  }, [onToolChange, activeTool, penColor, penSize, textFontSize, textBold, textItalic, fibLevels, fibInverted, positionSize, drawingSnapEnabled, symbol]);

  // Track previous symbol so we can detect symbol switches and swap drawing sets
  const prevSymbolRef = useRef(symbol);

  const isLineTool = LINE_TOOL_IDS.has(activeTool);
  const isFibTool = FIB_TOOL_IDS.has(activeTool);
  const isPositionTool = POSITION_TOOL_IDS.has(activeTool);
  const isShapeTool = SHAPE_TOOL_IDS.has(activeTool);
  const isPenTool = activeTool === "pen";
  const isHighlighterTool = activeTool === "highlighter";
  const isTextTool = activeTool === "text";
  const isEraserTool = activeTool === "eraser";

  useEffect(() => {
    const container = chartContainerRef?.current;
    if (!container || !isPassiveCursorTool(activeTool)) return;
    setCursor(container, cursorStyleForPassiveTool(activeTool));
  }, [activeTool, chartContainerRef]);

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
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.()) return null;

      // Get the full data array from the series
      // Lightweight Charts v5: series.data() returns the current dataset
      const seriesData = adapter.getSeriesData?.();
      if (!seriesData || seriesData.length === 0) return null;

      // Compute the offset between logical index and data array index.
      // The first data point has a logical index that depends on how much
      // the chart has been scrolled. We find it via coordinateToLogical
      // round-tripping the first data point.
      const firstTime = seriesData[0].time;
      const firstCoord = adapter.timeToCoordinate?.(firstTime);
      if (firstCoord == null) return null;
      const firstLogical = adapter.coordinateToLogical?.(firstCoord);
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
    [getChartAdapter],
  );

  const screenToData = useCallback(
    (x, y) => {
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.()) return null;
      try {
        const intLogical = adapter.coordinateToLogical?.(x);
        const price = adapter.coordinateToPrice?.(y);
        if (intLogical == null || price == null || !isFinite(intLogical) || !isFinite(price)) return null;

        // coordinateToLogical returns an integer (snapped to nearest candle).
        // To get sub-candle precision we compute a fractional offset by
        // checking where `x` falls between the pixel positions of the
        // two bracketing integer logical indices.
        let fracLogical = intLogical;
        const x0 = adapter.logicalToCoordinate?.(intLogical);
        if (x0 != null && isFinite(x0)) {
          // Determine which direction the fraction goes
          const delta = x - x0;
          const neighbor = delta >= 0 ? intLogical + 1 : intLogical - 1;
          const x1 = adapter.logicalToCoordinate?.(neighbor);
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
  const snappedTime = adapter.coordinateToTime?.(x);
        if (snappedTime != null && isFinite(snappedTime)) {
          return { time: snappedTime, price };
        }

        return { time: null, price, logical: fracLogical };
      } catch {
        return null;
      }
    },
    [getChartAdapter, logicalToInterpolatedTime],
  );

  const dataToScreen = useCallback(
    (dp) => {
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.() || !dp) return null;
      try {
        let x = null;
        if (dp.time != null) {
          // Try exact match first (fast path)
          x = adapter.timeToCoordinate?.(dp.time);

          // If exact match failed, interpolate between bracketing candles
          if (x == null || !isFinite(x)) {
            x = adapter.timeToCoordinateInterpolated?.(dp.time);
          }
        }
        // Fallback to logical if time-based conversion failed
        if ((x == null || !isFinite(x)) && dp.logical != null) {
          x = adapter.logicalToCoordinate?.(dp.logical);
        }
        const y = adapter.priceToCoordinate?.(dp.price);
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null;
        return { x, y };
      } catch {
        return null;
      }
    },
    [getChartAdapter],
  );

  const snapDataPoint = useCallback(
    (dataPoint, x, y, options = {}) => {
      if (!dataPoint || options.snap === false) return dataPoint;
      const allowTime = options.time !== false;
      const allowPrice = options.price !== false;
      if (!allowTime && !allowPrice) return dataPoint;

      return snapDataPointAtPointer(dataPoint, x, y, options, getChartAdapter());
    },
    [getChartAdapter],
  );

  const screenToDrawingData = useCallback(
    (x, y, options = {}) => {
      const dataPoint = screenToData(x, y);
      if (!dataPoint) return null;
      return snapDataPoint(dataPoint, x, y, options);
    },
    [screenToData, snapDataPoint],
  );

  // ── Attach / detach primitive helpers ──

  const attachPrim = useCallback(
    (prim) => {
      const adapter = getChartAdapter();
      if (!adapter?.hasSeries?.()) return;
      prim.setHidden?.(hiddenRef.current, false);
      adapter.attachPrimitive?.(prim);
    },
    [getChartAdapter],
  );

  const detachPrim = useCallback(
    (prim) => {
      const adapter = getChartAdapter();
      adapter?.detachPrimitive?.(prim);
    },
    [getChartAdapter],
  );

  const { persistDrawings } = useDrawingPersistenceLifecycle({
    currentFreehandRef,
    draggingRef,
    getChartAdapter,
    hiddenRef,
    isDrawingFreehandRef,
    prevSymbolRef,
    primitivesRef,
    selectedIdRef,
    seriesReady,
    setSelectedPrimId,
    setSelectedTextUi,
    symbol,
    symbolRef,
  });

  // ── Selection helpers ──

  const selectPrimitive = useCallback((id) => {
    selectedIdRef.current = id;
    setSelectedPrimId(id);
    let selectedPrim = null;
    for (const prim of primitivesRef.current) {
      if (isSelectablePrimitive(prim)) {
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
      if (isSelectablePrimitive(prim)) {
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
      return hitTestDrawingPrimitives(primitivesRef.current, x, y, hitRadius);
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

      // Passive cursor mode: PPT-style click-away deselect for text boxes,
      // OR re-grab the selected text for move/resize so the floating format
      // toolbar mode stays useful (drag body to move, drag a handle to scale).
      if (isPassiveCursorTool(tool) && selectedIdRef.current) {
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

      // ── PEN / HIGHLIGHTER (freehand): start stroke ──
      if (tool === "pen" || tool === "highlighter") {
        const dataPoint = screenToData(pos.x, pos.y);
        if (!dataPoint) return;
        const freehand = createFreehandPrimitive({
          tool,
          dataPoint,
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
        const dataPoint = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
        if (!dataPoint) return;

        const textPrim = createTextPrimitive({
          dataPoint,
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
          } else if (hit.zone === "panel") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-panel",
              startMouse: pos,
              origInfoPanelOffset: { ...hit.prim.infoPanelOffset },
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
        const dataA = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
        if (!dataA) return;

        const entryPrice = dataA.price;

        // Calculate visible time range to auto-span ~30% of visible chart
        const adapter = getChartAdapter();
        let startTime = dataA.time;
        let endTime = dataA.time;
        if (adapter?.isReady?.()) {
          const vr = adapter.getVisibleTimeRange?.();
          if (vr) {
            const visibleSpan = vr.to - vr.from;
            endTime = dataA.time + visibleSpan * 0.15;
          }
        }

        // Default TP/SL based on visible price range — ensures proper proportions on any timeframe
        let tpOffset, slOffset;
        if (adapter?.isReady?.()) {
          try {
            // Get the visible price range from the chart container's pixel height
            const container = chartContainerRef?.current;
            const chartHeight = container?.clientHeight || 400;
            const visiblePriceRange = adapter.getVisiblePriceRange?.(chartHeight);
            if (visiblePriceRange != null && isFinite(visiblePriceRange)) {
              tpOffset = visiblePriceRange * 0.12;  // TP at ~12% of visible range
              slOffset = visiblePriceRange * 0.06;   // SL at ~6% of visible range
            }
          } catch { /* fallback below */ }
        }
        // Fallback if we couldn't determine visible range
        if (!tpOffset) tpOffset = entryPrice * 0.03;
        if (!slOffset) slOffset = entryPrice * 0.015;

        const posPrim = createPositionPrimitive({
          tool,
          dataPoint: dataA,
          timeRange: { start: startTime, end: endTime },
          tpOffset,
          slOffset,
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

      // ── LINE/FIB/SHAPE TOOLS ──
      if (LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool) || SHAPE_TOOL_IDS.has(tool)) {
        const isAxisLineTool = AXIS_LINE_TOOL_IDS.has(tool);
        const isShapeDrawingTool = SHAPE_TOOL_IDS.has(tool);
        const shapeType = shapeTypeFromTool(tool);

        // Second click — commit new line/fib/shape
        if (!isAxisLineTool && anchorDataRef.current && previewRef.current) {
          let targetPos = pos;
          if (isShapeDrawingTool && e.shiftKey) {
            const anchorScreen = dataToScreen(anchorDataRef.current);
            targetPos = constrainShapeScreenPoint(anchorScreen, pos);
          }
          const dataB = screenToDrawingData(targetPos.x, targetPos.y, { snap: drawingSnapEnabledRef.current && !e.altKey && !(isShapeDrawingTool && e.shiftKey) });
          if (!dataB) return;

          // Remove preview
          detachPrim(previewRef.current);
          previewRef.current = null;

          const finalPrim = createTwoPointDrawingPrimitive({
            tool,
            shapeType: isShapeDrawingTool ? shapeType : null,
            dataPoints: [anchorDataRef.current, dataB],
            color: penColorRef.current,
            lineWidth: penSizeRef.current,
            fibLevels: fibLevelsRef.current,
            fibInverted: fibInvertedRef.current,
          });
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
        if (hit && (hit.type === "line" || hit.type === "axis-line" || hit.type === "angle" || hit.type === "fibonacci" || hit.type === "shape")) {
          selectPrimitive(hit.prim.id);

          if (hit.type === "axis-line") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "axis-line",
              zone: hit.zone || "body",
              startMouse: pos,
              origDataPoint: { ...hit.prim.dataPoint },
            };
          } else if (hit.type === "shape") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "shape",
              zone: hit.zone || "body",
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
              origBox: hit.prim.getBoundingBoxScreen?.() || null,
            };
          } else if (hit.pointIndex >= 0) {
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

        // One-point axis lines: click creates immediately; drag before mouseup adjusts it.
        if (isAxisLineTool) {
          if (anchorDataRef.current || previewRef.current) {
            removePreview();
          }
          const axisLineType = axisLineTypeFromTool(tool);
          const dataA = screenToDrawingData(pos.x, pos.y, {
            snap: drawingSnapEnabledRef.current && !e.altKey,
            time: axisLineType !== "horizontal",
            price: axisLineType !== "vertical",
          });
          if (!dataA) return;

          const axisPrim = createAxisLinePrimitive({
            axisLineType,
            dataPoint: dataA,
            color: penColorRef.current,
            lineWidth: penSizeRef.current,
          });
          attachPrim(axisPrim);
          primitivesRef.current.push(axisPrim);
          selectPrimitive(axisPrim.id);
          draggingRef.current = {
            id: axisPrim.id,
            type: "axis-line",
            zone: "center",
            startMouse: pos,
            origDataPoint: { ...dataA },
          };

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // First click — set anchor
        const dataA = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
        if (!dataA) return;
        anchorDataRef.current = dataA;

        const preview = createPreviewPrimitive({
          tool,
          shapeType: isShapeDrawingTool ? shapeType : null,
          dataPoint: dataA,
          color: penColorRef.current,
          lineWidth: penSizeRef.current,
          fibLevels: fibLevelsRef.current,
          fibInverted: fibInvertedRef.current,
        });
        previewRef.current = preview;
        attachPrim(preview);

        e.preventDefault();
        e.stopPropagation();
        return;
      }
    },
    [getChartPos, screenToData, screenToDrawingData, dataToScreen, detachPrim, attachPrim, hitTestAll, selectPrimitive, deselectAll, getPrimitiveById, beginTextDrag, startTextEditing, commitTextEditing, persistDrawings, removePreview, getChartAdapter, chartContainerRef],
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
          } else if (prim instanceof AxisLineDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y) != null;
          } else if (prim instanceof AngleMeasurementPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y) != null;
          } else if (prim instanceof FibonacciDrawingPrimitive) {
            isHit = prim.hitTest(pos.x, pos.y) != null;
          } else if (prim instanceof ShapeDrawingPrimitive) {
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

      // ── PEN / HIGHLIGHTER (freehand): extend stroke ──
      if ((tool === "pen" || tool === "highlighter") && isDrawingFreehandRef.current && currentFreehandRef.current) {
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
        const newData = screenToDrawingData(origScreen.x + dx, origScreen.y + dy, { snap: drawingSnapEnabledRef.current && !e.altKey });
        if (!newData) return;
        prim.setDataPoint(newData);
        refreshSelectedTextUi(id);

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── POSITION TOOL: dragging TP/SL/entry/edges/info panel ──
      if (draggingRef.current && (draggingRef.current.type === "position-tp" || draggingRef.current.type === "position-sl" || draggingRef.current.type === "position-move" || draggingRef.current.type === "position-left" || draggingRef.current.type === "position-right" || draggingRef.current.type === "position-panel")) {
        const { id, type } = draggingRef.current;
        const prim = primitivesRef.current.find((p) => p.id === id);
        if (!prim || !(prim instanceof PositionDrawingPrimitive)) return;

        if (type === "position-panel") {
          const { startMouse, origInfoPanelOffset } = draggingRef.current;
          prim.setInfoPanelOffset({
            x: origInfoPanelOffset.x + (pos.x - startMouse.x),
            y: origInfoPanelOffset.y + (pos.y - startMouse.y),
          });
          setCursor(chartContainerRef?.current, "grabbing");
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        const dataPoint = type === "position-move"
          ? screenToData(pos.x, pos.y)
          : screenToDrawingData(pos.x, pos.y, {
              snap: drawingSnapEnabledRef.current && !e.altKey,
              time: type === "position-left" || type === "position-right",
              price: type !== "position-left" && type !== "position-right",
            });
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
            const newEntryData = screenToDrawingData(origScreen.x + dx, origScreen.y + dy, { snap: drawingSnapEnabledRef.current && !e.altKey });
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

      // ── LINE / FIB / SHAPE TOOLS ──
      if (LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool) || SHAPE_TOOL_IDS.has(tool)) {
        // Dragging
        if (draggingRef.current) {
          const { id, type, pointIndex, startMouse, origPoints, origDataPoint, zone, origBox } = draggingRef.current;
          const prim = primitivesRef.current.find((p) => p.id === id);
          if (!prim) return;

          if (type === "text" && prim instanceof TextDrawingPrimitive) {
            const dx = pos.x - startMouse.x;
            const dy = pos.y - startMouse.y;
            const origScreen = dataToScreen(origDataPoint);
            if (!origScreen) return;
            const newData = screenToDrawingData(origScreen.x + dx, origScreen.y + dy, { snap: drawingSnapEnabledRef.current && !e.altKey });
            if (!newData) return;
            prim.setDataPoint(newData);
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (type === "axis-line" && prim instanceof AxisLineDrawingPrimitive) {
            const axisLineType = prim.axisLineType;
            const dataPoint = screenToDrawingData(pos.x, pos.y, {
              snap: drawingSnapEnabledRef.current && !e.altKey,
              time: axisLineType !== "horizontal",
              price: axisLineType !== "vertical",
            });
            if (!dataPoint) return;
            const basePoint = origDataPoint || prim.dataPoint || dataPoint;
            let nextPoint = dataPoint;
            if (axisLineType === "horizontal") {
              nextPoint = { ...basePoint, price: dataPoint.price };
            } else if (axisLineType === "vertical") {
              nextPoint = { ...basePoint, time: dataPoint.time, logical: dataPoint.logical };
            }
            prim.setDataPoint(nextPoint);
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (type === "shape" && prim instanceof ShapeDrawingPrimitive) {
            if (zone && zone !== "body" && origBox) {
              const nextBox = resizedShapeBoxFromHandle(origBox, zone, pos);
              if (!nextBox) return;
              const newA = screenToData(nextBox.x, nextBox.y);
              const newB = screenToData(nextBox.x + nextBox.width, nextBox.y + nextBox.height);
              if (!newA || !newB) return;
              prim.setDataPoints([newA, newB]);
            } else {
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

          if (!(prim instanceof LineDrawingPrimitive) && !(prim instanceof FibonacciDrawingPrimitive) && !(prim instanceof AngleMeasurementPrimitive)) return;

          if (pointIndex >= 0) {
            // Drag single endpoint
            const newData = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
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
          let targetPos = pos;
          if (SHAPE_TOOL_IDS.has(tool) && e.shiftKey) {
            const anchorScreen = dataToScreen(anchorDataRef.current);
            targetPos = constrainShapeScreenPoint(anchorScreen, pos);
          }
          const dataB = screenToDrawingData(targetPos.x, targetPos.y, { snap: drawingSnapEnabledRef.current && !e.altKey && !(SHAPE_TOOL_IDS.has(tool) && e.shiftKey) });
          if (dataB) {
            previewRef.current.setDataPoints([anchorDataRef.current, dataB]);
          }
          return;
        }

        // Hover feedback on lines, fibs and text
        const hit = hitTestAll(pos.x, pos.y);
        for (const prim of primitivesRef.current) {
          if (prim instanceof LineDrawingPrimitive || prim instanceof AxisLineDrawingPrimitive || prim instanceof AngleMeasurementPrimitive || prim instanceof FibonacciDrawingPrimitive || prim instanceof PositionDrawingPrimitive || prim instanceof ShapeDrawingPrimitive) {
            prim.setHovered(hit?.prim?.id === prim.id);
          }
        }

        if (LINE_TOOL_IDS.has(tool) && !draggingRef.current) {
          const container = chartContainerRef?.current;
          if (container) {
            if (hit?.type === "axis-line") {
              const axisLineType = hit.prim.axisLineType;
              if (axisLineType === "horizontal") setCursor(container, "ns-resize");
              else if (axisLineType === "vertical") setCursor(container, "ew-resize");
              else setCursor(container, "move");
            } else if (hit?.type === "angle") {
              setCursor(container, hit.pointIndex >= 0 ? "crosshair" : "move");
            } else if (hit?.type === "line") {
              setCursor(container, hit.pointIndex >= 0 ? "crosshair" : "move");
            } else {
              setCursor(container, "crosshair");
            }
          }
        }

        if (SHAPE_TOOL_IDS.has(tool) && !draggingRef.current) {
          const container = chartContainerRef?.current;
          if (container) {
            if (hit?.type === "shape") {
              if (hit.zone === "l" || hit.zone === "r") setCursor(container, "ew-resize");
              else if (hit.zone === "t" || hit.zone === "b") setCursor(container, "ns-resize");
              else if (hit.zone === "tl" || hit.zone === "br") setCursor(container, "nwse-resize");
              else if (hit.zone === "tr" || hit.zone === "bl") setCursor(container, "nesw-resize");
              else setCursor(container, "move");
            } else {
              setCursor(container, "crosshair");
            }
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
            } else if (hit.zone === "panel") {
              setCursor(container, "grab");
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
    [getChartPos, screenToData, screenToDrawingData, dataToScreen, hitTestAll, refreshSelectedTextUi, chartContainerRef],
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
          const kept = decimateScreenPoints(indexed, 1.5); // ~1.5px tolerance
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

  // ── RIGHT-CLICK: cancel pending two-point placement ──

  const handleContextMenu = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      if ((LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool) || SHAPE_TOOL_IDS.has(tool)) && anchorDataRef.current) {
        e.preventDefault();
        removePreview();
      }
    },
    [removePreview],
  );

  // ── KEYBOARD: Escape / Delete ──

  useEffect(() => {
    if (!isLineTool && !isFibTool && !isShapeTool && !isPenTool && !isHighlighterTool && !isEraserTool && !isTextTool && !isPositionTool && !selectedPrimId && !editingTextId) return;

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
  }, [isLineTool, isFibTool, isShapeTool, isPenTool, isHighlighterTool, isEraserTool, isTextTool, isPositionTool, selectedPrimId, editingTextId, removePreview, deselectAll, detachPrim, persistDrawings]);

  // ── Clean up when tool changes ──

  useEffect(() => {
    if (!isLineTool && !isFibTool && !isShapeTool) {
      removePreview();
      draggingRef.current = null;
    }
    if (!isLineTool && !isFibTool && !isShapeTool && !isTextTool && !isPositionTool) {
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
    if (!isPenTool && !isHighlighterTool) {
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
  }, [isLineTool, isFibTool, isShapeTool, isPenTool, isHighlighterTool, isEraserTool, isTextTool, isPositionTool, removePreview, deselectAll, cancelTextEditing]);

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

  /**
   * Toggle visibility of all drawings without deleting them.
   * Primitives stay attached; their renderers and hit-tests skip hidden items.
   * This avoids doing one attach/detach cycle per drawing on every toggle.
   */
  const setHidden = useCallback((next) => {
    const value = !!next;
    if (hiddenRef.current === value) return;
    hiddenRef.current = value;

    if (value) {
      // Also drop preview / transient edit state so nothing stays on screen.
      removePreview();
      cancelTextEditing();
      draggingRef.current = null;
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
    }

    let updateRequested = false;
    for (const prim of primitivesRef.current) {
      if (typeof prim.setHidden === "function") {
        prim.setHidden(value, false);
      } else {
        prim._hidden = value;
      }
      if (!updateRequested && typeof prim.requestUpdate === "function" && prim._series) {
        prim.requestUpdate();
        updateRequested = true;
      }
    }

    if (!updateRequested) {
      // Force a lightweight redraw when there are no attached primitives that
      // can request one themselves.
      getChartAdapter()?.requestSeriesUpdate?.();
    }
  }, [getChartAdapter, removePreview, cancelTextEditing]);

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
    if (typeof patch.opacity === "number" && typeof prim.setOpacity === "function" && patch.opacity !== prim.opacity) {
      prim.setOpacity(patch.opacity);
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
    setHidden,
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
