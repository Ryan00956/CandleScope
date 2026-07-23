import {
  parseDrawingAnchor,
  parseDrawingDataPoint,
  parseHorizontalDrawingAnchor,
  parsePositionTimeRange,
} from "../drawingContracts.js";
import { resizedShapeBoxFromHandle } from "../drawingModel.js";
import { draggedPositionInfoPanelOffset } from "../positionInfoPanelLayout.js";
import type { DrawingDragDescriptor } from "../drawingDragResizeController.js";
import type {
  DrawingAnchor,
  DrawingDataPoint,
  DrawingDataToScreen,
  HorizontalDrawingAnchor,
  PositionTimeRange,
  SavedDrawing,
  ScreenBox,
  ScreenPoint,
  ScreenToDrawingData,
} from "../drawingTypes.js";

const TEXT_HANDLES = new Set(["tl", "t", "tr", "r", "br", "b", "bl", "l"]);
const SHAPE_HANDLES = new Set(["tl", "t", "tr", "r", "br", "b", "bl", "l"]);

export type DrawingEntityGeometryCommand = "move" | "resize";

export interface DrawingEntityDragOptions {
  readonly descriptor: DrawingDragDescriptor;
  readonly drawing: SavedDrawing;
  readonly pos: ScreenPoint;
  readonly screenToData: ScreenToDrawingData;
  readonly screenToDrawingData: ScreenToDrawingData;
  readonly dataToScreen: DrawingDataToScreen;
  readonly snap: boolean;
}

