import type {
  ChartPrimitiveCanvasTarget,
  ChartPrimitivePaneRenderer,
  ChartPrimitivePaneView,
  ChartSeriesAttachedParameter,
} from "../../chart-adapter/drawingPrimitiveTypes.js";
import type { ChartDrawingAnchorMode } from "../chart-representation/chartRepresentationTypes.js";
import type { createLightweightChartAdapter } from "../../chart-adapter/chartInstanceBridge.js";
import type { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import type { AxisLineDrawingPrimitive } from "./primitives/AxisLineDrawingPrimitive.js";
import type { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import type { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import type { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import type { PositionDrawingPrimitive } from "./primitives/PositionDrawingPrimitive.js";
import type { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import type { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";

export type DrawingToolId =
  | "cursor-default"
  | "cursor-crosshair"
  | "cursor-dot"
  | "cursor-highlighter"
  | "cursor-plain"
  | "eraser"
  | "line-segment"
  | "line-ray"
  | "line-infinite"
  | "line-horizontal"
  | "line-vertical"
  | "line-cross"
  | "angle-measure"
  | "fibonacci"
  | "position-long"
  | "position-short"
  | "shape-rectangle"
  | "shape-ellipse"
  | "text"
  | "pen"
  | "highlighter";

export type PassiveCursorToolId = Extract<DrawingToolId, `cursor-${string}`>;
export type BasicLineToolId = "line-segment" | "line-ray" | "line-infinite";
export type AxisLineToolId = "line-horizontal" | "line-vertical" | "line-cross";
export type AngleToolId = "angle-measure";
export type FibonacciToolId = "fibonacci";
export type PositionToolId = "position-long" | "position-short";
export type ShapeToolId = "shape-rectangle" | "shape-ellipse";
export type FreehandToolId = "pen" | "highlighter";

export type DrawingKind =
  | "line"
  | "axis-line"
  | "angle-measure"
  | "text"
  | "fibonacci"
  | "position"
  | "shape"
  | "freehand"
  | "highlighter";

export type DrawingHitType =
  | "line"
  | "axis-line"
  | "angle"
  | "fibonacci"
  | "position"
  | "shape"
  | "text"
  | "freehand"
  | "highlighter";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface MutableRef<T> {
  current: T;
}

export interface ScreenBox extends ScreenPoint {
  width: number;
  height: number;
  right?: number;
  bottom?: number;
}

/** Canonical anchor for an ordinary time-axis chart. */
export interface SourceTimeAnchor {
  time: number;
  logical?: never;
  sourceOrdinal?: never;
  sourceProjection?: never;
  sourceProjectionConfig?: never;
}

/** Canonical source-lineage anchor for a synthetic/derived representation. */
export interface OrdinalLineageAnchor {
  time: number;
  sourceOrdinal?: number;
  sourceProjection?: string;
  sourceProjectionConfig?: string;
  logical?: never;
}

/** Read-only compatibility fallback for drawings saved before canonical anchors. */
export interface LegacyLogicalAnchor {
  logical: number;
  time?: number | null;
  sourceOrdinal?: never;
  sourceProjection?: never;
  sourceProjectionConfig?: never;
}

export type DrawingAnchor = SourceTimeAnchor | OrdinalLineageAnchor | LegacyLogicalAnchor;
export type HorizontalDrawingAnchor = number | DrawingAnchor;

export type DrawingDataPoint = DrawingAnchor & Record<string, unknown> & {
  price: number;
};

export interface ExactOrdinalAnchor {
  time: number;
  sourceOrdinal: number;
}

export interface SourceLineageSpan {
  exact: {
    left: ExactOrdinalAnchor;
    right: ExactOrdinalAnchor;
  };
  fallback: {
    fromTime: number;
    toTime: number;
    leftRatio: number;
    rightRatio: number;
  };
}

export interface FreehandSpanPoint {
  span: number;
  ratio: number;
  price: number;
}

export interface FreehandTimePoint {
  time: number;
  price: number;
}

export interface FreehandExactPoint {
  anchor: ExactOrdinalAnchor;
  price: number;
}

export type FreehandStrokeV3Point = FreehandSpanPoint | FreehandTimePoint | FreehandExactPoint;

export interface FreehandStrokeV2 {
  version: 2;
  sourceProjection: string;
  sourceProjectionConfig: string;
  spans: readonly SourceLineageSpan[];
  points: readonly FreehandSpanPoint[];
}

export interface FreehandStrokeV3 {
  version: 3;
  sourceProjection: string;
  sourceProjectionConfig: string;
  spans: readonly SourceLineageSpan[];
  points: readonly FreehandStrokeV3Point[];
}

export type FreehandStroke = FreehandStrokeV2 | FreehandStrokeV3;

export interface FreehandStrokeDraft {
  readonly __freehandStrokeDraft?: never;
}

export interface FreehandStrokeDraftOptions {
  sourceProjection?: unknown;
  sourceProjectionConfig?: unknown;
  captureIdentity?: unknown;
}

export interface FreehandCaptureBatch {
  captureIdentity?: unknown;
  sourceProjection?: unknown;
  sourceProjectionConfig?: unknown;
  captures?: unknown;
}

export interface FreehandAppendResult {
  appendedCount: number;
  previewPoints: Array<ScreenPoint | null>;
  saturated: boolean;
}

export interface FreehandFinalizeOptions {
  captureIdentity?: unknown;
  epsilon?: number;
}

export interface ResolvedFreehandPoint {
  x: number;
  price: number;
}

export interface ResolvedFreehandSpan {
  left: number;
  right: number;
}

export type FreehandSpanResolver = (
  span: SourceLineageSpan,
  spanIndex: number,
  stroke: FreehandStroke,
) => unknown;

export type FreehandAnchorResolver = (
  anchor: ExactOrdinalAnchor,
  pointIndex: number,
  point: FreehandStrokeV3Point,
  stroke: FreehandStrokeV3,
) => unknown;

export type FreehandTimeResolver = (
  time: number,
  pointIndex: number,
  point: FreehandStrokeV3Point,
  stroke: FreehandStrokeV3,
) => unknown;

export type FreehandBatchResolveRequest =
  | {
      readonly kind: "time";
      readonly time: number;
      readonly pointIndex: number;
      readonly point: FreehandTimePoint;
    }
  | {
      readonly kind: "anchor";
      readonly anchor: ExactOrdinalAnchor;
      readonly pointIndex: number;
      readonly point: FreehandExactPoint;
    };

/**
 * Resolve every absolute-time/exact-anchor point in one normalized v3 stroke.
 * Results are positional and must be an equally sized array containing only
 * finite horizontal coordinates or explicit `null` path gaps.
 */
export type FreehandBatchResolver = (
  requests: readonly FreehandBatchResolveRequest[],
  stroke: FreehandStrokeV3,
) => unknown;

export interface FreehandStrokeResolvers {
  resolveAnchor?: FreehandAnchorResolver | null;
  resolveBatch?: FreehandBatchResolver | null;
  resolveSpan?: FreehandSpanResolver | null;
  resolveTime?: FreehandTimeResolver | null;
}

export type SavedFreehandPayload =
  | { stroke: FreehandStroke; dataPoints?: never }
  | { dataPoints: DrawingDataPoint[]; stroke?: never };

interface SavedDrawingBase<TKind extends DrawingKind> {
  type: TKind;
  id?: string;
}

export interface SavedLineDrawing extends SavedDrawingBase<"line"> {
  lineType?: BasicLineToolId;
  dataPoints?: DrawingDataPoint[];
  color?: string;
  lineWidth?: number;
}

export interface SavedAxisLineDrawing extends SavedDrawingBase<"axis-line"> {
  axisLineType?: AxisLineType;
  dataPoint?: DrawingDataPoint;
  color?: string;
  lineWidth?: number;
}

export interface SavedAngleDrawing extends SavedDrawingBase<"angle-measure"> {
  dataPoints?: DrawingDataPoint[];
  color?: string;
  lineWidth?: number;
}

export interface SavedTextDrawing extends SavedDrawingBase<"text"> {
  dataPoint?: DrawingDataPoint;
  text?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
  bgColor?: string | null;
  borderColor?: string | null;
  borderWidth?: number;
  widthPx?: number | null;
  padding?: number;
}

export interface FibonacciLevel {
  level: number;
  color: string;
  enabled: boolean;
}

export interface SavedFibonacciDrawing extends SavedDrawingBase<"fibonacci"> {
  dataPoints?: DrawingDataPoint[];
  color?: string;
  lineWidth?: number;
  levels?: FibonacciLevel[];
  inverted?: boolean;
}

export interface PositionTimeRange {
  start: HorizontalDrawingAnchor | null;
  end: HorizontalDrawingAnchor | null;
}

export type PositionInfoPanelAnchor = "left" | "right";

export interface PositionInfoPanelOffset {
  anchor?: PositionInfoPanelAnchor;
  x: number;
  y: number;
}

export interface SavedPositionDrawing extends SavedDrawingBase<"position"> {
  direction?: PositionDirection;
  entryPrice?: number;
  tpPrice?: number | null;
  slPrice?: number | null;
  timeRange?: PositionTimeRange;
  positionSize?: number;
  infoPanelOffset?: PositionInfoPanelOffset;
}

export interface SavedShapeDrawing extends SavedDrawingBase<"shape"> {
  shapeType?: ShapeType;
  dataPoints?: DrawingDataPoint[];
  color?: string;
  lineWidth?: number;
  fillColor?: string;
  fillOpacity?: number;
  lineStyle?: ShapeLineStyle;
}

export type SavedFreehandDrawing = SavedDrawingBase<"freehand"> & SavedFreehandPayload & {
  color?: string;
  lineWidth?: number;
};

export type SavedHighlighterDrawing = SavedDrawingBase<"highlighter"> & SavedFreehandPayload & {
  color?: string;
  lineWidth?: number;
  opacity?: number;
  compositeOperation?: GlobalCompositeOperation;
  brushShape?: BrushShape;
};

export type SavedDrawing =
  | SavedLineDrawing
  | SavedAxisLineDrawing
  | SavedAngleDrawing
  | SavedTextDrawing
  | SavedFibonacciDrawing
  | SavedPositionDrawing
  | SavedShapeDrawing
  | SavedFreehandDrawing
  | SavedHighlighterDrawing;

export type AxisLineType = "horizontal" | "vertical" | "cross";
export type ShapeType = "rectangle" | "ellipse";
export type ShapeLineStyle = "solid" | "dashed" | "dotted";
export type PositionDirection = "long" | "short";
export type TextAlign = "left" | "center" | "right";
export type BrushShape = "round" | "square";
export type FreehandKind = "freehand" | "highlighter";

export interface PrimitiveBaseOptions {
  id: string;
  color?: string;
  lineWidth?: number;
  selected?: boolean;
  hovered?: boolean;
  isPreview?: boolean;
  hidden?: boolean;
}

export interface LinePrimitiveOptions extends PrimitiveBaseOptions {
  lineType?: BasicLineToolId;
  dataPoints?: DrawingDataPoint[];
}

export interface AxisLinePrimitiveOptions extends PrimitiveBaseOptions {
  axisLineType?: AxisLineType;
  dataPoint?: DrawingDataPoint | null;
}

export interface AnglePrimitiveOptions extends PrimitiveBaseOptions {
  dataPoints?: DrawingDataPoint[];
}

export interface FibonacciPrimitiveOptions extends PrimitiveBaseOptions {
  dataPoints?: DrawingDataPoint[];
  levels?: FibonacciLevel[];
  inverted?: boolean;
}

export interface ShapePrimitiveOptions extends PrimitiveBaseOptions {
  shapeType?: ShapeType;
  dataPoints?: DrawingDataPoint[];
  fillColor?: string;
  fillOpacity?: number;
  lineStyle?: ShapeLineStyle;
}

export interface TextPrimitiveOptions extends PrimitiveBaseOptions {
  dataPoint?: DrawingDataPoint;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
  bgColor?: string | null;
  borderColor?: string | null;
  borderWidth?: number;
  widthPx?: number | null;
  padding?: number;
}

export interface TextDrawingPatch {
  text?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
  bgColor?: string | null;
  borderColor?: string | null;
  borderWidth?: number;
  widthPx?: number | null;
  padding?: number;
}

export interface PositionPrimitiveOptions extends PrimitiveBaseOptions {
  direction?: PositionDirection;
  entryPrice: number;
  tpPrice?: number | null;
  slPrice?: number | null;
  timeRange?: PositionTimeRange;
  positionSize?: number;
  infoPanelOffset?: PositionInfoPanelOffset | null;
}

export interface FreehandPrimitiveOptions extends PrimitiveBaseOptions {
  type?: FreehandKind;
  dataPoints?: DrawingDataPoint[];
  stroke?: FreehandStroke | unknown;
  previewPoints?: Array<ScreenPoint | null>;
  opacity?: number;
  compositeOperation?: GlobalCompositeOperation;
  brushShape?: BrushShape;
}

export type DrawingPrimitive =
  | LineDrawingPrimitive
  | AxisLineDrawingPrimitive
  | AngleMeasurementPrimitive
  | TextDrawingPrimitive
  | FibonacciDrawingPrimitive
  | PositionDrawingPrimitive
  | ShapeDrawingPrimitive
  | FreehandDrawingPrimitive;

interface PersistablePrimitiveBase {
  _id: string;
  _isPreview?: boolean;
}

export interface PersistableLinePrimitive extends PersistablePrimitiveBase {
  _lineType: BasicLineToolId;
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
}

export interface PersistableAxisLinePrimitive extends PersistablePrimitiveBase {
  _type: "axis-line";
  _axisLineType: AxisLineType;
  _dataPoint: DrawingDataPoint | null;
  _color: string;
  _lineWidth: number;
}

export interface PersistableAnglePrimitive extends PersistablePrimitiveBase {
  _type: "angle-measure";
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
}

export interface PersistableTextPrimitive extends PersistablePrimitiveBase {
  _text: string;
  _dataPoint: DrawingDataPoint;
  _color: string;
  _fontSize: number;
  _fontFamily: string;
  _bold: boolean;
  _italic: boolean;
  _underline: boolean;
  _align: TextAlign;
  _bgColor: string | null;
  _borderColor: string | null;
  _borderWidth: number;
  _widthPx: number | null;
  _padding: number;
}

export interface PersistableFibonacciPrimitive extends PersistablePrimitiveBase {
  _type: "fibonacci";
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
  _levels: FibonacciLevel[];
  _inverted: boolean;
}

export interface PersistablePositionPrimitive extends PersistablePrimitiveBase {
  _type: "position";
  _direction: PositionDirection;
  _entryPrice: number;
  _tpPrice: number | null;
  _slPrice: number | null;
  _timeRange: PositionTimeRange;
  _positionSize: number;
  _infoPanelOffset: PositionInfoPanelOffset | null;
}

export interface PersistableShapePrimitive extends PersistablePrimitiveBase {
  _type: "shape";
  _shapeType: ShapeType;
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
  _fillColor: string;
  _fillOpacity: number;
  _lineStyle: ShapeLineStyle;
}

export interface PersistableFreehandPrimitive extends PersistablePrimitiveBase {
  _type: FreehandKind;
  _stroke: unknown;
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
  _opacity?: number;
  _compositeOperation?: GlobalCompositeOperation;
  _brushShape?: BrushShape;
}

export type PersistableDrawingPrimitive =
  | PersistableLinePrimitive
  | PersistableAxisLinePrimitive
  | PersistableAnglePrimitive
  | PersistableTextPrimitive
  | PersistableFibonacciPrimitive
  | PersistablePositionPrimitive
  | PersistableShapePrimitive
  | PersistableFreehandPrimitive;

export type DrawingChartAdapter = ReturnType<typeof createLightweightChartAdapter>;
export type DrawingAttachedParameter = ChartSeriesAttachedParameter;
export type PrimitiveCanvasTarget = ChartPrimitiveCanvasTarget;
export type PrimitivePaneRenderer = ChartPrimitivePaneRenderer;
export type PrimitivePaneView = ChartPrimitivePaneView;

export interface DrawingHit {
  pointIndex?: number;
  zone?: string;
  handle?: string;
  body?: boolean;
}

export interface DrawingVariant {
  id?: DrawingToolId | null;
}

export type DrawingAnchorMode = ChartDrawingAnchorMode | null | undefined;

export interface PointerEventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

export interface DrawingPointerEvent extends PointerEventLike {
  altKey: boolean;
  shiftKey: boolean;
}

export interface DrawingCoordinateOptions {
  snap?: boolean;
  time?: boolean;
  price?: boolean;
}

export type ScreenToDrawingData = (
  x: number,
  y: number,
  options?: DrawingCoordinateOptions,
) => DrawingDataPoint | null;

export type DrawingDataToScreen = (dataPoint: DrawingDataPoint) => ScreenPoint | null;

export interface ActiveDrawingMovePayload extends Record<string, unknown> {
  tool?: DrawingToolId | null;
  pos?: ScreenPoint;
  positions?: ScreenPoint[];
  e?: PointerEventLike;
}
