import { AxisLineDrawingPrimitive } from "./primitives/AxisLineDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "./primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import { useCallback, useEffect, useRef, useState } from "react";

export const EMPTY_SELECTED_TEXT_UI = { snapshot: null, box: null };

export function isSelectablePrimitive(prim) {
  return prim instanceof LineDrawingPrimitive
    || prim instanceof AxisLineDrawingPrimitive
    || prim instanceof AngleMeasurementPrimitive
    || prim instanceof TextDrawingPrimitive
    || prim instanceof FibonacciDrawingPrimitive
    || prim instanceof PositionDrawingPrimitive
    || prim instanceof ShapeDrawingPrimitive;
}

export function selectedDrawingMetaFromPrimitive(prim) {
  if (!prim) return null;
  if (prim instanceof TextDrawingPrimitive) return null;
  if (prim instanceof PositionDrawingPrimitive) return null;
  if (typeof prim.setColor !== "function" && typeof prim.setLineWidth !== "function") {
    return null;
  }
  let type = "drawing";
  if (prim instanceof LineDrawingPrimitive) type = "line";
  else if (prim instanceof AxisLineDrawingPrimitive) type = prim.axisLineType === "cross" ? "cross-line" : `${prim.axisLineType}-line`;
  else if (prim instanceof AngleMeasurementPrimitive) type = "angle-measure";
  else if (prim instanceof FreehandDrawingPrimitive) type = prim.type === "highlighter" ? "highlighter" : "freehand";
  else if (prim instanceof FibonacciDrawingPrimitive) type = "fibonacci";
  else if (prim instanceof ShapeDrawingPrimitive) type = prim.shapeType || "shape";
  return {
    id: prim.id,
    type,
    color: prim.color,
    lineWidth: prim.lineWidth,
    opacity: prim.opacity,
  };
}

export function selectedTextUiFromPrimitive(prim) {
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

export function hitTestDrawingPrimitives(primitives, x, y, hitRadius = 8) {
  for (let index = primitives.length - 1; index >= 0; index -= 1) {
    const prim = primitives[index];

    if (prim instanceof PositionDrawingPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "position", ...hit };
    } else if (prim instanceof LineDrawingPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "line", ...hit };
    } else if (prim instanceof AxisLineDrawingPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "axis-line", ...hit };
    } else if (prim instanceof AngleMeasurementPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "angle", ...hit };
    } else if (prim instanceof FibonacciDrawingPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "fibonacci", ...hit };
    } else if (prim instanceof ShapeDrawingPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "shape", ...hit };
    } else if (prim instanceof FreehandDrawingPrimitive) {
      if (prim.hitTest(x, y, hitRadius)) return { prim, type: prim.type === "highlighter" ? "highlighter" : "freehand" };
    } else if (prim instanceof TextDrawingPrimitive) {
      const hit = prim.hitTest(x, y);
      if (hit) return { prim, type: "text", ...hit };
    }
  }
  return null;
}

/**
 * useDrawingSelection — selection state + selection lifecycle.
 *
 * Owns which primitive is currently selected and keeps the toolbar-facing
 * derived state (selectedTextUi for the floating text toolbar, selectedDrawingMeta
 * for the style editor) in sync. Extracted from the main interaction controller
 * so selection ownership lives in one place; the host controller asks this hook
 * to select / deselect a primitive after its own hit-testing.
 */
export function useDrawingSelection({ primitivesRef }) {
  const selectedIdRef = useRef(null);
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
  }, [primitivesRef]);

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
  }, [primitivesRef]);

  const getPrimitiveById = useCallback((id) => {
    return primitivesRef.current.find((p) => p.id === id) || null;
  }, [primitivesRef]);

  const refreshSelectedTextUi = useCallback((id = selectedIdRef.current) => {
    const prim = id ? primitivesRef.current.find((p) => p.id === id) : null;
    setSelectedTextUi(selectedTextUiFromPrimitive(prim));
  }, [primitivesRef]);

  return {
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
  };
}
