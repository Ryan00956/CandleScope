/**
 * useDrawing — Unified React hook for ALL native drawing on the chart.
 *
 * Uses Lightweight Charts v5 Plugin API (ISeriesPrimitive) to render
 * everything directly inside the chart's Canvas pipeline — zero lag.
 *
 * Handles:
 *   - Freehand pen ("pen"): click-drag to draw polylines in data coords
 *   - Two-click lines ("line-segment" / "line-ray" / "line-infinite")
 *   - Live preview while placing second point of a line
 *   - Selecting / dragging existing lines (endpoints or whole body)
 *   - Eraser ("eraser"): click to delete any drawing (freehand or line)
 *   - Hover highlight for eraser
 *   - Delete selected line via Delete / Backspace / Escape
 *   - Clear all drawings
 */
import { useCallback, useEffect, useRef } from "react";
import { LineDrawingPrimitive } from "../components/primitives/LineDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "../components/primitives/FreehandDrawingPrimitive.js";

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
}) {
  // ── All primitives (lines + freehand strokes) ──
  const primitivesRef = useRef([]); // (LineDrawingPrimitive | FreehandDrawingPrimitive)[]

  // ── Line-specific state ──
  const previewRef = useRef(null); // LineDrawingPrimitive (dashed preview)
  const anchorDataRef = useRef(null); // { logical, price } first click
  const selectedIdRef = useRef(null);
  const draggingRef = useRef(null); // { id, pointIndex, startMouse, origPoints }

  // ── Freehand-specific state ──
  const currentFreehandRef = useRef(null); // FreehandDrawingPrimitive being drawn
  const isDrawingFreehandRef = useRef(false);

  // ── Tool refs (avoid stale closures) ──
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const penColorRef = useRef(penColor);
  penColorRef.current = penColor;
  const penSizeRef = useRef(penSize);
  penSizeRef.current = penSize;

  const isLineTool = LINE_TOOL_IDS.has(activeTool);
  const isPenTool = activeTool === "pen";
  const isEraserTool = activeTool === "eraser";

  // ── Coordinate helpers ──

  const screenToData = useCallback(
    (x, y) => {
      const chart = chartRef?.current;
      const series = seriesRef?.current;
      if (!chart || !series) return null;
      try {
        const logical = chart.timeScale().coordinateToLogical(x);
        const price = series.coordinateToPrice(y);
        if (logical == null || price == null || !isFinite(logical) || !isFinite(price)) return null;
        return { logical, price };
      } catch {
        return null;
      }
    },
    [chartRef, seriesRef],
  );

  const dataToScreen = useCallback(
    (dp) => {
      const chart = chartRef?.current;
      const series = seriesRef?.current;
      if (!chart || !series || !dp) return null;
      try {
        const x = chart.timeScale().logicalToCoordinate(dp.logical);
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

  // ── Selection helpers ──

  const selectLine = useCallback((id) => {
    selectedIdRef.current = id;
    for (const prim of primitivesRef.current) {
      if (prim instanceof LineDrawingPrimitive) {
        prim.setSelected(prim.id === id);
      }
    }
  }, []);

  const deselectAll = useCallback(() => {
    selectedIdRef.current = null;
    for (const prim of primitivesRef.current) {
      if (prim instanceof LineDrawingPrimitive) {
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

  // ════════════════════════════════════════════════════
  //  MOUSE DOWN
  // ════════════════════════════════════════════════════

  const handleMouseDown = useCallback(
    (e) => {
      const tool = activeToolRef.current;
      const pos = getChartPos(e);
      if (!pos) return;

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
          selectLine(finalLine.id);

          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Hit existing line?
        const hit = hitTestAll(pos.x, pos.y);
        if (hit && hit.type === "line") {
          selectLine(hit.prim.id);

          if (hit.pointIndex >= 0) {
            // Start dragging endpoint
            draggingRef.current = {
              id: hit.prim.id,
              pointIndex: hit.pointIndex,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
            };
          } else {
            // Start dragging entire line
            draggingRef.current = {
              id: hit.prim.id,
              pointIndex: -1,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
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
    [getChartPos, screenToData, detachPrim, attachPrim, hitTestAll, selectLine, deselectAll],
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

      // ── LINE TOOLS ──
      if (LINE_TOOL_IDS.has(tool)) {
        // Dragging
        if (draggingRef.current) {
          const { id, pointIndex, startMouse, origPoints } = draggingRef.current;
          const prim = primitivesRef.current.find((p) => p.id === id);
          if (!prim || !(prim instanceof LineDrawingPrimitive)) return;

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

        // Hover feedback on lines
        const hit = hitTestAll(pos.x, pos.y);
        for (const prim of primitivesRef.current) {
          if (prim instanceof LineDrawingPrimitive) {
            prim.setHovered(hit?.prim?.id === prim.id);
          }
        }
      }
    },
    [getChartPos, screenToData, dataToScreen, hitTestAll],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE UP
  // ════════════════════════════════════════════════════

  const handleMouseUp = useCallback(() => {
    // End freehand drawing
    if (isDrawingFreehandRef.current) {
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
    }
    // End line dragging
    if (draggingRef.current) {
      draggingRef.current = null;
    }
  }, []);

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
    if (!isLineTool && !isPenTool && !isEraserTool) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (anchorDataRef.current) {
          removePreview();
        } else if (selectedIdRef.current) {
          deselectAll();
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIdRef.current) {
        const id = selectedIdRef.current;
        const idx = primitivesRef.current.findIndex((p) => p.id === id);
        if (idx >= 0) {
          detachPrim(primitivesRef.current[idx]);
          primitivesRef.current.splice(idx, 1);
        }
        selectedIdRef.current = null;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isLineTool, isPenTool, isEraserTool, removePreview, deselectAll, detachPrim]);

  // ── Clean up when tool changes ──

  useEffect(() => {
    if (!isLineTool) {
      removePreview();
      deselectAll();
      draggingRef.current = null;
    }
    if (!isPenTool) {
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
    }
    if (!isEraserTool) {
      // Clear hover state
      for (const prim of primitivesRef.current) {
        prim.setHovered(false);
      }
    }
  }, [isLineTool, isPenTool, isEraserTool, removePreview, deselectAll]);

  // ── Attach event listeners to chart container ──

  useEffect(() => {
    const container = chartContainerRef?.current;
    if (!container) return;

    container.addEventListener("mousedown", handleMouseDown);
    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("mouseup", handleMouseUp);
    container.addEventListener("mouseleave", handleMouseUp);
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
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("touchstart", handleMouseDown);
      container.removeEventListener("touchmove", handleMouseMove);
      container.removeEventListener("touchend", handleMouseUp);
      container.removeEventListener("touchcancel", handleMouseUp);
    };
  }, [chartContainerRef, handleMouseDown, handleMouseMove, handleMouseUp, handleContextMenu]);

  // ── Public API ──

  /** Clear all drawings (lines + freehand) */
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
  }, [detachPrim, removePreview]);

  return {
    clearAll,
    primitivesRef,
  };
}

export default useDrawing;
