import { AxisLineDrawingPrimitive } from "./primitives/AxisLineDrawingPrimitive.js";
import { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "./primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import {
  DEFAULT_HIGHLIGHTER_BRUSH_SHAPE,
  DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION,
  DEFAULT_HIGHLIGHTER_OPACITY,
  nextDrawingId,
} from "./drawingModel.js";
import { normalizeSavedFreehandPayload } from "./freehandStrokeModel.js";

export function createPrimitiveFromSavedDrawing(item) {
  if (!item) return null;
  const hasStroke = Object.prototype.hasOwnProperty.call(item, "stroke");
  if (hasStroke && item.type !== "freehand" && item.type !== "highlighter") return null;
  if (item.type === "line") {
    return new LineDrawingPrimitive({
      id: item.id || nextDrawingId("ln"),
      lineType: item.lineType,
      dataPoints: item.dataPoints,
      color: item.color,
      lineWidth: item.lineWidth,
    });
  }
  if (item.type === "axis-line") {
    return new AxisLineDrawingPrimitive({
      id: item.id || nextDrawingId("ax"),
      axisLineType: item.axisLineType,
      dataPoint: item.dataPoint,
      color: item.color,
      lineWidth: item.lineWidth,
    });
  }
  if (item.type === "angle-measure") {
    return new AngleMeasurementPrimitive({
      id: item.id || nextDrawingId("ang"),
      dataPoints: item.dataPoints,
      color: item.color,
      lineWidth: item.lineWidth,
    });
  }
  if (item.type === "text") {
    return new TextDrawingPrimitive({
      id: item.id || nextDrawingId("tx"),
      dataPoint: item.dataPoint,
      text: item.text,
      color: item.color,
      fontSize: item.fontSize,
      fontFamily: item.fontFamily,
      bold: item.bold,
      italic: item.italic,
      underline: item.underline,
      align: item.align,
      bgColor: item.bgColor,
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      widthPx: item.widthPx,
      padding: item.padding,
    });
  }
  if (item.type === "fibonacci") {
    return new FibonacciDrawingPrimitive({
      id: item.id || nextDrawingId("fib"),
      dataPoints: item.dataPoints,
      color: item.color,
      lineWidth: item.lineWidth,
      levels: item.levels,
      inverted: item.inverted || false,
    });
  }
  if (item.type === "position") {
    return new PositionDrawingPrimitive({
      id: item.id || nextDrawingId("pos"),
      direction: item.direction,
      entryPrice: item.entryPrice,
      tpPrice: item.tpPrice,
      slPrice: item.slPrice,
      timeRange: item.timeRange,
      positionSize: item.positionSize,
      infoPanelOffset: item.infoPanelOffset,
    });
  }
  if (item.type === "shape") {
    return new ShapeDrawingPrimitive({
      id: item.id || nextDrawingId("sh"),
      shapeType: item.shapeType,
      dataPoints: item.dataPoints,
      color: item.color,
      lineWidth: item.lineWidth,
      fillColor: item.fillColor,
      fillOpacity: item.fillOpacity,
      lineStyle: item.lineStyle,
    });
  }
  if (item.type === "highlighter") {
    const payload = normalizeSavedFreehandPayload(item);
    if (!payload) return null;
    return new FreehandDrawingPrimitive({
      id: item.id || nextDrawingId("hl"),
      type: "highlighter",
      ...payload,
      color: item.color,
      lineWidth: item.lineWidth,
      opacity: item.opacity ?? DEFAULT_HIGHLIGHTER_OPACITY,
      compositeOperation: item.compositeOperation || DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION,
      brushShape: item.brushShape || DEFAULT_HIGHLIGHTER_BRUSH_SHAPE,
    });
  }
  if (item.type === "freehand") {
    const payload = normalizeSavedFreehandPayload(item);
    if (!payload) return null;
    return new FreehandDrawingPrimitive({
      id: item.id || nextDrawingId("fh"),
      ...payload,
      color: item.color,
      lineWidth: item.lineWidth,
    });
  }
  return null;
}

