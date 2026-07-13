/**
 * drawingDragResizeController — drag / resize lifecycle for existing drawings.
 *
 * Extracted from the main interaction controller's pointer-move handler. These
 * are the branches that mutate an *already created* primitive while the user is
 * dragging it, as opposed to creating a new drawing. They are plain functions
 * (not hooks): the host passes the current drag descriptor, the pointer event,
 * the primitive list and the coordinate/snap helpers it owns, and these
 * functions apply the move.
 *
 * `applyTextAndPositionDrag` covers the tool-independent drags (text handle
 * resize, text body drag, position TP/SL/entry/edge/panel drag) and returns
 * `true` when it has consumed the event. `applyLineFibShapeDrag` covers the
 * line / fib / shape / axis-line drags that the host runs inside the
 * line/fib/shape tool branch; the host always returns afterwards.
 *
 * Snap math and coordinate conversion are unchanged — they live in the helpers
 * passed in by the host.
 */
import { setCursor, resizedShapeBoxFromHandle } from "./drawingModel.js";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "./primitives/PositionDrawingPrimitive.js";
import { AxisLineDrawingPrimitive } from "./primitives/AxisLineDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import { parseDrawingAnchor } from "./drawingContracts.js";
import type {
  DrawingAnchor,
  DrawingDataPoint,
  DrawingDataToScreen,
  DrawingPointerEvent,
  DrawingPrimitive,
  HorizontalDrawingAnchor,
  MutableRef,
  PositionInfoPanelOffset,
  PositionTimeRange,
  ScreenBox,
  ScreenPoint,
  ScreenToDrawingData,
} from "./drawingTypes.js";

interface DragBase {
  id: string;
  startMouse: ScreenPoint;
}

interface TextHandleDrag extends DragBase {
  type: "text-handle";
  handle: string;
  origBox: ScreenBox;
  origFontSize: number;
  origWidthPx: number | null;
  origDataPoint: DrawingDataPoint;
}

interface TextDrag extends DragBase {
  type: "text";
  origDataPoint: DrawingDataPoint;
}

interface PositionPriceDrag extends DragBase {
  type: "position-tp" | "position-sl";
}

interface PositionMoveDrag extends DragBase {
  type: "position-move";
  origEntry: number;
  origTp: number | null;
  origSl: number | null;
  origTimeRange: PositionTimeRange;
}

interface PositionEdgeDrag extends DragBase {
  type: "position-left" | "position-right";
  origTimeRange: PositionTimeRange;
}

interface PositionPanelDrag extends DragBase {
  type: "position-panel";
  origInfoPanelOffset: PositionInfoPanelOffset;
}

interface AxisLineDrag extends DragBase {
  type: "axis-line";
  zone: string;
  origDataPoint: DrawingDataPoint;
}

interface ShapeDrag extends DragBase {
  type: "shape";
  zone: string;
  origPoints: DrawingDataPoint[];
  origBox: ScreenBox | null;
}

interface LineLikeDrag extends DragBase {
  type: "line" | "angle" | "fibonacci";
  pointIndex: number;
  origPoints: DrawingDataPoint[];
}

export type DrawingDragDescriptor = TextHandleDrag
  | TextDrag
  | PositionPriceDrag
  | PositionMoveDrag
  | PositionEdgeDrag
  | PositionPanelDrag
  | AxisLineDrag
  | ShapeDrag
  | LineLikeDrag;

interface DragControllerOptions {
  dragging: DrawingDragDescriptor | null;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  screenToData: ScreenToDrawingData;
  dataToScreen: DrawingDataToScreen;
  screenToDrawingData: ScreenToDrawingData;
  drawingSnapEnabledRef: MutableRef<boolean>;
}

interface TextAndPositionDragOptions extends DragControllerOptions {
  refreshSelectedTextUi: (id: string) => void;
  chartContainerRef: MutableRef<HTMLElement | null>;
}

interface PositionVisualAnchorKeys {
  endScreen: ScreenPoint;
  leftKey: "start" | "end";
  rightKey: "start" | "end";
  startScreen: ScreenPoint;
}

function horizontalAnchorFromDataPoint(
  dataPoint: DrawingDataPoint | null,
): DrawingAnchor | null {
  return dataPoint ? parseDrawingAnchor(dataPoint) : null;
}

function dataPointFromHorizontalAnchor(
  anchor: HorizontalDrawingAnchor | null,
  price: number,
): DrawingDataPoint | null {
  if (anchor == null) return null;
  if (typeof anchor === "number" && Number.isFinite(anchor)) return { time: anchor, price };
  if (typeof anchor !== "object") return null;
  return { ...anchor, price };
}

