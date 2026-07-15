import type { DrawingEntity } from "../core/drawingDocument.js";
import {
  normalizeFreehandStroke,
  normalizeLegacyFreehandDataPoints,
} from "../freehandStrokeModel.js";
import type {
  AxisLineType,
  BasicLineToolId,
  BrushShape,
  DrawingDataPoint,
  DrawingKind,
  FibonacciLevel,
  FreehandStroke,
  HorizontalDrawingAnchor,
  PositionDirection,
  PositionInfoPanelOffset,
  PositionTimeRange,
  ShapeLineStyle,
  ShapeType,
  TextAlign,
} from "../drawingTypes.js";

export const DEFAULT_DRAWING_RENDER_COLOR = "#f59e0b";
export const DEFAULT_DRAWING_RENDER_LINE_WIDTH = 2;
export const DEFAULT_FIBONACCI_RENDER_COLOR = "#0ea5e9";
export const DEFAULT_TEXT_RENDER_COLOR = "#e2e8f0";
export const DEFAULT_TEXT_RENDER_FONT_SIZE = 14;
export const DEFAULT_TEXT_RENDER_FONT_FAMILY = "'Inter', 'Segoe UI', sans-serif";
export const DEFAULT_SHAPE_RENDER_FILL_OPACITY = 0.12;
export const DEFAULT_POSITION_RENDER_SIZE = 1_000;
export const DEFAULT_HIGHLIGHTER_RENDER_OPACITY = 0.35;

export const DEFAULT_FIBONACCI_RENDER_LEVELS: readonly FibonacciLevel[] = Object.freeze([
  Object.freeze({ level: 0, color: "#787b86", enabled: true }),
  Object.freeze({ level: 0.236, color: "#f44336", enabled: true }),
  Object.freeze({ level: 0.382, color: "#81c784", enabled: true }),
  Object.freeze({ level: 0.5, color: "#4caf50", enabled: true }),
  Object.freeze({ level: 0.618, color: "#009688", enabled: true }),
  Object.freeze({ level: 0.786, color: "#64b5f6", enabled: true }),
  Object.freeze({ level: 1, color: "#787b86", enabled: true }),
  Object.freeze({ level: 1.272, color: "#e040fb", enabled: false }),
  Object.freeze({ level: 1.618, color: "#ff9800", enabled: false }),
  Object.freeze({ level: 2.618, color: "#ff5722", enabled: false }),
  Object.freeze({ level: 3.618, color: "#795548", enabled: false }),
  Object.freeze({ level: 4.236, color: "#607d8b", enabled: false }),
]);

interface DrawingRenderEntityBase<TKind extends DrawingKind, TGeometry, TStyle> {
  readonly id: string;
  readonly kind: TKind;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly geometry: Readonly<TGeometry>;
  readonly style: Readonly<TStyle>;
}

export type LineDrawingRenderEntity = DrawingRenderEntityBase<"line", {
  kind: "line";
  lineType: BasicLineToolId;
  dataPoints: readonly DrawingDataPoint[];
}, {
  kind: "line";
  color: string;
  lineWidth: number;
}>;

export type AxisLineDrawingRenderEntity = DrawingRenderEntityBase<"axis-line", {
  kind: "axis-line";
  axisLineType: AxisLineType;
  dataPoint: DrawingDataPoint | null;
}, {
  kind: "axis-line";
  color: string;
  lineWidth: number;
}>;

export type AngleDrawingRenderEntity = DrawingRenderEntityBase<"angle-measure", {
  kind: "angle-measure";
  dataPoints: readonly DrawingDataPoint[];
}, {
  kind: "angle-measure";
  color: string;
  lineWidth: number;
}>;

export type TextDrawingRenderEntity = DrawingRenderEntityBase<"text", {
  kind: "text";
  dataPoint: DrawingDataPoint;
}, {
  kind: "text";
  text: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  bgColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  widthPx: number | null;
  padding: number;
}>;

