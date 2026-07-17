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
  observeDrawingId,
} from "./drawingModel.js";
import { normalizeSavedFreehandPayload } from "./freehandStrokeModel.js";
import type {
  AngleToolId,
  AxisLineType,
  BasicLineToolId,
  DrawingDataPoint,
  DrawingPrimitive,
  FibonacciLevel,
  FibonacciToolId,
  FreehandToolId,
  PositionTimeRange,
  PositionToolId,
  SavedDrawing,
  ScreenPoint,
  ShapeToolId,
  ShapeType,
} from "./drawingTypes.js";

interface FreehandFactoryOptions {
  tool: FreehandToolId;
  dataPoint?: DrawingDataPoint | null;
  color: string;
  lineWidth: number;
  previewPoints?: Array<ScreenPoint | null>;
  isPreview?: boolean;
}

interface TextFactoryOptions {
  dataPoint: DrawingDataPoint;
  color: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
}

interface PositionFactoryOptions {
  tool: PositionToolId;
  dataPoint: DrawingDataPoint;
  timeRange: PositionTimeRange;
  tpOffset: number;
  slOffset: number;
  positionSize?: number;
}

interface AxisLineFactoryOptions {
  axisLineType: AxisLineType;
  dataPoint: DrawingDataPoint;
  color: string;
  lineWidth: number;
}

type TwoPointFactoryTool = BasicLineToolId | AngleToolId | FibonacciToolId | ShapeToolId;
type TwoPointDrawingPrimitive = LineDrawingPrimitive
  | AngleMeasurementPrimitive
  | FibonacciDrawingPrimitive
  | ShapeDrawingPrimitive;

interface TwoPointFactoryOptions {
  tool: TwoPointFactoryTool;
  shapeType?: ShapeType | null;
  dataPoints: DrawingDataPoint[];
  color: string;
  lineWidth: number;
  fibLevels?: FibonacciLevel[] | null;
  fibInverted?: boolean;
}

interface PreviewFactoryOptions extends Omit<TwoPointFactoryOptions, "dataPoints"> {
  dataPoint: DrawingDataPoint;
}