function preserveHorizontalAnchor(
  nextPoint: DrawingDataPoint,
  originalPoint: DrawingDataPoint,
): DrawingDataPoint {
  const anchor = horizontalAnchorFromDataPoint(originalPoint);
  if (!anchor) return nextPoint;
  const next: Record<string, unknown> = { ...nextPoint };
  delete next.order;
  delete next.time;
  delete next.logical;
  delete next.sourceOrdinal;
  delete next.sourceProjection;
  delete next.sourceProjectionConfig;
  return { ...next, ...anchor, price: nextPoint.price };
}

function replaceHorizontalAnchor(
  nextPoint: DrawingDataPoint,
  dataPoint: DrawingDataPoint,
): DrawingDataPoint | null {
  const anchor = horizontalAnchorFromDataPoint(dataPoint);
  if (!anchor) return null;
  const next: Record<string, unknown> = { ...nextPoint };
  delete next.order;
  delete next.time;
  delete next.logical;
  delete next.sourceOrdinal;
  delete next.sourceProjection;
  delete next.sourceProjectionConfig;
  return { ...next, ...anchor, price: nextPoint.price };
}

function sameHorizontalAnchor(first: DrawingAnchor | null, second: DrawingAnchor | null): boolean {
  if (!first || !second) return false;
  return first.time === second.time
    && first.logical === second.logical
    && first.sourceOrdinal === second.sourceOrdinal
    && first.sourceProjection === second.sourceProjection
    && first.sourceProjectionConfig === second.sourceProjectionConfig;
}

function positionVisualAnchorKeys(
  timeRange: PositionTimeRange,
  entryPrice: number,
  dataToScreen: DrawingDataToScreen,
): PositionVisualAnchorKeys | null {
  const startPoint = dataPointFromHorizontalAnchor(timeRange?.start, entryPrice);
  const endPoint = dataPointFromHorizontalAnchor(timeRange?.end, entryPrice);
  const startScreen = startPoint ? dataToScreen(startPoint) : null;
  const endScreen = endPoint ? dataToScreen(endPoint) : null;
  if (!startScreen || !endScreen) return null;
  return startScreen.x <= endScreen.x
    ? { endScreen, leftKey: "start", rightKey: "end", startScreen }
    : { endScreen, leftKey: "end", rightKey: "start", startScreen };
}

/**
 * Handle the tool-independent drags (text handle resize, text body, position).
 * Returns true when the event was consumed (the caller should then return).
 */
