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
import { timeToCoordinateInterpolated } from "../components/primitives/coordinateUtils.js";
import { saveDrawings, loadDrawings, clearSavedDrawings } from "../services/drawingStorage.js";

const LINE_TOOL_IDS = new Set(["line-segment", "line-ray", "line-infinite"]);

let _idCounter = 0;
function nextId(prefix = "d") {
  return `${prefix}_${++_idCounter}`;
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
  symbol,
  seriesReady,
}) {
  // ── All primitives (lines + freehand strokes + text) ──
  const primitivesRef = useRef([]); // (LineDrawingPrimitive | FreehandDrawingPrimitive | TextDrawingPrimitive)[]

  // ── Line-specific state ──
  const previewRef = useRef(null); // LineDrawingPrimitive (dashed preview)
  const anchorDataRef = useRef(null); // { logical, price } first click
  const selectedIdRef = useRef(null);
  const draggingRef = useRef(null); // { id, pointIndex, startMouse, origPoints | origDataPoint }

  // ── Selected primitive ID as React state (for toolbar sync) ──
  const [selectedPrimId, setSelectedPrimId] = useState(null);

  // ── Freehand-specific state ──
  const currentFreehandRef = useRef(null); // FreehandDrawingPrimitive being drawn
  const isDrawingFreehandRef = useRef(false);

  // ── Text editing state ──
  const [editingTextId, setEditingTextId] = useState(null);
  const [editingTextValue, setEditingTextValue] = useState("");
  const [editingTextPos, setEditingTextPos] = useState(null); // { x, y } screen coords
  const editInputRef = useRef(null);

  // ── Tool refs (avoid stale closures) ──
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const penColorRef = useRef(penColor);
  penColorRef.current = penColor;
  const penSizeRef = useRef(penSize);
  penSizeRef.current = penSize;
  const textFontSizeRef = useRef(textFontSize);
  textFontSizeRef.current = textFontSize;
  const textBoldRef = useRef(textBold);
  textBoldRef.current = textBold;
  const textItalicRef = useRef(textItalic);
  textItalicRef.current = textItalic;

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  const isLineTool = LINE_TOOL_IDS.has(activeTool);
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
        const logical = chart.timeScale().coordinateToLogical(x);
        const price = series.coordinateToPrice(y);
        if (logical == null || price == null || !isFinite(logical) || !isFinite(price)) return null;

        // Compute a *continuous* timestamp by interpolating between candle
        // boundaries. This ensures the timestamp is not snapped to any
        // particular candle and will map correctly on any timeframe.
        const time = logicalToInterpolatedTime(logical);

        if (time != null && isFinite(time)) {
          return { time, price };
        }

        // Fallback: try coordinateToTime (snapped)
        const snappedTime = chart.timeScale().coordinateToTime(x);
        if (snappedTime != null && isFinite(snappedTime)) {
          return { time: snappedTime, price };
        }

        return { time: null, price, logical };
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

    // If there are existing primitives in memory (from before a chart
    // re-creation or series switch), we need to re-attach them to the
    // new series. Otherwise, if this is a fresh page load, restore
    // from localStorage.

    const existingPrims = primitivesRef.current;

    if (existingPrims.length > 0) {
      // Re-attach existing in-memory primitives to the new series.
      // First detach from any old series they may still reference,
      // then attach to the current (possibly new) series.
      for (const prim of existingPrims) {
        try {
          // Detach from old series if still attached to a different one
          if (prim._series && prim._series !== series) {
            try { prim._series.detachPrimitive(prim); } catch { /* already detached */ }
          }
          series.attachPrimitive(prim);
        } catch (err) {
          console.warn("Failed to re-attach drawing:", err);
        }
      }
      return;
    }

    // No in-memory primitives → restore from localStorage
    const saved = loadDrawings(symbol);
    if (!saved || saved.length === 0) return;

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
  }, [symbol, seriesRef, seriesReady]);

  // ── Selection helpers ──

  const selectPrimitive = useCallback((id) => {
    selectedIdRef.current = id;
    setSelectedPrimId(id);
    for (const prim of primitivesRef.current) {
      if (prim instanceof LineDrawingPrimitive || prim instanceof TextDrawingPrimitive) {
        prim.setSelected(prim.id === id);
      }
    }
  }, []);

  const deselectAll = useCallback(() => {
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    for (const prim of primitivesRef.current) {
      if (prim instanceof LineDrawingPrimitive || prim instanceof TextDrawingPrimitive) {
        prim.setSelected(false);
      }
    }
  }, []);

  // ── Hit-test all primitives ──

  const hitTestAll = useCallback(
    (x, y, hitRadius = 8) => {
      // Iterate in reverse (newest on top)
      for (let i = primitivesRef.current.length - 1; i >= 0; i--) {
        const prim = primitivesRef.current[i];

        if (prim instanceof LineDrawingPrimitive) {
          const hit = prim.hitTest(x, y);
          if (hit) return { prim, type: "line", ...hit };
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

  const cancelTextEditing = useCallback(() => {
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
  }, []);

  // ── Commit text editing ──

  const commitTextEditing = useCallback(() => {
    if (!editingTextId) return;
    const prim = primitivesRef.current.find((p) => p.id === editingTextId);
    if (prim && prim instanceof TextDrawingPrimitive) {
      const trimmed = editingTextValue.trim();
      if (trimmed) {
        prim.setText(trimmed);
      } else {
        // Empty text → delete the annotation
        const idx = primitivesRef.current.indexOf(prim);
        if (idx >= 0) {
          detachPrim(prim);
          primitivesRef.current.splice(idx, 1);
        }
        if (selectedIdRef.current === prim.id) {
          selectedIdRef.current = null;
        }
      }
    }
    cancelTextEditing();
    persistDrawings();
  }, [editingTextId, editingTextValue, detachPrim, cancelTextEditing, persistDrawings]);

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

      setEditingTextId(prim.id);
      setEditingTextValue(prim.text);
      setEditingTextPos({ x: screenPos.x, y: screenPos.y });
      selectPrimitive(prim.id);

      // Focus the input after render
      setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 50);
    },
    [dataToScreen, selectPrimitive],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE DOWN
  // ════════════════════════════════════════════════════

  const handleMouseDown = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      const pos = getChartPos(e);
      if (!pos) return;

      // If we're editing text, don't interfere
      if (editingTextId) return;

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
        // Check if clicking on existing text → select it
        const hit = hitTestAll(pos.x, pos.y);
        if (hit && hit.type === "text") {
          selectPrimitive(hit.prim.id);

          // Corner hit → start resize drag
          if (hit.corner != null) {
            draggingRef.current = {
              id: hit.prim.id,
              type: "text-resize",
              corner: hit.corner,
              startMouse: pos,
              origFontSize: hit.prim.fontSize,
              origDataPoint: { ...hit.prim.dataPoint },
            };
          } else {
            // Body hit → start position drag
            draggingRef.current = {
              id: hit.prim.id,
              type: "text",
              startMouse: pos,
              origDataPoint: { ...hit.prim.dataPoint },
            };
          }

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
          text: "Text",
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

      // ── LINE TOOLS ──
      if (LINE_TOOL_IDS.has(tool)) {
        // Second click — commit new line
        if (anchorDataRef.current && previewRef.current) {
          const dataB = screenToData(pos.x, pos.y);
          if (!dataB) return;

          // Remove preview
          detachPrim(previewRef.current);
          previewRef.current = null;

          // Create final line primitive
          const finalLine = new LineDrawingPrimitive({
            id: nextId("ln"),
            lineType: tool,
            dataPoints: [anchorDataRef.current, dataB],
            color: penColorRef.current,
            lineWidth: penSizeRef.current,
          });
          attachPrim(finalLine);
          primitivesRef.current.push(finalLine);

          anchorDataRef.current = null;
          selectPrimitive(finalLine.id);
          persistDrawings();

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Hit existing element?
        const hit = hitTestAll(pos.x, pos.y);
        if (hit && hit.type === "line") {
          selectPrimitive(hit.prim.id);

          if (hit.pointIndex >= 0) {
            // Start dragging endpoint
            draggingRef.current = {
              id: hit.prim.id,
              type: "line",
              pointIndex: hit.pointIndex,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
            };
          } else {
            // Start dragging entire line
            draggingRef.current = {
              id: hit.prim.id,
              type: "line",
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
        const preview = new LineDrawingPrimitive({
          id: "__preview__",
          lineType: tool,
          dataPoints: [dataA, dataA],
          color: penColorRef.current,
          lineWidth: penSizeRef.current,
          isPreview: true,
        });
        previewRef.current = preview;
        attachPrim(preview);

        e.preventDefault();
        e.stopPropagation();
        return;
      }
    },
    [getChartPos, screenToData, detachPrim, attachPrim, hitTestAll, selectPrimitive, deselectAll, startTextEditing, editingTextId],
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

      // ── TEXT TOOL: resize drag ──
      if (draggingRef.current && draggingRef.current.type === "text-resize") {
        const { id, startMouse, origFontSize } = draggingRef.current;
        const prim = primitivesRef.current.find((p) => p.id === id);
        if (!prim || !(prim instanceof TextDrawingPrimitive)) return;
        // Use vertical delta to scale font size
        const dy = startMouse.y - pos.y; // drag up = bigger
        const newSize = Math.max(8, Math.min(200, origFontSize + dy * 0.3));
        prim.setFontSize(Math.round(newSize));
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── TEXT TOOL: dragging ──
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

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── LINE TOOLS ──
      if (LINE_TOOL_IDS.has(tool)) {
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

          if (!(prim instanceof LineDrawingPrimitive)) return;

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

        // Hover feedback on lines and text
        const hit = hitTestAll(pos.x, pos.y);
        for (const prim of primitivesRef.current) {
          if (prim instanceof LineDrawingPrimitive) {
            prim.setHovered(hit?.prim?.id === prim.id);
          }
        }
      }

      // ── TEXT TOOL: hover feedback for existing text ──
      if (tool === "text" && !draggingRef.current) {
        const container = chartContainerRef?.current;
        if (container) {
          const hit = hitTestAll(pos.x, pos.y);
          container.style.cursor = hit?.type === "text" ? "move" : "crosshair";
        }
      }
    },
    [getChartPos, screenToData, dataToScreen, hitTestAll, chartContainerRef],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE UP
  // ════════════════════════════════════════════════════

  const handleMouseUp = useCallback(() => {
    let changed = false;
    // End freehand drawing
    if (isDrawingFreehandRef.current) {
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
  }, [persistDrawings]);

  // ── RIGHT-CLICK: cancel line placement ──

  const handleContextMenu = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      if (LINE_TOOL_IDS.has(tool) && anchorDataRef.current) {
        e.preventDefault();
        removePreview();
      }
    },
    [removePreview],
  );

  // ── KEYBOARD: Escape / Delete ──

  useEffect(() => {
    if (!isLineTool && !isPenTool && !isEraserTool && !isTextTool) return;

    const handleKeyDown = (e) => {
      // Don't intercept if editing text
      if (editingTextId) return;

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
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isLineTool, isPenTool, isEraserTool, isTextTool, editingTextId, removePreview, deselectAll, detachPrim, persistDrawings]);

  // ── Clean up when tool changes ──

  useEffect(() => {
    if (!isLineTool) {
      removePreview();
      draggingRef.current = null;
    }
    if (!isLineTool && !isTextTool) {
      deselectAll();
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
  }, [isLineTool, isPenTool, isEraserTool, isTextTool, removePreview, deselectAll, cancelTextEditing]);

  // ── Attach event listeners to chart container ──

  useEffect(() => {
    const container = chartContainerRef?.current;
    if (!container) return;

    container.addEventListener("mousedown", handleMouseDown);
    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("mouseup", handleMouseUp);
    container.addEventListener("mouseleave", handleMouseUp);
    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("contextmenu", handleContextMenu);
    container.addEventListener("touchstart", handleMouseDown, { passive: false });
    container.addEventListener("touchmove", handleMouseMove, { passive: false });
    container.addEventListener("touchend", handleMouseUp);
    container.addEventListener("touchcancel", handleMouseUp);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("mousemove", handleMouseMove);
      container.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("mouseleave", handleMouseUp);
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("touchstart", handleMouseDown);
      container.removeEventListener("touchmove", handleMouseMove);
      container.removeEventListener("touchend", handleMouseUp);
      container.removeEventListener("touchcancel", handleMouseUp);
    };
  }, [chartContainerRef, handleMouseDown, handleMouseMove, handleMouseUp, handleDblClick, handleContextMenu]);

  // ── Public API ──

  /** Clear all drawings (lines + freehand + text) */
  const clearAll = useCallback(() => {
    for (const prim of primitivesRef.current) {
      detachPrim(prim);
    }
    primitivesRef.current = [];
    removePreview();
    selectedIdRef.current = null;
    draggingRef.current = null;
    isDrawingFreehandRef.current = false;
    currentFreehandRef.current = null;
    cancelTextEditing();
    clearSavedDrawings(symbolRef.current);
  }, [detachPrim, removePreview, cancelTextEditing]);

  return {
    clearAll,
    primitivesRef,
    selectedPrimId,
    // Text editing state (for rendering the inline editor in the component)
    editingTextId,
    editingTextValue,
    editingTextPos,
    setEditingTextValue,
    commitTextEditing,
    cancelTextEditing,
    editInputRef,
  };
}

export default useDrawing;
