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

function horizontalAnchorFromDataPoint(dataPoint) {
  if (!dataPoint) return null;
  if (dataPoint.time != null && Number.isFinite(Number(dataPoint.time))) {
    return { time: dataPoint.time };
  }
  if (typeof dataPoint.logical === "number" && Number.isFinite(dataPoint.logical)) {
    return { logical: dataPoint.logical };
  }
  return null;
}

function dataPointFromHorizontalAnchor(anchor, price) {
  if (anchor == null) return null;
  if (typeof anchor === "number" && Number.isFinite(anchor)) return { time: anchor, price };
  if (typeof anchor !== "object") return null;
  return { ...anchor, price };
}

function preserveHorizontalAnchor(nextPoint, originalPoint) {
  const anchor = horizontalAnchorFromDataPoint(originalPoint);
  return anchor ? { ...nextPoint, ...anchor } : nextPoint;
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
}) {
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

    const dataPoint = type === "position-move"
      ? screenToData(pos.x, pos.y)
      : screenToDrawingData(pos.x, pos.y, {
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
      // Drag left edge: update timeRange.start
      prim.setTimeRange({ ...prim.timeRange, start: horizontalAnchorFromDataPoint(dataPoint) });
    } else if (type === "position-right") {
      // Drag right edge: update timeRange.end
      prim.setTimeRange({ ...prim.timeRange, end: horizontalAnchorFromDataPoint(dataPoint) });
    } else if (type === "position-move") {
      const { origEntry, origTp, origSl, startMouse: sm, origTimeRange } = dragging;
      const dy = pos.y - sm.y;
      const dx = pos.x - sm.x;
      const startPoint = dataPointFromHorizontalAnchor(origTimeRange.start, origEntry);
      const endPoint = dataPointFromHorizontalAnchor(origTimeRange.end, origEntry);
      const origStartScreen = startPoint ? dataToScreen(startPoint) : null;
      const origEndScreen = endPoint ? dataToScreen(endPoint) : null;
      if (origStartScreen) {
        const newEntryData = screenToDrawingData(origStartScreen.x + dx, origStartScreen.y + dy, { snap: drawingSnapEnabledRef.current && !e.altKey });
        if (newEntryData) {
          const priceDelta = newEntryData.price - origEntry;
          prim.setEntryPrice(origEntry + priceDelta);
          if (origTp != null) prim.setTpPrice(origTp + priceDelta);
          if (origSl != null) prim.setSlPrice(origSl + priceDelta);
          const nextStart = horizontalAnchorFromDataPoint(newEntryData);
          const movedEndData = origEndScreen ? screenToData(origEndScreen.x + dx, origEndScreen.y) : null;
          const nextEnd = movedEndData ? horizontalAnchorFromDataPoint(movedEndData) : origTimeRange.end;
          prim.setTimeRange({
            start: nextStart,
            end: nextEnd,
          });
        }
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
}) {
  const { id, type, pointIndex, startMouse, origPoints, origDataPoint, zone, origBox } = dragging;
  const prim = primitivesRef.current.find((p) => p.id === id);
  if (!prim) return;

  if (type === "text" && prim instanceof TextDrawingPrimitive) {
    const dx = pos.x - startMouse.x;
    const dy = pos.y - startMouse.y;
    const origScreen = dataToScreen(origDataPoint);
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
    const basePoint = origDataPoint || prim.dataPoint || dataPoint;
    let nextPoint = dataPoint;
    if (axisLineType === "horizontal") {
      nextPoint = { ...basePoint, price: dataPoint.price };
    } else if (axisLineType === "vertical") {
      nextPoint = { ...basePoint, time: dataPoint.time, logical: dataPoint.logical };
    }
    prim.setDataPoint(nextPoint);
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (type === "shape" && prim instanceof ShapeDrawingPrimitive) {
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

  if (!(prim instanceof LineDrawingPrimitive) && !(prim instanceof FibonacciDrawingPrimitive) && !(prim instanceof AngleMeasurementPrimitive)) return;

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