export function applyTextAndPositionDrag({
  dragging,
  pos,
  e,
  primitivesRef,
  screenToData,
  dataToScreen,
  screenToDrawingData,
  refreshSelectedTextUi,
  drawingSnapEnabledRef,
  chartContainerRef,
}: TextAndPositionDragOptions): boolean {
  // ── TEXT TOOL: 8-handle resize drag (corners = scale, sides = wrap width) ──
  if (dragging && dragging.type === "text-handle") {
    const { id, handle, startMouse, origBox, origFontSize, origWidthPx, origDataPoint } = dragging;
    const prim = primitivesRef.current.find((p) => p.id === id);
    if (!prim || !(prim instanceof TextDrawingPrimitive)) return true;

    const dx = pos.x - startMouse.x;
    const dy = pos.y - startMouse.y;

    // Side handles ( l / r ): change widthPx, anchor the opposite vertical edge.
    if (handle === "l" || handle === "r") {
      let newWidth;
      let anchorScreenX;
      if (handle === "r") {
        newWidth = Math.max(20, origBox.width + dx);
        anchorScreenX = origBox.x; // left edge stays
      } else {
        newWidth = Math.max(20, origBox.width - dx);
        anchorScreenX = origBox.x + origBox.width - newWidth; // shift left edge to follow mouse
      }
      prim.setWidthPx(newWidth);
      if (handle === "l") {
        const newDp = screenToData(anchorScreenX, origBox.y);
        if (newDp) prim.setDataPoint(newDp);
      }
      refreshSelectedTextUi(id);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // Top / bottom handles ( t / b ): adjust font height proportionally.
    if (handle === "t" || handle === "b") {
      let scale;
      if (handle === "b") scale = (origBox.height + dy) / origBox.height;
      else scale = (origBox.height - dy) / origBox.height;
      if (!isFinite(scale)) return true;
      scale = Math.max(0.2, Math.min(8, scale));
      const newSize = Math.max(8, Math.min(200, Math.round(origFontSize * scale)));
      prim.setFontSize(newSize);
      if (origWidthPx) prim.setWidthPx(Math.max(20, origWidthPx * scale));
      if (handle === "t") {
        // Top edge moves with cursor; bottom stays.
        const newBoxH = origBox.height * scale;
        const newAnchorY = origBox.y + origBox.height - newBoxH;
        const newDp = screenToData(origBox.x, newAnchorY);
        if (newDp) prim.setDataPoint(preserveHorizontalAnchor(newDp, origDataPoint));
      }
      refreshSelectedTextUi(id);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // Corner handles: equi-scale font + width using the larger of the two
    // axis ratios so the box visually follows the mouse on the chosen corner.
    // The opposite corner stays anchored.
    let signX = 0, signY = 0;
    if (handle === "tl") { signX = -1; signY = -1; }
    if (handle === "tr") { signX =  1; signY = -1; }
    if (handle === "bl") { signX = -1; signY =  1; }
    if (handle === "br") { signX =  1; signY =  1; }
    const scaleX = (origBox.width + signX * dx) / origBox.width;
    const scaleY = (origBox.height + signY * dy) / origBox.height;
    let scale = Math.max(scaleX, scaleY);
    if (!isFinite(scale)) return true;
    scale = Math.max(0.2, Math.min(8, scale));

    const newSize = Math.max(8, Math.min(200, Math.round(origFontSize * scale)));
    prim.setFontSize(newSize);
    if (origWidthPx) prim.setWidthPx(Math.max(20, origWidthPx * scale));

    // Recompute new box top-left so the opposite corner stays put.
    const newW = origBox.width * scale;
    const newH = origBox.height * scale;
    let newAnchorX = origBox.x;
    let newAnchorY = origBox.y;
    if (handle === "tl") { newAnchorX = origBox.x + origBox.width - newW; newAnchorY = origBox.y + origBox.height - newH; }
    if (handle === "tr") { newAnchorY = origBox.y + origBox.height - newH; }
    if (handle === "bl") { newAnchorX = origBox.x + origBox.width - newW; }
    // 'br' keeps anchor unchanged
    if (newAnchorX !== origBox.x || newAnchorY !== origBox.y) {
      const newDp = screenToData(newAnchorX, newAnchorY);
      if (newDp) prim.setDataPoint(newDp);
    }
    refreshSelectedTextUi(id);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // ── TEXT TOOL: dragging body ──
  if (dragging && dragging.type === "text") {
    const { id, startMouse, origDataPoint } = dragging;
    const prim = primitivesRef.current.find((p) => p.id === id);
    if (!prim || !(prim instanceof TextDrawingPrimitive)) return true;

    const dx = pos.x - startMouse.x;
    const dy = pos.y - startMouse.y;
    const origScreen = dataToScreen(origDataPoint);
    if (!origScreen) return true;
    const newData = screenToDrawingData(origScreen.x + dx, origScreen.y + dy, { snap: drawingSnapEnabledRef.current && !e.altKey });
    if (!newData) return true;
    prim.setDataPoint(newData);
    refreshSelectedTextUi(id);

    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // ── POSITION TOOL: dragging TP/SL/entry/edges/info panel ──
  if (dragging && (dragging.type === "position-tp" || dragging.type === "position-sl" || dragging.type === "position-move" || dragging.type === "position-left" || dragging.type === "position-right" || dragging.type === "position-panel")) {
    const { id, type } = dragging;
    const prim = primitivesRef.current.find((p) => p.id === id);
    if (!prim || !(prim instanceof PositionDrawingPrimitive)) return true;

    if (type === "position-panel") {
      const { startMouse, origInfoPanelOffset } = dragging;
      prim.setInfoPanelOffset({
        x: origInfoPanelOffset.x + (pos.x - startMouse.x),
        y: origInfoPanelOffset.y + (pos.y - startMouse.y),
      });
      setCursor(chartContainerRef?.current, "grabbing");
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    if (type === "position-move") {
      const { origEntry, origTp, origSl, startMouse: sm, origTimeRange } = dragging;
      const dy = pos.y - sm.y;
      const dx = pos.x - sm.x;
      const startPoint = dataPointFromHorizontalAnchor(origTimeRange.start, origEntry);
      const endPoint = dataPointFromHorizontalAnchor(origTimeRange.end, origEntry);
      const origStartScreen = startPoint ? dataToScreen(startPoint) : null;
      const origEndScreen = endPoint ? dataToScreen(endPoint) : null;
      if (!origStartScreen || !origEndScreen) return true;

      // Snap the reference endpoint, then apply that endpoint's *actual* screen
      // delta to the other endpoint without independently snapping it. Both
      // endpoints still resolve before any geometry is mutated.
      const nextStartData = screenToDrawingData(
        origStartScreen.x + dx,
        origStartScreen.y + dy,
        { snap: drawingSnapEnabledRef.current && !e.altKey },
      );
      if (!nextStartData) return true;
      const nextStartScreen = dataToScreen(nextStartData);
      if (!nextStartScreen) return true;
      const appliedDx = nextStartScreen.x - origStartScreen.x;
      const appliedDy = nextStartScreen.y - origStartScreen.y;
      const nextEndData = screenToDrawingData(
        origEndScreen.x + appliedDx,
        origEndScreen.y + appliedDy,
        { snap: false },
      );
      const nextStart = horizontalAnchorFromDataPoint(nextStartData);
      const nextEnd = horizontalAnchorFromDataPoint(nextEndData);
      if (!nextStartData || !nextEndData || !nextStart || !nextEnd) return true;

      const priceDelta = nextStartData.price - origEntry;
      if (!Number.isFinite(priceDelta)) return true;

      const originalCollapsed = Math.abs(origStartScreen.x - origEndScreen.x) < 0.5;
      const nextCollapsed = sameHorizontalAnchor(nextStart, nextEnd);
      const preserveHorizontalRange = Math.abs(appliedDx) < 0.5
        || originalCollapsed
        || nextCollapsed;
      const nextTimeRange = preserveHorizontalRange
        ? origTimeRange
        : { start: nextStart, end: nextEnd };

      prim.setGeometry({
        entryPrice: origEntry + priceDelta,
        tpPrice: origTp == null ? null : origTp + priceDelta,
        slPrice: origSl == null ? null : origSl + priceDelta,
        timeRange: nextTimeRange,
      });

      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    const dataPoint = screenToDrawingData(pos.x, pos.y, {
      snap: drawingSnapEnabledRef.current && !e.altKey,
      time: type === "position-left" || type === "position-right",
      price: type !== "position-left" && type !== "position-right",
    });
    if (!dataPoint) return true;

    if (type === "position-tp") {
      const isLong = prim.direction === "long";
      let newTp = dataPoint.price;
      // Clamp: TP cannot cross entry
      if (isLong) newTp = Math.max(newTp, prim.entryPrice);
      else newTp = Math.min(newTp, prim.entryPrice);
      prim.setTpPrice(newTp);
    } else if (type === "position-sl") {
      const isLong = prim.direction === "long";
      let newSl = dataPoint.price;
      // Clamp: SL cannot cross entry
      if (isLong) newSl = Math.min(newSl, prim.entryPrice);
      else newSl = Math.max(newSl, prim.entryPrice);
      prim.setSlPrice(newSl);
    } else if (type === "position-left") {
      const candidate = horizontalAnchorFromDataPoint(dataPoint);
      const candidatePoint = dataPointFromHorizontalAnchor(candidate, prim.entryPrice);
      const candidateScreen = candidatePoint ? dataToScreen(candidatePoint) : null;
      const visualKeys = positionVisualAnchorKeys(
        dragging.origTimeRange || prim.timeRange,
        prim.entryPrice,
        dataToScreen,
      );
      const otherKey = visualKeys?.rightKey;
      const otherScreen = otherKey === "start"
        ? visualKeys?.startScreen
        : visualKeys?.endScreen;
      if (candidate && candidateScreen && visualKeys && otherScreen
        && candidateScreen.x < otherScreen.x - 0.5) {
        prim.setTimeRange({ ...prim.timeRange, [visualKeys.leftKey]: candidate });
      }
    } else if (type === "position-right") {
      const candidate = horizontalAnchorFromDataPoint(dataPoint);
      const candidatePoint = dataPointFromHorizontalAnchor(candidate, prim.entryPrice);
      const candidateScreen = candidatePoint ? dataToScreen(candidatePoint) : null;
      const visualKeys = positionVisualAnchorKeys(
        dragging.origTimeRange || prim.timeRange,
        prim.entryPrice,
        dataToScreen,
      );
      const otherKey = visualKeys?.leftKey;
      const otherScreen = otherKey === "start"
        ? visualKeys?.startScreen
        : visualKeys?.endScreen;
      if (candidate && candidateScreen && visualKeys && otherScreen
        && candidateScreen.x > otherScreen.x + 0.5) {
        prim.setTimeRange({ ...prim.timeRange, [visualKeys.rightKey]: candidate });
      }
    }

    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  return false;
}

/**
 * Handle the line / fib / shape / axis-line drag for the currently dragged
 * primitive. Called by the host only when a drag is active inside the
 * line/fib/shape tool branch; the host returns from its handler afterwards.
 */
export function applyLineFibShapeDrag({
  dragging,
  pos,
  e,
  primitivesRef,
  screenToData,
  dataToScreen,
  screenToDrawingData,
  drawingSnapEnabledRef,
}: DragControllerOptions): void {
  if (!dragging) return;
  const { id, type, startMouse } = dragging;
  const prim = primitivesRef.current.find((p) => p.id === id);
  if (!prim) return;

  if (type === "text" && prim instanceof TextDrawingPrimitive) {
    const dx = pos.x - startMouse.x;
    const dy = pos.y - startMouse.y;
    const origScreen = dataToScreen(dragging.origDataPoint);
    if (!origScreen) return;
    const newData = screenToDrawingData(origScreen.x + dx, origScreen.y + dy, { snap: drawingSnapEnabledRef.current && !e.altKey });
    if (!newData) return;
    prim.setDataPoint(newData);
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (type === "axis-line" && prim instanceof AxisLineDrawingPrimitive) {
    const axisLineType = prim.axisLineType;
    const dataPoint = screenToDrawingData(pos.x, pos.y, {
      snap: drawingSnapEnabledRef.current && !e.altKey,
      time: axisLineType !== "horizontal",
      price: axisLineType !== "vertical",
    });
    if (!dataPoint) return;
    const basePoint = dragging.origDataPoint || prim.dataPoint || dataPoint;
    let nextPoint: DrawingDataPoint | null = dataPoint;
    if (axisLineType === "horizontal") {
      nextPoint = preserveHorizontalAnchor(
        { ...basePoint, price: dataPoint.price },
        basePoint,
      );
    } else if (axisLineType === "vertical") {
      nextPoint = replaceHorizontalAnchor(basePoint, dataPoint);
    } else {
      nextPoint = replaceHorizontalAnchor(
        { ...dataPoint, price: dataPoint.price },
        dataPoint,
      );
    }
    if (!nextPoint) return;
    prim.setDataPoint(nextPoint);
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (type === "shape" && prim instanceof ShapeDrawingPrimitive) {
    const { zone, origBox, origPoints } = dragging;
    if (zone && zone !== "body" && origBox) {
      const nextBox = resizedShapeBoxFromHandle(origBox, zone, pos);
      if (!nextBox) return;
      const newA = screenToData(nextBox.x, nextBox.y);
      const newB = screenToData(nextBox.x + nextBox.width, nextBox.y + nextBox.height);
      if (!newA || !newB) return;
      prim.setDataPoints([newA, newB]);
    } else {
      const dx = pos.x - startMouse.x;
      const dy = pos.y - startMouse.y;
      const sa0 = dataToScreen(origPoints[0]);
      const sb0 = dataToScreen(origPoints[1]);
      if (!sa0 || !sb0) return;
      const newA = screenToData(sa0.x + dx, sa0.y + dy);
      const newB = screenToData(sb0.x + dx, sb0.y + dy);
      if (!newA || !newB) return;
      prim.setDataPoints([newA, newB]);
    }

    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (type !== "line" && type !== "fibonacci" && type !== "angle") return;
  if (!(prim instanceof LineDrawingPrimitive)
    && !(prim instanceof FibonacciDrawingPrimitive)
    && !(prim instanceof AngleMeasurementPrimitive)) return;

  const { pointIndex, origPoints } = dragging;

  if (pointIndex >= 0) {
    // Drag single endpoint
    const newData = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
    if (!newData) return;
    const newPoints = [...prim.dataPoints];
    newPoints[pointIndex] = newData;
    prim.setDataPoints(newPoints);
  } else {
    // Move entire line
    const dx = pos.x - startMouse.x;
    const dy = pos.y - startMouse.y;
    const sa0 = dataToScreen(origPoints[0]);
    const sb0 = dataToScreen(origPoints[1]);
    if (!sa0 || !sb0) return;
    const newA = screenToData(sa0.x + dx, sa0.y + dy);
    const newB = screenToData(sb0.x + dx, sb0.y + dy);
    if (!newA || !newB) return;
    prim.setDataPoints([newA, newB]);
  }

  e.preventDefault();
  e.stopPropagation();
}
