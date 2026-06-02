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
import { useCallback, useEffect, useRef } from "react";
import { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "./primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import { AxisLineDrawingPrimitive } from "./primitives/AxisLineDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import { clearSavedDrawings } from "./drawingPersistence.js";
import {
  AXIS_LINE_TOOL_IDS,
  FIB_TOOL_IDS,
  LINE_TOOL_IDS,
  POSITION_TOOL_IDS,
  SHAPE_TOOL_IDS,
  cursorStyleForPassiveTool,
  decimateScreenPoints,
  isPassiveCursorTool,
  isTextOverlayTarget,
  setCursor,
} from "./drawingModel.js";
import {
  EMPTY_SELECTED_TEXT_UI,
  hitTestDrawingPrimitives,
  selectedDrawingMetaFromPrimitive,
  useDrawingSelection,
} from "./drawingSelectionController.js";
import { snapDataPointAtPointer } from "./drawingSnapController.js";
import { eraseDrawingAtPointer, updateEraserHoverState } from "./drawingEraseController.js";
import { useDrawingPersistenceLifecycle } from "./useDrawingPersistenceLifecycle.js";
import { useChartPointerPosition, useDrawingPointerEvents } from "./drawingPointerController.js";
import { useDrawingTextEdit } from "./drawingTextEditController.js";
import { useDrawingKeyboard } from "./drawingKeyboardController.js";
import { applyTextAndPositionDrag, applyLineFibShapeDrag } from "./drawingDragResizeController.js";
import {
  coordinateToFractionalLogical,
  futureBarOffsetFromLogical,
  logicalToInterpolatedSeriesTime,
} from "../../chart-adapter/coordinateBridge.js";
import {
  beginAxisLineDrawing,
  beginTwoPointDrawing,
  commitTwoPointDrawing,
  placePositionDrawing,
  placeTextDrawing,
  startFreehandStroke,
  updateTwoPointPreview,
} from "./drawingCreationController.js";

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
  const draggingRef = useRef(null); // { id, pointIndex, startMouse, origPoints | origDataPoint }

  // ── Selection state + lifecycle (extracted) ──
  const {
    selectedIdRef,
    selectedPrimId,
    selectedTextUi,
    selectedDrawingMeta,
    setSelectedPrimId,
    setSelectedTextUi,
    setSelectedDrawingMeta,
    selectPrimitive,
    deselectAll,
    getPrimitiveById,
    refreshSelectedTextUi,
  } = useDrawingSelection({ primitivesRef });

  // ── Freehand-specific state ──
  const currentFreehandRef = useRef(null); // FreehandDrawingPrimitive being drawn
  const isDrawingFreehandRef = useRef(false);

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

  const screenToData = useCallback(
    (x, y) => {
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.()) return null;
      try {
        const fracLogical = coordinateToFractionalLogical(adapter, x);
        const price = adapter.coordinateToPrice?.(y);
        if (fracLogical == null || price == null || !isFinite(fracLogical) || !isFinite(price)) return null;

        const futureOffset = futureBarOffsetFromLogical(adapter, fracLogical);
        if (futureOffset != null) {
          return { barOffsetFromLast: futureOffset, price };
        }

        const snappedTime = adapter.coordinateToTime?.(x);
        let time = null;
        if (snappedTime != null && isFinite(snappedTime)) {
          const seriesData = adapter.getSeriesData?.() || [];
          const snappedIndex = seriesData.findIndex((bar) => bar?.time === snappedTime);
          const snappedX = adapter.timeToCoordinate?.(snappedTime);
          if (snappedIndex >= 0 && snappedX != null && isFinite(snappedX)) {
            const neighborIndex = x >= snappedX ? snappedIndex + 1 : snappedIndex - 1;
            const neighborTime = seriesData[neighborIndex]?.time;
            const neighborX = neighborTime == null ? null : adapter.timeToCoordinate?.(neighborTime);
            if (neighborTime != null && neighborX != null && isFinite(neighborX) && neighborX !== snappedX) {
              const ratio = (x - snappedX) / (neighborX - snappedX);
              time = snappedTime + ratio * (neighborTime - snappedTime);
            }
          }
          if (time == null || !isFinite(time)) {
            time = snappedTime;
          }
        }

        // Fallback for chart adapters that cannot convert directly from
        // coordinate to time.
        if (time == null || !isFinite(time)) {
          time = logicalToInterpolatedSeriesTime(adapter, fracLogical);
        }

        if (time != null && isFinite(time)) {
          return { time, price };
        }

        return { time: null, price, logical: fracLogical };
      } catch {
        return null;
      }
    },
    [getChartAdapter],
  );

  const dataToScreen = useCallback(
    (dp) => {
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.() || !dp) return null;
      try {
        let x = null;
        if (dp.barOffsetFromLast != null) {
          x = adapter.barOffsetFromLastToCoordinate?.(dp.barOffsetFromLast);
        }
        if (dp.time != null) {
          // Try exact match first (fast path)
          if (x == null || !isFinite(x)) x = adapter.timeToCoordinate?.(dp.time);

          // If exact match failed, interpolate between bracketing candles
          if (x == null || !isFinite(x)) {
            x = adapter.timeToCoordinateInterpolated?.(dp.time);
          }
        }
        // Fallback to logical if time-based conversion failed
        if ((x == null || !isFinite(x)) && dp.logical != null) {
          x = adapter.logicalToCoordinateInterpolated?.(dp.logical);
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
      if (adapter.attachPrimitive?.(prim)) {
        prim.requestUpdate?.();
        adapter.requestSeriesUpdate?.();
      }
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

  // ── Selection helpers are provided by useDrawingSelection above ──

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

  // ── Text editing lifecycle (extracted) ──

  const {
    editingTextId,
    editingTextValue,
    editingTextPos,
    editingTextIdRef,
    editInputRef,
    setEditingTextValue,
    setEditingTextPos,
    startTextEditing,
    commitTextEditing,
    cancelTextEditing,
  } = useDrawingTextEdit({
    primitivesRef,
    selectedIdRef,
    getPrimitiveById,
    detachPrim,
    deselectAll,
    selectPrimitive,
    refreshSelectedTextUi,
    persistDrawings,
    dataToScreen,
    activeToolRef,
    onToolChangeRef,
    setSelectedPrimId,
    setSelectedTextUi,
  });

  // ── Get mouse position relative to chart container ──

  const getChartPos = useChartPointerPosition(chartContainerRef);

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
  }, [editingTextId, selectedPrimId, dataToScreen, refreshSelectedTextUi, setEditingTextPos]);

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
        eraseDrawingAtPointer({
          detachPrim,
          hit,
          persistDrawings,
          primitivesRef,
          selectedIdRef,
          setSelectedPrimId,
          setSelectedTextUi,
        });
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── PEN / HIGHLIGHTER (freehand): start stroke ──
      if (tool === "pen" || tool === "highlighter") {
        if (startFreehandStroke({
          tool, pos, e, primitivesRef, currentFreehandRef, isDrawingFreehandRef,
          attachPrim, screenToData, penColorRef, penSizeRef,
        })) return;
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
        if (placeTextDrawing({
          pos, e, primitivesRef, attachPrim, startTextEditing, screenToDrawingData,
          drawingSnapEnabledRef, penColorRef, textFontSizeRef, textBoldRef, textItalicRef,
        })) return;
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
        if (placePositionDrawing({
          tool, pos, e, primitivesRef, attachPrim, selectPrimitive, persistDrawings,
          screenToDrawingData, getChartAdapter, chartContainerRef, drawingSnapEnabledRef, positionSizeRef,
        })) return;
      }

      // ── LINE/FIB/SHAPE TOOLS ──
      if (LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool) || SHAPE_TOOL_IDS.has(tool)) {
        const isAxisLineTool = AXIS_LINE_TOOL_IDS.has(tool);

        // Second click — commit new line/fib/shape
        if (commitTwoPointDrawing({
          tool, pos, e, primitivesRef, anchorDataRef, previewRef, attachPrim, detachPrim,
          selectPrimitive, persistDrawings, screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
          penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
        })) return;

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
          if (beginAxisLineDrawing({
            tool, pos, e, primitivesRef, anchorDataRef, previewRef, draggingRef, attachPrim,
            selectPrimitive, removePreview, screenToDrawingData, drawingSnapEnabledRef, penColorRef, penSizeRef,
          })) return;
        }

        // First click — set anchor
        if (beginTwoPointDrawing({
          tool, pos, e, anchorDataRef, previewRef, attachPrim, screenToDrawingData,
          drawingSnapEnabledRef, penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
        })) return;
      }
    },
    [getChartPos, screenToData, screenToDrawingData, dataToScreen, detachPrim, attachPrim, hitTestAll, selectPrimitive, deselectAll, getPrimitiveById, beginTextDrag, startTextEditing, commitTextEditing, persistDrawings, removePreview, getChartAdapter, chartContainerRef, editingTextIdRef, selectedIdRef, setSelectedPrimId, setSelectedTextUi],
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
        updateEraserHoverState(primitivesRef.current, pos.x, pos.y);
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

      // ── Drag/resize of existing text & position drawings (extracted) ──
      if (applyTextAndPositionDrag({
        dragging: draggingRef.current,
        pos,
        e,
        primitivesRef,
        screenToData,
        dataToScreen,
        screenToDrawingData,
        refreshSelectedTextUi,
        drawingSnapEnabledRef,
        chartContainerRef,
      })) {
        return;
      }

      // ── LINE / FIB / SHAPE TOOLS ──
      if (LINE_TOOL_IDS.has(tool) || FIB_TOOL_IDS.has(tool) || SHAPE_TOOL_IDS.has(tool)) {
        // Dragging
        if (draggingRef.current) {
          applyLineFibShapeDrag({
            dragging: draggingRef.current,
            pos,
            e,
            primitivesRef,
            screenToData,
            dataToScreen,
            screenToDrawingData,
            drawingSnapEnabledRef,
          });
          return;
        }

        // Preview line: update second point
        if (updateTwoPointPreview({
          tool, pos, e, anchorDataRef, previewRef, screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
        })) return;

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

  // ── KEYBOARD: Escape / Delete (extracted) ──

  useDrawingKeyboard({
    active: isLineTool || isFibTool || isShapeTool || isPenTool || isHighlighterTool || isEraserTool || isTextTool || isPositionTool || !!selectedPrimId || !!editingTextId,
    anchorDataRef,
    selectedIdRef,
    editingTextIdRef,
    primitivesRef,
    removePreview,
    deselectAll,
    detachPrim,
    persistDrawings,
    setSelectedPrimId,
    setSelectedTextUi,
  });

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
  }, [isLineTool, isFibTool, isShapeTool, isPenTool, isHighlighterTool, isEraserTool, isTextTool, isPositionTool, removePreview, deselectAll, cancelTextEditing, selectedIdRef]);

  useDrawingPointerEvents({
    chartContainerRef,
    handleDblClick,
    handleContextMenu,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
  });

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
  }, [detachPrim, removePreview, cancelTextEditing, selectedIdRef, setSelectedPrimId, setSelectedTextUi]);

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
        // eslint-disable-next-line react-hooks/immutability -- mutating the primitive object, not the ref container
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
  }, [getPrimitiveById, refreshSelectedTextUi, persistDrawings, selectedIdRef]);

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
  }, [detachPrim, persistDrawings, selectedIdRef, setSelectedPrimId, setSelectedTextUi]);

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
  }, [persistDrawings, selectedIdRef, setSelectedDrawingMeta]);

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