export function drawingEntityGeometryCommandForDrag(
  descriptor: DrawingDragDescriptor,
): DrawingEntityGeometryCommand {
  switch (descriptor.type) {
    case "text":
    case "position-move":
    case "position-panel":
    case "axis-line":
      return "move";
    case "shape":
      return descriptor.zone === "body" || descriptor.zone === "center" ? "move" : "resize";
    case "line":
    case "angle":
    case "fibonacci":
      return descriptor.pointIndex < 0 ? "move" : "resize";
    case "text-handle":
    case "position-tp":
    case "position-sl":
    case "position-left":
    case "position-right":
    case "position-top-left":
    case "position-top-right":
    case "position-bottom-left":
    case "position-bottom-right":
      return "resize";
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteScreenPoint(value: ScreenPoint | null | undefined): value is ScreenPoint {
  return !!value && finiteNumber(value.x) && finiteNumber(value.y);
}

function normalizedScreenBox(value: ScreenBox | null | undefined): ScreenBox | null {
  if (!value
    || !finiteNumber(value.x)
    || !finiteNumber(value.y)
    || !finiteNumber(value.width)
    || !finiteNumber(value.height)
    || value.width <= 0
    || value.height <= 0) return null;
  const right = value.right ?? value.x + value.width;
  const bottom = value.bottom ?? value.y + value.height;
  if (!finiteNumber(right) || !finiteNumber(bottom)) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height, right, bottom };
}

function immutableDataPoint(value: unknown): DrawingDataPoint | null {
  const parsed = parseDrawingDataPoint(value);
  return parsed ? Object.freeze({ ...parsed }) as DrawingDataPoint : null;
}

function immutableDataPoints(value: readonly unknown[]): DrawingDataPoint[] | null {
  const points: DrawingDataPoint[] = [];
  for (const candidate of value) {
    const point = immutableDataPoint(candidate);
    if (!point) return null;
    points.push(point);
  }
  return Object.freeze(points) as unknown as DrawingDataPoint[];
}

function immutableHorizontalAnchor(value: unknown): HorizontalDrawingAnchor | null {
  const anchor = parseHorizontalDrawingAnchor(value);
  if (anchor === null) return null;
  return typeof anchor === "number"
    ? anchor
    : Object.freeze({ ...anchor });
}

function immutableTimeRange(value: unknown): PositionTimeRange | null {
  const parsed = parsePositionTimeRange(value);
  if (!parsed) return null;
  const start = parsed.start === null ? null : immutableHorizontalAnchor(parsed.start);
  const end = parsed.end === null ? null : immutableHorizontalAnchor(parsed.end);
  if ((parsed.start !== null && start === null) || (parsed.end !== null && end === null)) return null;
  return Object.freeze({ start, end });
}

function frozenUpdate<TDrawing extends SavedDrawing>(
  drawing: TDrawing,
  patch: Partial<TDrawing>,
): TDrawing {
  return Object.freeze({ ...drawing, ...patch }) as unknown as TDrawing;
}

function pointFromHorizontalAnchor(
  anchor: HorizontalDrawingAnchor | null,
  price: number,
): DrawingDataPoint | null {
  if (!finiteNumber(price) || anchor === null) return null;
  const parsed = immutableHorizontalAnchor(anchor);
  if (parsed === null) return null;
  return immutableDataPoint(typeof parsed === "number"
    ? { time: parsed, price }
    : { ...parsed, price });
}

function anchorFromPoint(point: DrawingDataPoint | null): DrawingAnchor | null {
  const anchor = point ? parseDrawingAnchor(point) : null;
  return anchor ? Object.freeze({ ...anchor }) : null;
}

function pointWithAnchor(anchor: DrawingAnchor | null, price: number): DrawingDataPoint | null {
  return anchor && finiteNumber(price)
    ? immutableDataPoint({ ...anchor, price })
    : null;
}

function preserveHorizontalAnchor(
  nextPoint: DrawingDataPoint,
  originalPoint: DrawingDataPoint,
): DrawingDataPoint | null {
  return pointWithAnchor(anchorFromPoint(originalPoint), nextPoint.price);
}

function sameHorizontalAnchor(first: DrawingAnchor | null, second: DrawingAnchor | null): boolean {
  if (!first || !second) return false;
  return first.time === second.time
    && first.logical === second.logical
    && first.sourceOrdinal === second.sourceOrdinal
    && first.sourceProjection === second.sourceProjection
    && first.sourceProjectionConfig === second.sourceProjectionConfig;
}

function translatedDataPoint(
  point: DrawingDataPoint,
  dx: number,
  dy: number,
  dataToScreen: DrawingDataToScreen,
  screenToData: ScreenToDrawingData,
): DrawingDataPoint | null {
  const screen = dataToScreen(point);
  if (!finiteScreenPoint(screen)) return null;
  return immutableDataPoint(screenToData(screen.x + dx, screen.y + dy));
}

function applyTextHandleDrag(
  options: DrawingEntityDragOptions,
): SavedDrawing | null {
  const { descriptor, drawing, pos, screenToData } = options;
  if (descriptor.type !== "text-handle" || drawing.type !== "text") return null;
  if (!TEXT_HANDLES.has(descriptor.handle)) return null;
  const box = normalizedScreenBox(descriptor.origBox);
  const originalPoint = immutableDataPoint(descriptor.origDataPoint);
  const currentPoint = immutableDataPoint(drawing.dataPoint);
  if (!box || !originalPoint || !currentPoint
    || !finiteScreenPoint(descriptor.startMouse)
    || !finiteNumber(descriptor.origFontSize)
    || descriptor.origFontSize <= 0
    || (descriptor.origWidthPx !== null
      && (!finiteNumber(descriptor.origWidthPx) || descriptor.origWidthPx <= 0))) return null;

  const dx = pos.x - descriptor.startMouse.x;
  const dy = pos.y - descriptor.startMouse.y;
  const handle = descriptor.handle;

  if (handle === "l" || handle === "r") {
    const widthPx = handle === "r"
      ? Math.max(20, box.width + dx)
      : Math.max(20, box.width - dx);
    if (!finiteNumber(widthPx)) return null;
    if (handle === "r") return frozenUpdate(drawing, { widthPx });
    const anchorX = box.x + box.width - widthPx;
    const dataPoint = immutableDataPoint(screenToData(anchorX, box.y));
    return dataPoint ? frozenUpdate(drawing, { dataPoint, widthPx }) : null;
  }

  let scale: number;
  if (handle === "t" || handle === "b") {
    scale = handle === "b"
      ? (box.height + dy) / box.height
      : (box.height - dy) / box.height;
  } else {
    const signX = handle === "tl" || handle === "bl" ? -1 : 1;
    const signY = handle === "tl" || handle === "tr" ? -1 : 1;
    const scaleX = (box.width + signX * dx) / box.width;
    const scaleY = (box.height + signY * dy) / box.height;
    scale = Math.max(scaleX, scaleY);
  }
  if (!finiteNumber(scale)) return null;
  scale = Math.max(0.2, Math.min(8, scale));

  const fontSize = Math.max(8, Math.min(200, Math.round(descriptor.origFontSize * scale)));
  const widthPatch = descriptor.origWidthPx === null
    ? {}
    : { widthPx: Math.max(20, descriptor.origWidthPx * scale) };
  if (handle === "b" || handle === "br") {
    return frozenUpdate(drawing, { fontSize, ...widthPatch });
  }

  const newWidth = box.width * scale;
  const newHeight = box.height * scale;
  const movesLeft = handle === "l" || handle === "tl" || handle === "bl";
  const movesTop = handle === "t" || handle === "tl" || handle === "tr";
  const anchorX = movesLeft ? box.x + box.width - newWidth : box.x;
  const anchorY = movesTop ? box.y + box.height - newHeight : box.y;
  const converted = immutableDataPoint(screenToData(anchorX, anchorY));
  if (!converted) return null;
  const dataPoint = handle === "t"
    ? preserveHorizontalAnchor(converted, originalPoint)
    : converted;
  return dataPoint
    ? frozenUpdate(drawing, { dataPoint, fontSize, ...widthPatch })
    : null;
}

function applyTextDrag(options: DrawingEntityDragOptions): SavedDrawing | null {
  const { descriptor, drawing, pos, dataToScreen, screenToDrawingData, snap } = options;
  if (descriptor.type !== "text" || drawing.type !== "text") return null;
  const originalPoint = immutableDataPoint(descriptor.origDataPoint);
  if (!originalPoint || !finiteScreenPoint(descriptor.startMouse)) return null;
  const originalScreen = dataToScreen(originalPoint);
  if (!finiteScreenPoint(originalScreen)) return null;
  const dataPoint = immutableDataPoint(screenToDrawingData(
    originalScreen.x + pos.x - descriptor.startMouse.x,
    originalScreen.y + pos.y - descriptor.startMouse.y,
    { snap },
  ));
  return dataPoint ? frozenUpdate(drawing, { dataPoint }) : null;
}

interface PositionVisualAnchorKeys {
  readonly endScreen: ScreenPoint;
  readonly leftKey: "start" | "end";
  readonly rightKey: "start" | "end";
  readonly startScreen: ScreenPoint;
}

type PositionCornerDrag = Extract<DrawingDragDescriptor, {
  type:
    | "position-top-left"
    | "position-top-right"
    | "position-bottom-left"
    | "position-bottom-right";
}>;

function isPositionCornerDrag(
  descriptor: DrawingDragDescriptor,
): descriptor is PositionCornerDrag {
  return descriptor.type === "position-top-left"
    || descriptor.type === "position-top-right"
    || descriptor.type === "position-bottom-left"
    || descriptor.type === "position-bottom-right";
}

function positionCornerHorizontalSide(
  type: PositionCornerDrag["type"],
): "left" | "right" {
  return type === "position-top-left" || type === "position-bottom-left"
    ? "left"
    : "right";
}

function positionCornerPriceTarget(
  direction: "long" | "short",
  type: PositionCornerDrag["type"],
  timeRange: PositionTimeRange,
  entryPrice: number,
  tpPrice: number | null | undefined,
  slPrice: number | null | undefined,
  dataToScreen: DrawingDataToScreen,
): "tp" | "sl" | null {
  if (typeof tpPrice !== "number" || typeof slPrice !== "number"
    || !Number.isFinite(tpPrice) || !Number.isFinite(slPrice)) return null;
  const targetsTop = type === "position-top-left" || type === "position-top-right";
  const fallbackTargetsTp = (direction === "long") === targetsTop;
  const anchor = timeRange.start ?? timeRange.end;
  const tpPoint = pointFromHorizontalAnchor(anchor, tpPrice);
  const slPoint = pointFromHorizontalAnchor(anchor, slPrice);
  const tpScreen = tpPoint ? dataToScreen(tpPoint) : null;
  const slScreen = slPoint ? dataToScreen(slPoint) : null;
  if (!finiteScreenPoint(tpScreen) || !finiteScreenPoint(slScreen)) {
    return fallbackTargetsTp ? "tp" : "sl";
  }
  const targetsTp = (tpScreen.y <= slScreen.y) === targetsTop;
  return targetsTp ? "tp" : "sl";
}

function positionVisualAnchorKeys(
  timeRange: PositionTimeRange,
  entryPrice: number,
  dataToScreen: DrawingDataToScreen,
): PositionVisualAnchorKeys | null {
  const startPoint = pointFromHorizontalAnchor(timeRange.start, entryPrice);
  const endPoint = pointFromHorizontalAnchor(timeRange.end, entryPrice);
  const startScreen = startPoint ? dataToScreen(startPoint) : null;
  const endScreen = endPoint ? dataToScreen(endPoint) : null;
  if (!finiteScreenPoint(startScreen) || !finiteScreenPoint(endScreen)) return null;
  return startScreen.x <= endScreen.x
    ? { endScreen, leftKey: "start", rightKey: "end", startScreen }
    : { endScreen, leftKey: "end", rightKey: "start", startScreen };
}

function applyPositionDrag(options: DrawingEntityDragOptions): SavedDrawing | null {
  const {
    descriptor,
    drawing,
    pos,
    dataToScreen,
    screenToDrawingData,
    snap,
  } = options;
  if (drawing.type !== "position") return null;
  if (!finiteNumber(drawing.entryPrice) || !finiteScreenPoint(descriptor.startMouse)) return null;

  if (descriptor.type === "position-panel") {
    const original = descriptor.origInfoPanelOffset;
    if (!drawing.timeRange || !finiteNumber(original.x) || !finiteNumber(original.y)) return null;
    const range = positionVisualAnchorKeys(drawing.timeRange, drawing.entryPrice, dataToScreen);
    if (!range) return null;
    const rawLeft = Math.min(range.startScreen.x, range.endScreen.x);
    const rawRight = Math.max(range.startScreen.x, range.endScreen.x);
    const center = (rawLeft + rawRight) / 2;
    const width = Math.max(24, rawRight - rawLeft);
    const infoPanelOffset = Object.freeze(draggedPositionInfoPanelOffset({
      deltaX: pos.x - descriptor.startMouse.x,
      deltaY: pos.y - descriptor.startMouse.y,
      original,
      positionLeft: center - width / 2,
      positionRight: center + width / 2,
    }));
    return finiteNumber(infoPanelOffset.x) && finiteNumber(infoPanelOffset.y)
      ? frozenUpdate(drawing, { infoPanelOffset })
      : null;
  }

  if (descriptor.type === "position-move") {
    const originalRange = immutableTimeRange(descriptor.origTimeRange);
    if (!originalRange
      || !finiteNumber(descriptor.origEntry)
      || (descriptor.origTp !== null && !finiteNumber(descriptor.origTp))
      || (descriptor.origSl !== null && !finiteNumber(descriptor.origSl))) return null;
    const startPoint = pointFromHorizontalAnchor(originalRange.start, descriptor.origEntry);
    const endPoint = pointFromHorizontalAnchor(originalRange.end, descriptor.origEntry);
    const originalStartScreen = startPoint ? dataToScreen(startPoint) : null;
    const originalEndScreen = endPoint ? dataToScreen(endPoint) : null;
    if (!finiteScreenPoint(originalStartScreen) || !finiteScreenPoint(originalEndScreen)) return null;

    const dx = pos.x - descriptor.startMouse.x;
    const dy = pos.y - descriptor.startMouse.y;
    const nextStartData = immutableDataPoint(screenToDrawingData(
      originalStartScreen.x + dx,
      originalStartScreen.y + dy,
      { snap },
    ));
    if (!nextStartData) return null;
    const nextStartScreen = dataToScreen(nextStartData);
    if (!finiteScreenPoint(nextStartScreen)) return null;
    const appliedDx = nextStartScreen.x - originalStartScreen.x;
    const appliedDy = nextStartScreen.y - originalStartScreen.y;
    const nextEndData = immutableDataPoint(screenToDrawingData(
      originalEndScreen.x + appliedDx,
      originalEndScreen.y + appliedDy,
      { snap: false },
    ));
    const nextStart = anchorFromPoint(nextStartData);
    const nextEnd = anchorFromPoint(nextEndData);
    if (!nextEndData || !nextStart || !nextEnd) return null;

    const priceDelta = nextStartData.price - descriptor.origEntry;
    if (!finiteNumber(priceDelta)) return null;
    const originalCollapsed = Math.abs(originalStartScreen.x - originalEndScreen.x) < 0.5;
    const nextCollapsed = sameHorizontalAnchor(nextStart, nextEnd);
    const timeRange = Math.abs(appliedDx) < 0.5 || originalCollapsed || nextCollapsed
      ? originalRange
      : Object.freeze({ start: nextStart, end: nextEnd });
    return frozenUpdate(drawing, {
      entryPrice: descriptor.origEntry + priceDelta,
      tpPrice: descriptor.origTp === null ? null : descriptor.origTp + priceDelta,
      slPrice: descriptor.origSl === null ? null : descriptor.origSl + priceDelta,
      timeRange,
    });
  }

  if (isPositionCornerDrag(descriptor)) {
    const originalRange = immutableTimeRange(descriptor.origTimeRange);
    const currentRange = immutableTimeRange(drawing.timeRange);
    if (drawing.direction !== "long" && drawing.direction !== "short") return null;
    const dataPoint = immutableDataPoint(screenToDrawingData(pos.x, pos.y, {
      snap,
      time: true,
      price: true,
    }));
    const candidate = anchorFromPoint(dataPoint);
    const candidatePoint = pointFromHorizontalAnchor(candidate, drawing.entryPrice);
    const candidateScreen = candidatePoint ? dataToScreen(candidatePoint) : null;
    const visualKeys = originalRange
      ? positionVisualAnchorKeys(originalRange, drawing.entryPrice, dataToScreen)
      : null;
    const side = positionCornerHorizontalSide(descriptor.type);
    const fixedKey = side === "left" ? visualKeys?.rightKey : visualKeys?.leftKey;
    const fixedScreen = fixedKey === "start"
      ? visualKeys?.startScreen
      : visualKeys?.endScreen;
    const keepsMinimumWidth = side === "left"
      ? candidateScreen != null && fixedScreen != null && candidateScreen.x < fixedScreen.x - 0.5
      : candidateScreen != null && fixedScreen != null && candidateScreen.x > fixedScreen.x + 0.5;
    if (!originalRange || !currentRange || !dataPoint || !candidate || !visualKeys
      || !keepsMinimumWidth) return null;
    const priceTarget = positionCornerPriceTarget(
      drawing.direction,
      descriptor.type,
      originalRange,
      drawing.entryPrice,
      drawing.tpPrice,
      drawing.slPrice,
      dataToScreen,
    );
    if (!priceTarget) return null;

    const timeRange = Object.freeze({
      ...currentRange,
      [side === "left" ? visualKeys.leftKey : visualKeys.rightKey]: candidate,
    });
    if (priceTarget === "tp") {
      const tpPrice = drawing.direction === "long"
        ? Math.max(dataPoint.price, drawing.entryPrice)
        : Math.min(dataPoint.price, drawing.entryPrice);
      return frozenUpdate(drawing, { timeRange, tpPrice });
    }
    const slPrice = drawing.direction === "long"
      ? Math.min(dataPoint.price, drawing.entryPrice)
      : Math.max(dataPoint.price, drawing.entryPrice);
    return frozenUpdate(drawing, { timeRange, slPrice });
  }

  if (descriptor.type !== "position-tp"
    && descriptor.type !== "position-sl"
    && descriptor.type !== "position-left"
    && descriptor.type !== "position-right") return null;
  const dataPoint = immutableDataPoint(screenToDrawingData(pos.x, pos.y, {
    snap,
    time: descriptor.type === "position-left" || descriptor.type === "position-right",
    price: descriptor.type !== "position-left" && descriptor.type !== "position-right",
  }));
  if (!dataPoint) return null;

  if (descriptor.type === "position-tp" || descriptor.type === "position-sl") {
    if (drawing.direction !== "long" && drawing.direction !== "short") return null;
    if (descriptor.type === "position-tp") {
      const tpPrice = drawing.direction === "long"
        ? Math.max(dataPoint.price, drawing.entryPrice)
        : Math.min(dataPoint.price, drawing.entryPrice);
      return frozenUpdate(drawing, { tpPrice });
    }
    const slPrice = drawing.direction === "long"
      ? Math.min(dataPoint.price, drawing.entryPrice)
      : Math.max(dataPoint.price, drawing.entryPrice);
    return frozenUpdate(drawing, { slPrice });
  }

  if (descriptor.type !== "position-left" && descriptor.type !== "position-right") return null;

  const originalRange = immutableTimeRange(descriptor.origTimeRange);
  const currentRange = immutableTimeRange(drawing.timeRange);
  const candidate = anchorFromPoint(dataPoint);
  const candidatePoint = pointFromHorizontalAnchor(candidate, drawing.entryPrice);
  const candidateScreen = candidatePoint ? dataToScreen(candidatePoint) : null;
  const visualKeys = originalRange
    ? positionVisualAnchorKeys(originalRange, drawing.entryPrice, dataToScreen)
    : null;
  if (!originalRange || !currentRange || !candidate || !finiteScreenPoint(candidateScreen) || !visualKeys) {
    return null;
  }
  if (descriptor.type === "position-left") {
    const otherScreen = visualKeys.rightKey === "start"
      ? visualKeys.startScreen
      : visualKeys.endScreen;
    if (candidateScreen.x >= otherScreen.x - 0.5) return null;
    const timeRange = Object.freeze({ ...currentRange, [visualKeys.leftKey]: candidate });
    return frozenUpdate(drawing, { timeRange });
  }
  const otherScreen = visualKeys.leftKey === "start"
    ? visualKeys.startScreen
    : visualKeys.endScreen;
  if (candidateScreen.x <= otherScreen.x + 0.5) return null;
  const timeRange = Object.freeze({ ...currentRange, [visualKeys.rightKey]: candidate });
  return frozenUpdate(drawing, { timeRange });
}

function applyAxisLineDrag(options: DrawingEntityDragOptions): SavedDrawing | null {
  const { descriptor, drawing, pos, screenToDrawingData, snap } = options;
  if (descriptor.type !== "axis-line" || drawing.type !== "axis-line") return null;
  if (drawing.axisLineType !== "horizontal"
    && drawing.axisLineType !== "vertical"
    && drawing.axisLineType !== "cross") return null;
  const next = immutableDataPoint(screenToDrawingData(pos.x, pos.y, {
    snap,
    time: drawing.axisLineType !== "horizontal",
    price: drawing.axisLineType !== "vertical",
  }));
  const base = immutableDataPoint(descriptor.origDataPoint)
    ?? immutableDataPoint(drawing.dataPoint)
    ?? next;
  if (!next || !base) return null;
  let dataPoint: DrawingDataPoint | null;
  if (drawing.axisLineType === "horizontal") {
    dataPoint = pointWithAnchor(anchorFromPoint(base), next.price);
  } else if (drawing.axisLineType === "vertical") {
    dataPoint = pointWithAnchor(anchorFromPoint(next), base.price);
  } else {
    dataPoint = next;
  }
  return dataPoint ? frozenUpdate(drawing, { dataPoint }) : null;
}

function applyShapeDrag(options: DrawingEntityDragOptions): SavedDrawing | null {
  const { descriptor, drawing, pos, screenToData, dataToScreen } = options;
  if (descriptor.type !== "shape" || drawing.type !== "shape") return null;
  const originalPoints = immutableDataPoints(descriptor.origPoints);
  if (!originalPoints || originalPoints.length < 2 || !finiteScreenPoint(descriptor.startMouse)) return null;

  let dataPoints: DrawingDataPoint[] | null;
  if (descriptor.zone === "body" || descriptor.zone === "center") {
    const first = originalPoints[0];
    const second = originalPoints[1];
    if (!first || !second) return null;
    const dx = pos.x - descriptor.startMouse.x;
    const dy = pos.y - descriptor.startMouse.y;
    const nextFirst = translatedDataPoint(first, dx, dy, dataToScreen, screenToData);
    const nextSecond = translatedDataPoint(second, dx, dy, dataToScreen, screenToData);
    dataPoints = nextFirst && nextSecond
      ? immutableDataPoints([nextFirst, nextSecond])
      : null;
  } else {
    if (!SHAPE_HANDLES.has(descriptor.zone)) return null;
    const originalBox = normalizedScreenBox(descriptor.origBox);
    const nextBox = originalBox
      ? resizedShapeBoxFromHandle(originalBox, descriptor.zone, pos)
      : null;
    if (!nextBox) return null;
    const nextFirst = immutableDataPoint(screenToData(nextBox.x, nextBox.y));
    const nextSecond = immutableDataPoint(screenToData(
      nextBox.x + nextBox.width,
      nextBox.y + nextBox.height,
    ));
    dataPoints = nextFirst && nextSecond
      ? immutableDataPoints([nextFirst, nextSecond])
      : null;
  }
  return dataPoints ? frozenUpdate(drawing, { dataPoints }) : null;
}

function applyLineLikeDrag(options: DrawingEntityDragOptions): SavedDrawing | null {
  const {
    descriptor,
    drawing,
    pos,
    screenToData,
    screenToDrawingData,
    dataToScreen,
    snap,
  } = options;
  if (descriptor.type !== "line" && descriptor.type !== "angle" && descriptor.type !== "fibonacci") {
    return null;
  }
  if ((descriptor.type === "line" && drawing.type !== "line")
    || (descriptor.type === "angle" && drawing.type !== "angle-measure")
    || (descriptor.type === "fibonacci" && drawing.type !== "fibonacci")) return null;
  const currentPoints = "dataPoints" in drawing && Array.isArray(drawing.dataPoints)
    ? immutableDataPoints(drawing.dataPoints)
    : null;
  if (!currentPoints || currentPoints.length < 2 || !Number.isInteger(descriptor.pointIndex)) return null;

  let dataPoints: DrawingDataPoint[] | null;
  if (descriptor.pointIndex >= 0) {
    if (descriptor.pointIndex >= currentPoints.length) return null;
    const next = immutableDataPoint(screenToDrawingData(pos.x, pos.y, { snap }));
    if (!next) return null;
    const changed = [...currentPoints];
    changed[descriptor.pointIndex] = next;
    dataPoints = immutableDataPoints(changed);
  } else {
    const originalPoints = immutableDataPoints(descriptor.origPoints);
    const first = originalPoints?.[0];
    const second = originalPoints?.[1];
    if (!first || !second || !finiteScreenPoint(descriptor.startMouse)) return null;
    const dx = pos.x - descriptor.startMouse.x;
    const dy = pos.y - descriptor.startMouse.y;
    const nextFirst = translatedDataPoint(first, dx, dy, dataToScreen, screenToData);
    const nextSecond = translatedDataPoint(second, dx, dy, dataToScreen, screenToData);
    dataPoints = nextFirst && nextSecond
      ? immutableDataPoints([nextFirst, nextSecond])
      : null;
  }
  return dataPoints ? frozenUpdate(drawing, { dataPoints } as Partial<typeof drawing>) : null;
}

/**
 * Produce a detached canonical SavedDrawing draft for one pointer sample.
 * The input drawing and descriptor are never mutated; any unresolved or
 * mismatched conversion fails closed with `null`.
 */
export function applyDrawingEntityDrag(options: DrawingEntityDragOptions): SavedDrawing | null {
  try {
    const { descriptor, drawing, pos } = options;
    if (!descriptor || !drawing || drawing.id !== descriptor.id || !finiteScreenPoint(pos)) return null;
    switch (descriptor.type) {
      case "text-handle":
        return applyTextHandleDrag(options);
      case "text":
        return applyTextDrag(options);
      case "position-tp":
      case "position-sl":
      case "position-move":
      case "position-left":
      case "position-right":
      case "position-top-left":
      case "position-top-right":
      case "position-bottom-left":
      case "position-bottom-right":
      case "position-panel":
        return applyPositionDrag(options);
      case "axis-line":
        return applyAxisLineDrag(options);
      case "shape":
        return applyShapeDrag(options);
      case "line":
      case "angle":
      case "fibonacci":
        return applyLineLikeDrag(options);
    }
  } catch {
    return null;
  }
}
