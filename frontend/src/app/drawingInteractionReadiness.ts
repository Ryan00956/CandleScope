import { DRAWING_ENGINE_TOOL_IDS } from "../features/drawings/drawingModel.js";
import type { DrawingToolId } from "../features/drawings/drawingTypes.js";

export function drawingToolWhenInteractionReady(
  tool: DrawingToolId | null | undefined,
  ready: boolean,
): DrawingToolId | null {
  return tool != null && DRAWING_ENGINE_TOOL_IDS.has(tool) && !ready ? null : tool ?? null;
}