export function createPrimitiveFromSavedDrawing(
  item: SavedDrawing | null | undefined,
): DrawingPrimitive | null {
  if (!item) return null;
  observeDrawingId(item.id);
  const hasStroke = Object.prototype.hasOwnProperty.call(item, "stroke");
  if (hasStroke && item.type !== "freehand" && item.type !== "highlighter") return null;
  if (item.type === "line") {
    return new LineDrawingPrimitive({
      id: item.id || nextDrawingId("ln"),
      ...(item.lineType === undefined ? {} : { lineType: item.lineType }),
      ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
    });
  }
  if (item.type === "axis-line") {
    return new AxisLineDrawingPrimitive({
      id: item.id || nextDrawingId("ax"),
      ...(item.axisLineType === undefined ? {} : { axisLineType: item.axisLineType }),
      ...(item.dataPoint === undefined ? {} : { dataPoint: item.dataPoint }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
    });
  }
  if (item.type === "angle-measure") {
    return new AngleMeasurementPrimitive({
      id: item.id || nextDrawingId("ang"),
      ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
    });
  }
  if (item.type === "text") {
    return new TextDrawingPrimitive({
      id: item.id || nextDrawingId("tx"),
      ...(item.dataPoint === undefined ? {} : { dataPoint: item.dataPoint }),
      ...(item.text === undefined ? {} : { text: item.text }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.fontSize === undefined ? {} : { fontSize: item.fontSize }),
      ...(item.fontFamily === undefined ? {} : { fontFamily: item.fontFamily }),
      ...(item.bold === undefined ? {} : { bold: item.bold }),
      ...(item.italic === undefined ? {} : { italic: item.italic }),
      ...(item.underline === undefined ? {} : { underline: item.underline }),
      ...(item.align === undefined ? {} : { align: item.align }),
      ...(item.bgColor === undefined ? {} : { bgColor: item.bgColor }),
      ...(item.borderColor === undefined ? {} : { borderColor: item.borderColor }),
      ...(item.borderWidth === undefined ? {} : { borderWidth: item.borderWidth }),
      ...(item.widthPx === undefined ? {} : { widthPx: item.widthPx }),
      ...(item.padding === undefined ? {} : { padding: item.padding }),
    });
  }
  if (item.type === "fibonacci") {
    return new FibonacciDrawingPrimitive({
      id: item.id || nextDrawingId("fib"),
      ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
      ...(item.levels === undefined ? {} : { levels: item.levels }),
      inverted: item.inverted || false,
    });
  }
  if (item.type === "position") {
    if (typeof item.entryPrice !== "number") return null;
    return new PositionDrawingPrimitive({
      id: item.id || nextDrawingId("pos"),
      ...(item.direction === undefined ? {} : { direction: item.direction }),
      entryPrice: item.entryPrice,
      ...(item.tpPrice === undefined ? {} : { tpPrice: item.tpPrice }),
      ...(item.slPrice === undefined ? {} : { slPrice: item.slPrice }),
      ...(item.timeRange === undefined ? {} : { timeRange: item.timeRange }),
      ...(item.positionSize === undefined ? {} : { positionSize: item.positionSize }),
      ...(item.infoPanelOffset === undefined ? {} : { infoPanelOffset: item.infoPanelOffset }),
    });
  }
  if (item.type === "shape") {
    return new ShapeDrawingPrimitive({
      id: item.id || nextDrawingId("sh"),
      ...(item.shapeType === undefined ? {} : { shapeType: item.shapeType }),
      ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
      ...(item.fillColor === undefined ? {} : { fillColor: item.fillColor }),
      ...(item.fillOpacity === undefined ? {} : { fillOpacity: item.fillOpacity }),
      ...(item.lineStyle === undefined ? {} : { lineStyle: item.lineStyle }),
    });
  }
  if (item.type === "highlighter") {
    const payload = normalizeSavedFreehandPayload(item);
    if (!payload) return null;
    return new FreehandDrawingPrimitive({
      id: item.id || nextDrawingId("hl"),
      type: "highlighter",
      ...payload,
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
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
      ...(item.color === undefined ? {} : { color: item.color }),
      ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
    });
  }
  return null;
}

export function createFreehandPrimitive({
  tool,
  dataPoint = null,
  color,
  lineWidth,
  previewPoints,
  isPreview = false,
}: FreehandFactoryOptions): FreehandDrawingPrimitive {
  const isHighlighter = tool === "highlighter";
  return new FreehandDrawingPrimitive({
    id: nextDrawingId(isHighlighter ? "hl" : "fh"),
    type: isHighlighter ? "highlighter" : "freehand",
    dataPoints: dataPoint ? [dataPoint] : [],
    ...(previewPoints === undefined ? {} : { previewPoints }),
    isPreview,
    color,
    lineWidth,
    opacity: isHighlighter ? DEFAULT_HIGHLIGHTER_OPACITY : 1,
    compositeOperation: isHighlighter ? DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION : "source-over",
    brushShape: isHighlighter ? DEFAULT_HIGHLIGHTER_BRUSH_SHAPE : "round",
  });
}

export function createTextPrimitive({
  dataPoint,
  color,
  fontSize,
  bold,
  italic,
}: TextFactoryOptions): TextDrawingPrimitive {
  const primitive = new TextDrawingPrimitive({
    id: nextDrawingId("tx"),
    dataPoint,
    text: "",
    color,
    fontSize: fontSize || 14,
    bold: bold || false,
    italic: italic || false,
  });
  primitive.markUnconfirmedText();
  return primitive;
}

export function createPositionPrimitive({
  tool,
  dataPoint,
  timeRange,
  tpOffset,
  slOffset,
  positionSize,
}: PositionFactoryOptions): PositionDrawingPrimitive {
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

export function createAxisLinePrimitive({
  axisLineType,
  dataPoint,
  color,
  lineWidth,
}: AxisLineFactoryOptions): AxisLineDrawingPrimitive {
  return new AxisLineDrawingPrimitive({
    id: nextDrawingId("ax"),
    axisLineType,
    dataPoint,
    color,
    lineWidth,
  });
}

export function createTwoPointDrawingPrimitive({
  tool,
  shapeType,
  dataPoints,
  color,
  lineWidth,
  fibLevels,
  fibInverted,
}: TwoPointFactoryOptions): TwoPointDrawingPrimitive {
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
      ...(fibLevels ? { levels: fibLevels.map((level) => ({ ...level })) } : {}),
      inverted: fibInverted || false,
    });
  }
  if (tool === "shape-rectangle" || tool === "shape-ellipse") {
    throw new TypeError("Shape drawing creation requires a shapeType");
  }
  return new LineDrawingPrimitive({
    id: nextDrawingId("ln"),
    lineType: tool,
    dataPoints,
    color,
    lineWidth,
  });
}

export function createPreviewPrimitive({
  tool,
  shapeType,
  dataPoint,
  color,
  lineWidth,
  fibLevels,
  fibInverted,
}: PreviewFactoryOptions): TwoPointDrawingPrimitive {
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
      ...(fibLevels ? { levels: fibLevels.map((level) => ({ ...level })) } : {}),
      inverted: fibInverted || false,
    });
  }
  if (tool === "shape-rectangle" || tool === "shape-ellipse") {
    throw new TypeError("Shape preview creation requires a shapeType");
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
