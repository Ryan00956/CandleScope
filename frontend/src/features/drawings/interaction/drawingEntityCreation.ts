import type { DrawingCommand } from "../core/drawingCommands.js";
import { drawingCommandsForSavedDrawing } from "../core/drawingDocumentRuntime.js";
import {
  DEFAULT_HIGHLIGHTER_BRUSH_SHAPE,
  DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION,
  DEFAULT_HIGHLIGHTER_OPACITY,
  nextDrawingId,
} from "../drawingModel.js";
import { normalizeSavedDrawingItemStrict } from "../drawingPersistence.js";
import { normalizeFreehandStroke } from "../freehandStrokeModel.js";
import type {
  AngleToolId,
  AxisLineToolId,
  BasicLineToolId,
  BrushShape,
  DrawingDataPoint,
  FibonacciLevel,
  FibonacciToolId,
  FreehandStroke,
  PositionInfoPanelOffset,
  PositionTimeRange,
  PositionToolId,
  SavedAngleDrawing,
  SavedAxisLineDrawing,
  SavedDrawing,
  SavedFibonacciDrawing,
  SavedFreehandDrawing,
  SavedHighlighterDrawing,
  SavedLineDrawing,
  SavedPositionDrawing,
  SavedShapeDrawing,
  SavedTextDrawing,
  ShapeLineStyle,
  ShapeToolId,
  TextAlign,
} from "../drawingTypes.js";

export type CreatedSavedDrawing<TDrawing extends SavedDrawing = SavedDrawing> =
  TDrawing & { id: string };

export type TwoPointCreationTool =
  | BasicLineToolId
  | AngleToolId
  | FibonacciToolId
  | ShapeToolId;

export type SavedTwoPointDrawing =
  | SavedLineDrawing
  | SavedAngleDrawing
  | SavedFibonacciDrawing
  | SavedShapeDrawing;

export interface TwoPointSavedDrawingOptions {
  readonly color: string;
  readonly dataPoints: readonly DrawingDataPoint[];
  readonly fibInverted?: boolean;
  readonly fibLevels?: readonly FibonacciLevel[] | null;
  readonly lineStyle?: ShapeLineStyle;
  readonly lineWidth: number;
  readonly tool: TwoPointCreationTool;
}

export interface AxisLineSavedDrawingOptions {
  readonly color: string;
  readonly dataPoint: DrawingDataPoint;
  readonly lineWidth: number;
  readonly tool: AxisLineToolId;
}

export interface TextSavedDrawingOptions {
  readonly align?: TextAlign;
  readonly bgColor?: string | null;
  readonly bold?: boolean;
  readonly borderColor?: string | null;
  readonly borderWidth?: number;
  readonly color: string;
  readonly dataPoint: DrawingDataPoint;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly italic?: boolean;
  readonly padding?: number;
  readonly text?: string;
  readonly underline?: boolean;
  readonly widthPx?: number | null;
}

export interface PositionSavedDrawingOptions {
  readonly dataPoint: DrawingDataPoint;
  readonly infoPanelOffset?: PositionInfoPanelOffset;
  readonly positionSize?: number;
  readonly slOffset?: number;
  readonly timeRange: PositionTimeRange;
  readonly tool: PositionToolId;
  readonly tpOffset?: number;
  readonly visiblePriceRange?: number | null;
}

interface FinalizedStrokeSavedDrawingOptions {
  readonly color: string;
  readonly lineWidth: number;
  readonly stroke: FreehandStroke;
}

export interface FinalizedPenSavedDrawingOptions extends FinalizedStrokeSavedDrawingOptions {
  readonly tool: "pen";
}

export interface FinalizedHighlighterSavedDrawingOptions
  extends FinalizedStrokeSavedDrawingOptions {
  readonly brushShape?: BrushShape;
  readonly compositeOperation?: GlobalCompositeOperation;
  readonly opacity?: number;
  readonly tool: "highlighter";
}

