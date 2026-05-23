import { AxisLineDrawingPrimitive } from "./primitives/AxisLineDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "./primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";

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
