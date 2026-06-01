import { hasSavedDrawings } from "./drawingPersistence.js";
import { DRAWING_ENGINE_TOOL_IDS } from "./drawingModel.js";

export { DRAWING_ENGINE_TOOL_IDS };

let drawingEngineHostPromise = null;

export function loadDrawingEngineHost() {
  if (!drawingEngineHostPromise) {
    drawingEngineHostPromise = import("./DrawingEngineHost.jsx");
  }
  return drawingEngineHostPromise;
}

export function preloadDrawingEngineHost() {
  loadDrawingEngineHost().catch(() => {
    drawingEngineHostPromise = null;
  });
}

export function shouldLoadDrawingEngine({ activeTool, drawingKey }) {
  return DRAWING_ENGINE_TOOL_IDS.has(activeTool) || hasSavedDrawings(drawingKey);
}