export type FinalizedFreehandSavedDrawingOptions =
  | FinalizedPenSavedDrawingOptions
  | FinalizedHighlighterSavedDrawingOptions;

function finalizedCreatedDrawing<TDrawing extends SavedDrawing>(
  prefix: string,
  candidate: TDrawing,
): CreatedSavedDrawing<TDrawing> | null {
  const normalized = normalizeSavedDrawingItemStrict(candidate);
  if (!normalized || normalized.type !== candidate.type) return null;

  const id = nextDrawingId(prefix);
  const created = normalizeSavedDrawingItemStrict({ ...normalized, id });
  if (!created || created.type !== candidate.type || created.id !== id) return null;
  return created as CreatedSavedDrawing<TDrawing>;
}

/** Build the terminal two-anchor data payload for lines, angles, fibs, and shapes. */
export function createTwoPointSavedDrawing({
  color,
  dataPoints,
  fibInverted,
  fibLevels,
  lineStyle,
  lineWidth,
  tool,
}: TwoPointSavedDrawingOptions): CreatedSavedDrawing<SavedTwoPointDrawing> | null {
  if (!Array.isArray(dataPoints) || dataPoints.length !== 2) return null;
  const points = (dataPoints as readonly DrawingDataPoint[])
    .map((point) => ({ ...point }));

  if (tool === "angle-measure") {
    return finalizedCreatedDrawing("ang", {
      type: "angle-measure",
      dataPoints: points,
      color,
      lineWidth,
    });
  }
  if (tool === "fibonacci") {
    return finalizedCreatedDrawing("fib", {
      type: "fibonacci",
      dataPoints: points,
      color,
      lineWidth,
      ...(fibLevels == null
        ? {}
        : { levels: fibLevels.map((level) => ({ ...level })) }),
      inverted: fibInverted ?? false,
    });
  }
  if (tool === "shape-rectangle" || tool === "shape-ellipse") {
    return finalizedCreatedDrawing("sh", {
      type: "shape",
      shapeType: tool === "shape-rectangle" ? "rectangle" : "ellipse",
      dataPoints: points,
      color,
      lineWidth,
      fillColor: color,
      fillOpacity: 0.12,
      ...(lineStyle === undefined ? {} : { lineStyle }),
    });
  }
  if (tool !== "line-segment" && tool !== "line-ray" && tool !== "line-infinite") {
    return null;
  }
  return finalizedCreatedDrawing("ln", {
    type: "line",
    lineType: tool,
    dataPoints: points,
    color,
    lineWidth,
  });
}

/** Map one axis tool to its canonical kind and axis geometry. */
export function createAxisLineSavedDrawing({
  color,
  dataPoint,
  lineWidth,
  tool,
}: AxisLineSavedDrawingOptions): CreatedSavedDrawing<SavedAxisLineDrawing> | null {
  const axisLineType = tool === "line-horizontal"
    ? "horizontal"
    : tool === "line-vertical"
    ? "vertical"
    : tool === "line-cross"
    ? "cross"
    : null;
  if (!axisLineType) return null;
  return finalizedCreatedDrawing("ax", {
    type: "axis-line",
    axisLineType,
    dataPoint: { ...dataPoint },
    color,
    lineWidth,
  });
}

/** Build a persistent text payload; overlay confirmation remains a caller concern. */
export function createTextSavedDrawing({
  align,
  bgColor,
  bold,
  borderColor,
  borderWidth,
  color,
  dataPoint,
  fontFamily,
  fontSize,
  italic,
  padding,
  text,
  underline,
  widthPx,
}: TextSavedDrawingOptions): CreatedSavedDrawing<SavedTextDrawing> | null {
  return finalizedCreatedDrawing("tx", {
    type: "text",
    dataPoint: { ...dataPoint },
    text: text ?? "",
    color,
    fontSize: fontSize || 14,
    bold: bold || false,
    italic: italic || false,
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(underline === undefined ? {} : { underline }),
    ...(align === undefined ? {} : { align }),
    ...(bgColor === undefined ? {} : { bgColor }),
    ...(borderColor === undefined ? {} : { borderColor }),
    ...(borderWidth === undefined ? {} : { borderWidth }),
    ...(widthPx === undefined ? {} : { widthPx }),
    ...(padding === undefined ? {} : { padding }),
  });
}

