import { hasSavedDrawings } from "./drawingPersistence.js";
import { DRAWING_ENGINE_TOOL_IDS } from "./drawingModel.js";
import type { DrawingToolId } from "./drawingTypes.js";

export { DRAWING_ENGINE_TOOL_IDS };

type DrawingEngineHostModule = typeof import("./DrawingEngineHost.jsx");

let drawingEngineHostPromise: Promise<DrawingEngineHostModule> | null = null;

export function loadDrawingEngineHost(): Promise<DrawingEngineHostModule> {
  if (!drawingEngineHostPromise) {
    drawingEngineHostPromise = import("./DrawingEngineHost.jsx");
  }
  return drawingEngineHostPromise;
}

export function preloadDrawingEngineHost(): void {
  loadDrawingEngineHost().catch(() => {
    drawingEngineHostPromise = null;
  });
}

export function shouldLoadDrawingEngine({
  activeTool,
  drawingKey,
}: {
  activeTool: DrawingToolId | null | undefined;
  drawingKey: string;
}): boolean {
  return (activeTool != null && DRAWING_ENGINE_TOOL_IDS.has(activeTool))
    || hasSavedDrawings(drawingKey);
}