export function createFreehandPrimitive({ tool, dataPoint, color, lineWidth }) {
  const isHighlighter = tool === "highlighter";
  return new FreehandDrawingPrimitive({
    id: nextDrawingId(isHighlighter ? "hl" : "fh"),
    type: isHighlighter ? "highlighter" : "freehand",
    dataPoints: [dataPoint],
    color,
    lineWidth,
    opacity: isHighlighter ? DEFAULT_HIGHLIGHTER_OPACITY : 1,
    compositeOperation: isHighlighter ? DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION : "source-over",
    brushShape: isHighlighter ? DEFAULT_HIGHLIGHTER_BRUSH_SHAPE : "round",
  });
}

export function createTextPrimitive({ dataPoint, color, fontSize, bold, italic }) {
  return new TextDrawingPrimitive({
    id: nextDrawingId("tx"),
    dataPoint,
    text: "",
    color,
    fontSize: fontSize || 14,
    bold: bold || false,
    italic: italic || false,
  });
}

export function createPositionPrimitive({ tool, dataPoint, timeRange, tpOffset, slOffset, positionSize }) {
  const isLong = tool === "position-long";
  const entryPrice = dataPoint.price;
  return new PositionDrawingPrimitive({
    id: nextDrawingId("pos"),
    direction: isLong ? "long" : "short",
    entryPrice,
    tpPrice: isLong ? entryPrice + tpOffset : entryPrice - tpOffset,
    slPrice: isLong ? entryPrice - slOffset : entryPrice + slOffset,
    timeRange,
    positionSize: positionSize || 1000,
  });
}

export function createAxisLinePrimitive({ axisLineType, dataPoint, color, lineWidth }) {
  return new AxisLineDrawingPrimitive({
    id: nextDrawingId("ax"),
    axisLineType,
    dataPoint,
    color,
    lineWidth,
  });
}

export function createTwoPointDrawingPrimitive({ tool, shapeType, dataPoints, color, lineWidth, fibLevels, fibInverted }) {
  if (shapeType) {
    return new ShapeDrawingPrimitive({
      id: nextDrawingId("sh"),
      shapeType,
      dataPoints,
      color,
      lineWidth,
      fillColor: color,
      fillOpacity: 0.12,
    });
  }
  if (tool === "angle-measure") {
    return new AngleMeasurementPrimitive({
      id: nextDrawingId("ang"),
      dataPoints,
      color,
      lineWidth,
    });
  }
  if (tool === "fibonacci") {
    return new FibonacciDrawingPrimitive({
      id: nextDrawingId("fib"),
      dataPoints,
      color,
      lineWidth,
      levels: fibLevels ? fibLevels.map((level) => ({ ...level })) : undefined,
      inverted: fibInverted || false,
    });
  }
  return new LineDrawingPrimitive({
    id: nextDrawingId("ln"),
    lineType: tool,
    dataPoints,
    color,
    lineWidth,
  });
}

export function createPreviewPrimitive({ tool, shapeType, dataPoint, color, lineWidth, fibLevels, fibInverted }) {
  const dataPoints = [dataPoint, dataPoint];
  if (shapeType) {
    return new ShapeDrawingPrimitive({
      id: "__preview__",
      shapeType,
      dataPoints,
      color,
      lineWidth,
      fillColor: color,
      fillOpacity: 0.12,
      isPreview: true,
    });
  }
  if (tool === "angle-measure") {
    return new AngleMeasurementPrimitive({
      id: "__preview__",
      dataPoints,
      color,
      lineWidth,
      isPreview: true,
    });
  }
  if (tool === "fibonacci") {
    return new FibonacciDrawingPrimitive({
      id: "__preview__",
      dataPoints,
      color,
      lineWidth,
      isPreview: true,
      levels: fibLevels ? fibLevels.map((level) => ({ ...level })) : undefined,
      inverted: fibInverted || false,
    });
  }
  return new LineDrawingPrimitive({
    id: "__preview__",
    lineType: tool,
    dataPoints,
    color,
    lineWidth,
    isPreview: true,
  });
}
