import {
  CHART_DRAWING_ANCHOR_MODES,
} from "../chart-representation/chartTypeRegistry.js";
import {
  AXIS_LINE_TOOL_IDS,
  ANGLE_TOOL_IDS,
  BASIC_LINE_TOOL_IDS,
  CURSOR_TOOL_IDS,
  DEFAULT_CURSOR_TOOL,
  DRAWING_ENGINE_TOOL_IDS,
  FIB_TOOL_IDS,
  SHAPE_TOOL_IDS,
} from "./drawingModel.js";

const SOURCE_TIME_TOOL_IDS = new Set([
  ...CURSOR_TOOL_IDS,
  ...DRAWING_ENGINE_TOOL_IDS,
]);

const SOURCE_LINEAGE_TOOL_IDS = new Set([
  ...CURSOR_TOOL_IDS,
  "eraser",
  ...BASIC_LINE_TOOL_IDS,
  ...AXIS_LINE_TOOL_IDS,
  ...ANGLE_TOOL_IDS,
  ...FIB_TOOL_IDS,
  ...SHAPE_TOOL_IDS,
  "text",
]);

const HIT_TYPE_TOOL_IDS = Object.freeze({
  line: "line-segment",
  "axis-line": "line-horizontal",
  angle: "angle-measure",
  fibonacci: "fibonacci",
  shape: "shape-rectangle",
  text: "text",
  position: "position-long",
  freehand: "pen",
  highlighter: "highlighter",
});

export function supportsDrawingAnchorMode(anchorMode) {
  return anchorMode === CHART_DRAWING_ANCHOR_MODES.SOURCE_TIME
    || anchorMode === CHART_DRAWING_ANCHOR_MODES.SOURCE_LINEAGE;
}

export function supportsDrawingTool(anchorMode, tool) {
  if (tool == null) return supportsDrawingAnchorMode(anchorMode);
  if (anchorMode === CHART_DRAWING_ANCHOR_MODES.SOURCE_TIME) {
    return SOURCE_TIME_TOOL_IDS.has(tool);
  }
  if (anchorMode === CHART_DRAWING_ANCHOR_MODES.SOURCE_LINEAGE) {
    return SOURCE_LINEAGE_TOOL_IDS.has(tool);
  }
  return false;
}

export function drawingToolForAnchorMode(anchorMode, tool) {
  if (supportsDrawingTool(anchorMode, tool)) return tool;
  return supportsDrawingTool(anchorMode, DEFAULT_CURSOR_TOOL)
    ? DEFAULT_CURSOR_TOOL
    : null;
}

export function hasSupportedDrawingVariant(anchorMode, variants = []) {
  return variants.some((variant) => supportsDrawingTool(anchorMode, variant?.id));
}

/**
 * Existing drawings share one persistence namespace across chart
 * representations. Keep unsupported legacy primitives visible/erasable, but
 * do not let another active tool edit their anchors in a stricter mode.
 */
export function supportsDrawingHitType(anchorMode, hitType) {
  const tool = HIT_TYPE_TOOL_IDS[hitType];
  return typeof tool === "string" && supportsDrawingTool(anchorMode, tool);
}
