const LINE_HOVER_TYPES = new Set(["line", "axis-line", "angle", "fibonacci", "position", "shape"]);

export function syncHoveredPrimitive(hoveredRef, nextPrim) {
  const previous = hoveredRef.current || null;
  const next = nextPrim || null;
  if (previous === next) return false;

  if (previous && typeof previous.setHovered === "function") {
    previous.setHovered(false);
  }
  if (next && typeof next.setHovered === "function") {
    next.setHovered(true);
  }

  hoveredRef.current = next;
  return true;
}

export function clearHoveredPrimitive(hoveredRef) {
  return syncHoveredPrimitive(hoveredRef, null);
}

export function hoverTargetForTool(tool, hit) {
  if (!hit?.prim) return null;
  if (tool === "eraser") return hit.prim;
  if (tool === "position-long" || tool === "position-short") {
    return hit.type === "position" ? hit.prim : null;
  }
  if (LINE_HOVER_TYPES.has(hit.type)) return hit.prim;
  return null;
}

export function cursorForLineToolHit(hit) {
  if (hit?.type === "axis-line") {
    const axisLineType = hit.prim.axisLineType;
    if (axisLineType === "horizontal") return "ns-resize";
    if (axisLineType === "vertical") return "ew-resize";
    return "move";
  }
  if (hit?.type === "angle" || hit?.type === "line") {
    return hit.pointIndex >= 0 ? "crosshair" : "move";
  }
  return "crosshair";
}

export function cursorForShapeToolHit(hit) {
  if (hit?.type !== "shape") return "crosshair";
  if (hit.zone === "l" || hit.zone === "r") return "ew-resize";
  if (hit.zone === "t" || hit.zone === "b") return "ns-resize";
  if (hit.zone === "tl" || hit.zone === "br") return "nwse-resize";
  if (hit.zone === "tr" || hit.zone === "bl") return "nesw-resize";
  return "move";
}

export function cursorForPositionToolHit(hit) {
  if (hit?.type !== "position") return "crosshair";
  if (hit.zone === "tp" || hit.zone === "sl") return "ns-resize";
  if (hit.zone === "panel") return "grab";
  if (hit.zone === "left" || hit.zone === "right") return "ew-resize";
  if (hit.zone === "entry" || hit.zone === "body") return "move";
  return "crosshair";
}

export function cursorForTextToolHit(hit) {
  if (hit?.type !== "text") return "crosshair";
  if (hit.handle === "l" || hit.handle === "r") return "ew-resize";
  if (hit.handle === "t" || hit.handle === "b") return "ns-resize";
  if (hit.handle === "tl" || hit.handle === "br") return "nwse-resize";
  if (hit.handle === "tr" || hit.handle === "bl") return "nesw-resize";
  return "move";
}

export function shouldAppendFreehandPoint(previousScreenPoint, nextScreenPoint, minDistancePx = 1) {
  if (!previousScreenPoint || !nextScreenPoint) return true;
  const dx = nextScreenPoint.x - previousScreenPoint.x;
  const dy = nextScreenPoint.y - previousScreenPoint.y;
  return Math.hypot(dx, dy) >= minDistancePx;
}
