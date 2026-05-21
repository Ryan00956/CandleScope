import { hasSavedDrawings } from "./drawingPersistence.js";
import { DRAWING_ENGINE_TOOL_IDS } from "./drawingModel.js";

export { DRAWING_ENGINE_TOOL_IDS };

export function shouldLoadDrawingEngine({ activeTool, drawingKey }) {
  return DRAWING_ENGINE_TOOL_IDS.has(activeTool) || hasSavedDrawings(drawingKey);
}