function defaultPositionOffset(
  visiblePriceRange: number | null | undefined,
  entryPrice: number,
  visibleRatio: number,
  entryRatio: number,
): number {
  const visibleOffset = visiblePriceRange != null && Number.isFinite(visiblePriceRange)
    ? visiblePriceRange * visibleRatio
    : undefined;
  return visibleOffset || entryPrice * entryRatio;
}

/** Build a position using the existing visible-range TP/SL policy and zero-safe sizing. */
export function createPositionSavedDrawing({
  dataPoint,
  infoPanelOffset,
  positionSize,
  slOffset,
  timeRange,
  tool,
  tpOffset,
  visiblePriceRange,
}: PositionSavedDrawingOptions): CreatedSavedDrawing<SavedPositionDrawing> | null {
  if (tool !== "position-long" && tool !== "position-short") return null;
  const entryPrice = dataPoint.price;
  const resolvedTpOffset = tpOffset ?? defaultPositionOffset(
    visiblePriceRange,
    entryPrice,
    0.12,
    0.03,
  );
  const resolvedSlOffset = slOffset ?? defaultPositionOffset(
    visiblePriceRange,
    entryPrice,
    0.06,
    0.015,
  );
  const isLong = tool === "position-long";

  return finalizedCreatedDrawing("pos", {
    type: "position",
    direction: isLong ? "long" : "short",
    entryPrice,
    tpPrice: isLong ? entryPrice + resolvedTpOffset : entryPrice - resolvedTpOffset,
    slPrice: isLong ? entryPrice - resolvedSlOffset : entryPrice + resolvedSlOffset,
    timeRange: {
      start: typeof timeRange.start === "object" && timeRange.start !== null
        ? { ...timeRange.start }
        : timeRange.start,
      end: typeof timeRange.end === "object" && timeRange.end !== null
        ? { ...timeRange.end }
        : timeRange.end,
    },
    positionSize: positionSize ?? 1_000,
    ...(infoPanelOffset === undefined
      ? {}
      : { infoPanelOffset: { ...infoPanelOffset } }),
  });
}

/** Accept only a finalized canonical stroke; capture/finalization stays outside this module. */
export function createFinalizedFreehandSavedDrawing(
  options: FinalizedFreehandSavedDrawingOptions,
): CreatedSavedDrawing<SavedFreehandDrawing | SavedHighlighterDrawing> | null {
  const stroke = normalizeFreehandStroke(options.stroke);
  if (!stroke) return null;
  if (options.tool === "pen") {
    return finalizedCreatedDrawing("fh", {
      type: "freehand",
      stroke,
      color: options.color,
      lineWidth: options.lineWidth,
    });
  }
  if (options.tool !== "highlighter") return null;
  return finalizedCreatedDrawing("hl", {
    type: "highlighter",
    stroke,
    color: options.color,
    lineWidth: options.lineWidth,
    opacity: options.opacity ?? DEFAULT_HIGHLIGHTER_OPACITY,
    compositeOperation: options.compositeOperation
      ?? DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION,
    brushShape: options.brushShape ?? DEFAULT_HIGHLIGHTER_BRUSH_SHAPE,
  });
}

/** Convert one strict data payload to an atomic create command, rejecting any malformed input. */
export function drawingCreateCommandsForSavedDrawing(
  saved: SavedDrawing | null | undefined,
): readonly DrawingCommand[] | null {
  if (!saved) return null;
  try {
    const commands = drawingCommandsForSavedDrawing(saved, { type: "create" });
    if (commands?.length !== 1) return null;
    const command = commands[0];
    if (command?.type !== "create" || command.entity.id !== saved.id) return null;
    return commands;
  } catch {
    return null;
  }
}
