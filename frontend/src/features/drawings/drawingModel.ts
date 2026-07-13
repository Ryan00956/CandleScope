import type {
  AngleToolId,
  AxisLineToolId,
  AxisLineType,
  BasicLineToolId,
  DrawingToolId,
  PassiveCursorToolId,
  ScreenBox,
  ScreenPoint,
  ShapeType,
} from "./drawingTypes.js";

export const DEFAULT_CURSOR_TOOL: PassiveCursorToolId = "cursor-default";

export const BASIC_LINE_TOOL_IDS = new Set<BasicLineToolId>(["line-segment", "line-ray", "line-infinite"]);
export const AXIS_LINE_TOOL_IDS = new Set<AxisLineToolId>(["line-horizontal", "line-vertical", "line-cross"]);
export const ANGLE_TOOL_IDS = new Set<AngleToolId>(["angle-measure"]);
export const LINE_TOOL_IDS = new Set([...BASIC_LINE_TOOL_IDS, ...AXIS_LINE_TOOL_IDS, ...ANGLE_TOOL_IDS]);
export const FIB_TOOL_IDS = new Set<DrawingToolId>(["fibonacci"]);
export const POSITION_TOOL_IDS = new Set<DrawingToolId>(["position-long", "position-short"]);
export const SHAPE_TOOL_IDS = new Set<DrawingToolId>(["shape-rectangle", "shape-ellipse"]);
export const CURSOR_TOOL_IDS = new Set<PassiveCursorToolId>([
  DEFAULT_CURSOR_TOOL,
  "cursor-crosshair",
  "cursor-dot",
  "cursor-highlighter",
  "cursor-plain",
]);
export const DRAWING_ENGINE_TOOL_IDS = new Set<DrawingToolId>([
  "pen",
  "highlighter",
  "eraser",
  ...BASIC_LINE_TOOL_IDS,
  ...AXIS_LINE_TOOL_IDS,
  ...ANGLE_TOOL_IDS,
  ...SHAPE_TOOL_IDS,
  "text",
  ...FIB_TOOL_IDS,
  ...POSITION_TOOL_IDS,
]);

export const DEFAULT_HIGHLIGHTER_OPACITY = 0.35;
export const DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION = "multiply";
export const DEFAULT_HIGHLIGHTER_BRUSH_SHAPE = "square";

let idCounter = 0;

export function nextDrawingId(prefix = "d"): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

/** Advance the process-local allocator past an id restored from persistence. */
export function observeDrawingId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const match = /_(\d+)$/.exec(id);
  if (!match) return false;
  const suffix = Number(match[1]);
  if (!Number.isSafeInteger(suffix) || suffix < 1 || suffix >= Number.MAX_SAFE_INTEGER) {
    return false;
  }
  idCounter = Math.max(idCounter, suffix);
  return true;
}

export function isPassiveCursorTool(tool: DrawingToolId | null | undefined): boolean {
  return !tool || CURSOR_TOOL_IDS.has(tool as PassiveCursorToolId);
}

export function cursorStyleForPassiveTool(tool: DrawingToolId | null | undefined): string {
  if (tool === "cursor-crosshair") return "crosshair";
  if (tool === "cursor-dot" || tool === "cursor-highlighter") return "none";
  return "default";
}

export function isTextOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".text-format-bar, .text-edit-overlay");
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function shapeTypeFromTool(tool: DrawingToolId | null | undefined): ShapeType | null {
  if (tool === "shape-ellipse") return "ellipse";
  if (tool === "shape-rectangle") return "rectangle";
  return null;
}

export function axisLineTypeFromTool(tool: DrawingToolId | null | undefined): AxisLineType {
  if (tool === "line-vertical") return "vertical";
  if (tool === "line-cross") return "cross";
  return "horizontal";
}

export function constrainShapeScreenPoint(
  anchorScreen: ScreenPoint | null,
  pointerScreen: ScreenPoint,
): ScreenPoint {
  if (!anchorScreen || !pointerScreen) return pointerScreen;
  const dx = pointerScreen.x - anchorScreen.x;
  const dy = pointerScreen.y - anchorScreen.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  return {
    x: anchorScreen.x + sx * size,
    y: anchorScreen.y + sy * size,
  };
}

export function resizedShapeBoxFromHandle(
  box: ScreenBox | null,
  handle: string | null,
  pos: ScreenPoint | null,
): ScreenBox | null {
  if (!box || !handle || !pos) return null;
  let left = box.x;
  let top = box.y;
  let right = box.right ?? (box.x + box.width);
  let bottom = box.bottom ?? (box.y + box.height);

  if (handle.includes("l")) left = pos.x;
  if (handle.includes("r")) right = pos.x;
  if (handle.includes("t")) top = pos.y;
  if (handle.includes("b")) bottom = pos.y;

  const minSize = 4;
  if (Math.abs(right - left) < minSize) {
    if (handle.includes("l")) left = right - minSize;
    else right = left + minSize;
  }
  if (Math.abs(bottom - top) < minSize) {
    if (handle.includes("t")) top = bottom - minSize;
    else bottom = top + minSize;
  }

  const x = Math.min(left, right);
  const y = Math.min(top, bottom);
  return {
    x,
    y,
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  };
}

function perpendicularDist(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function decimateScreenPoints<T extends ScreenPoint>(points: T[], epsilon: number): T[] {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let maxIndex = 0;
  const start = points[0];
  const end = points[points.length - 1];
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDist(points[index], start, end);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = index;
    }
  }
  if (maxDistance > epsilon) {
    const left = decimateScreenPoints(points.slice(0, maxIndex + 1), epsilon);
    const right = decimateScreenPoints(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [start, end];
}

export function setCursor(el: HTMLElement | null, cursor: string): void {
  if (el && el.style.cursor !== cursor) el.style.setProperty("cursor", cursor);
}
