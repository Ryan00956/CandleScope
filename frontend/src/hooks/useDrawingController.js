import { hasSavedDrawings } from "../services/drawingStorage";

export const PASSIVE_CURSOR_TOOL_IDS = new Set([
  "cursor-default",
  "cursor-crosshair",
  "cursor-dot",
  "cursor-highlighter",
  "cursor-plain",
]);

export const DRAWING_ENGINE_TOOL_IDS = new Set([
  "pen",
  "highlighter",
  "eraser",
  "line-segment",
  "line-ray",
  "line-infinite",
  "line-horizontal",
  "line-vertical",
  "line-cross",
  "angle-measure",
  "shape-rectangle",
  "shape-ellipse",
  "text",
  "fibonacci",
  "position-long",
  "position-short",
]);

export function shouldLoadDrawingEngine({ activeTool, drawingKey }) {
  return DRAWING_ENGINE_TOOL_IDS.has(activeTool) || hasSavedDrawings(drawingKey);
}