export type FibonacciDrawingRenderEntity = DrawingRenderEntityBase<"fibonacci", {
  kind: "fibonacci";
  dataPoints: readonly DrawingDataPoint[];
  inverted: boolean;
}, {
  kind: "fibonacci";
  color: string;
  lineWidth: number;
  levels: readonly FibonacciLevel[];
}>;

export type PositionDrawingRenderEntity = DrawingRenderEntityBase<"position", {
  kind: "position";
  direction: PositionDirection;
  entryPrice: number;
  tpPrice: number | null;
  slPrice: number | null;
  timeRange: Readonly<PositionTimeRange>;
}, {
  kind: "position";
  positionSize: number;
  infoPanelOffset: Readonly<PositionInfoPanelOffset>;
}>;

export type ShapeDrawingRenderEntity = DrawingRenderEntityBase<"shape", {
  kind: "shape";
  shapeType: ShapeType;
  dataPoints: readonly DrawingDataPoint[];
}, {
  kind: "shape";
  color: string;
  lineWidth: number;
  fillColor: string;
  fillOpacity: number;
  lineStyle: ShapeLineStyle;
}>;

export type FreehandDrawingRenderEntity = DrawingRenderEntityBase<"freehand" | "highlighter", {
  kind: "freehand" | "highlighter";
  dataPoints: readonly DrawingDataPoint[];
  stroke: FreehandStroke | null;
}, {
  kind: "freehand" | "highlighter";
  color: string;
  lineWidth: number;
  opacity: number;
  compositeOperation: GlobalCompositeOperation;
  brushShape: BrushShape;
}>;

export type DrawingRenderEntity =
  | LineDrawingRenderEntity
  | AxisLineDrawingRenderEntity
  | AngleDrawingRenderEntity
  | TextDrawingRenderEntity
  | FibonacciDrawingRenderEntity
  | PositionDrawingRenderEntity
  | ShapeDrawingRenderEntity
  | FreehandDrawingRenderEntity;

function cloneFrozen<T>(value: T): T {
  if (Array.isArray(value)) {
    const entries = value as readonly unknown[];
    return Object.freeze(entries.map((entry: unknown) => cloneFrozen(entry))) as unknown as T;
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) clone[key] = cloneFrozen(entry);
    return Object.freeze(clone) as T;
  }
  return value;
}

function renderBase<TKind extends DrawingKind>(entity: DrawingEntity, kind: TKind): {
  readonly id: string;
  readonly kind: TKind;
  readonly geometryRevision: number;
  readonly styleRevision: number;
} {
  return {
    id: entity.id,
    kind,
    geometryRevision: entity.geometryRevision,
    styleRevision: entity.styleRevision,
  };
}

function renderColor(value: string | undefined, fallback = DEFAULT_DRAWING_RENDER_COLOR): string {
  return value || fallback;
}

function renderLineWidth(value: number | undefined): number {
  return value || DEFAULT_DRAWING_RENDER_LINE_WIDTH;
}

function renderOpacity(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeHorizontalAnchorForRender(
  anchor: HorizontalDrawingAnchor | null | undefined,
): HorizontalDrawingAnchor | null {
  if (typeof anchor === "number") {
    return Number.isFinite(anchor) ? Object.freeze({ time: anchor }) : null;
  }
  return anchor ? cloneFrozen(anchor) : null;
}

function normalizePositionTimeRangeForRender(
  range: PositionTimeRange | undefined,
): Readonly<PositionTimeRange> {
  const start = normalizeHorizontalAnchorForRender(range?.start);
  const end = normalizeHorizontalAnchorForRender(range?.end);
  return start && end
    ? Object.freeze({ start, end })
    : Object.freeze({ start: null, end: null });
}

function normalizePositionOffsetForRender(
  offset: PositionInfoPanelOffset | null | undefined,
): Readonly<PositionInfoPanelOffset> {
  const x = Number(offset?.x);
  const y = Number(offset?.y);
  return Object.freeze({
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  });
}

function normalizeFreehandForRender(entity: DrawingEntity): FreehandDrawingRenderEntity | null {
  if ((entity.geometry.kind !== "freehand" && entity.geometry.kind !== "highlighter")
    || (entity.style.kind !== "freehand" && entity.style.kind !== "highlighter")
    || entity.geometry.kind !== entity.style.kind) return null;
  const kind = entity.geometry.kind;
  let dataPoints: readonly DrawingDataPoint[] = Object.freeze([]);
  let stroke: FreehandStroke | null = null;
  if (entity.geometry.stroke !== undefined) {
    const normalized = normalizeFreehandStroke(entity.geometry.stroke);
    if (!normalized) return null;
    stroke = cloneFrozen(normalized);
  } else {
    const normalized = normalizeLegacyFreehandDataPoints(entity.geometry.dataPoints);
    if (!normalized) return null;
    dataPoints = cloneFrozen(normalized);
  }
  const highlighter = kind === "highlighter";
  const highlighterStyle = entity.style.kind === "highlighter" ? entity.style : null;
  const opacity = highlighter
    ? renderOpacity(highlighterStyle?.opacity, DEFAULT_HIGHLIGHTER_RENDER_OPACITY)
    : 1;
  const compositeFallback: GlobalCompositeOperation = highlighter ? "multiply" : "source-over";
  const brushFallback: BrushShape = highlighter ? "square" : "round";
  const brushShape = highlighterStyle?.brushShape ?? brushFallback;
  return Object.freeze({
    ...renderBase(entity, kind),
    geometry: Object.freeze({ kind, dataPoints, stroke }),
    style: Object.freeze({
      kind,
      color: renderColor(entity.style.color),
      lineWidth: renderLineWidth(entity.style.lineWidth),
      opacity,
      compositeOperation: highlighterStyle?.compositeOperation || compositeFallback,
      brushShape,
    }),
  });
}

/**
 * Materialize every renderer default without changing the canonical entity.
 * Null means the canonical payload is not renderable by the current legacy
 * contract (notably a position without entryPrice or a freehand without a
 * valid stroke/dataPoints payload).
 */
export function normalizeDrawingEntityForRender(
  entity: DrawingEntity,
): DrawingRenderEntity | null {
  const geometry = entity.geometry;
  const style = entity.style;
  switch (geometry.kind) {
    case "line":
      if (entity.kind !== "line" || style.kind !== "line") return null;
      return Object.freeze({
        ...renderBase(entity, "line"),
        geometry: Object.freeze({
          kind: "line" as const,
          lineType: geometry.lineType ?? "line-segment",
          dataPoints: cloneFrozen(geometry.dataPoints ?? []),
        }),
        style: Object.freeze({
          kind: "line" as const,
          color: renderColor(style.color),
          lineWidth: renderLineWidth(style.lineWidth),
        }),
      });
    case "axis-line":
      if (entity.kind !== "axis-line" || style.kind !== "axis-line") return null;
      return Object.freeze({
        ...renderBase(entity, "axis-line"),
        geometry: Object.freeze({
          kind: "axis-line" as const,
          axisLineType: geometry.axisLineType === "vertical" || geometry.axisLineType === "cross"
            ? geometry.axisLineType
            : "horizontal",
          dataPoint: geometry.dataPoint ? cloneFrozen(geometry.dataPoint) : null,
        }),
        style: Object.freeze({
          kind: "axis-line" as const,
          color: renderColor(style.color),
          lineWidth: renderLineWidth(style.lineWidth),
        }),
      });
    case "angle-measure":
      if (entity.kind !== "angle-measure" || style.kind !== "angle-measure") return null;
      return Object.freeze({
        ...renderBase(entity, "angle-measure"),
        geometry: Object.freeze({
          kind: "angle-measure" as const,
          dataPoints: cloneFrozen(geometry.dataPoints ?? []),
        }),
        style: Object.freeze({
          kind: "angle-measure" as const,
          color: renderColor(style.color),
          lineWidth: renderLineWidth(style.lineWidth),
        }),
      });
    case "text":
      if (entity.kind !== "text" || style.kind !== "text") return null;
      return Object.freeze({
        ...renderBase(entity, "text"),
        geometry: Object.freeze({
          kind: "text" as const,
          dataPoint: geometry.dataPoint
            ? cloneFrozen(geometry.dataPoint)
            : Object.freeze({ logical: 0, price: 0 }),
        }),
        style: Object.freeze({
          kind: "text" as const,
          text: style.text ?? "Text",
          color: renderColor(style.color, DEFAULT_TEXT_RENDER_COLOR),
          fontSize: style.fontSize || DEFAULT_TEXT_RENDER_FONT_SIZE,
          fontFamily: style.fontFamily || DEFAULT_TEXT_RENDER_FONT_FAMILY,
          bold: !!style.bold,
          italic: !!style.italic,
          underline: !!style.underline,
          align: style.align || "left",
          bgColor: style.bgColor === undefined ? null : style.bgColor,
          borderColor: style.borderColor === undefined ? null : style.borderColor,
          borderWidth: style.borderWidth ?? 1,
          widthPx: style.widthPx != null && Number.isFinite(style.widthPx) ? style.widthPx : null,
          padding: style.padding ?? 6,
        }),
      });
    case "fibonacci":
      if (entity.kind !== "fibonacci" || style.kind !== "fibonacci") return null;
      return Object.freeze({
        ...renderBase(entity, "fibonacci"),
        geometry: Object.freeze({
          kind: "fibonacci" as const,
          dataPoints: cloneFrozen(geometry.dataPoints ?? []),
          inverted: geometry.inverted || false,
        }),
        style: Object.freeze({
          kind: "fibonacci" as const,
          color: renderColor(style.color, DEFAULT_FIBONACCI_RENDER_COLOR),
          lineWidth: renderLineWidth(style.lineWidth),
          levels: cloneFrozen(style.levels || DEFAULT_FIBONACCI_RENDER_LEVELS),
        }),
      });
    case "position":
      if (entity.kind !== "position" || style.kind !== "position"
        || typeof geometry.entryPrice !== "number" || !Number.isFinite(geometry.entryPrice)) {
        return null;
      }
      return Object.freeze({
        ...renderBase(entity, "position"),
        geometry: Object.freeze({
          kind: "position" as const,
          direction: geometry.direction || "long",
          entryPrice: geometry.entryPrice,
          tpPrice: geometry.tpPrice ?? null,
          slPrice: geometry.slPrice ?? null,
          timeRange: normalizePositionTimeRangeForRender(geometry.timeRange),
        }),
        style: Object.freeze({
          kind: "position" as const,
          positionSize: style.positionSize || DEFAULT_POSITION_RENDER_SIZE,
          infoPanelOffset: normalizePositionOffsetForRender(style.infoPanelOffset),
        }),
      });
    case "shape": {
      if (entity.kind !== "shape" || style.kind !== "shape") return null;
      const color = renderColor(style.color);
      return Object.freeze({
        ...renderBase(entity, "shape"),
        geometry: Object.freeze({
          kind: "shape" as const,
          shapeType: geometry.shapeType === "ellipse" ? "ellipse" : "rectangle",
          dataPoints: cloneFrozen(geometry.dataPoints ?? []),
        }),
        style: Object.freeze({
          kind: "shape" as const,
          color,
          lineWidth: renderLineWidth(style.lineWidth),
          fillColor: style.fillColor || color,
          fillOpacity: renderOpacity(style.fillOpacity, DEFAULT_SHAPE_RENDER_FILL_OPACITY),
          lineStyle: style.lineStyle || "solid",
        }),
      });
    }
    case "freehand":
    case "highlighter":
      return normalizeFreehandForRender(entity);
  }
}
