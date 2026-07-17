/**
 * drawingStorage.js — Persist chart drawings to localStorage.
 *
 * Drawings are stored in data coordinates (time + price), which are
 * interval-independent, so callers should pass a stable chart-scope key
 * such as `spot:BTCUSDT` or `futures:BTCUSDT`.
 *
 * Storage key: `candlescope-drawings-{SYMBOL}`
 *
 * Each drawing is serialized as a plain JSON object:
 *   - type: "line" | "axis-line" | "angle-measure" | "freehand" | "highlighter" | "text" | "shape"
 *   - id, color, lineWidth, and type-specific fields
 *   - data coordinates (time + price) — NOT screen pixels
 */

import {
  normalizeFreehandStroke,
  normalizeLegacyFreehandDataPoints,
  normalizeSavedFreehandPayload,
} from "./freehandStrokeModel.js";
import {
  finiteNumber,
  hasOwn,
  isRecord,
  parseDrawingDataPoint,
  parseDrawingDataPoints,
  parsePositionInfoPanelOffset,
  parsePositionTimeRange,
  safeProjectionConfig,
  safeSourceOrdinal,
  safeSourceProjection,
} from "./drawingContracts.js";
import type { UnknownRecord } from "./drawingContracts.js";
import type {
  AxisLineType,
  BasicLineToolId,
  BrushShape,
  DrawingKind,
  FibonacciLevel,
  HorizontalDrawingAnchor,
  PersistableDrawingPrimitive,
  PersistableFreehandPrimitive,
  PositionDirection,
  SavedDrawing,
  SavedFreehandDrawing,
  SavedFreehandPayload,
  SavedHighlighterDrawing,
  ShapeLineStyle,
  ShapeType,
  TextAlign,
} from "./drawingTypes.js";

const STORAGE_PREFIX = "candlescope-drawings";
export const MAX_DRAWING_STORAGE_CHARS = 2_000_000;
export const MAX_SAVED_DRAWINGS = 512;
export const MAX_SAVED_FREEHAND_POINTS = 32_768;
export const MAX_SAVED_FREEHAND_SPANS = 16_384;

const SAVED_DRAWING_TYPES = new Set<DrawingKind>([
  "line",
  "axis-line",
  "angle-measure",
  "text",
  "fibonacci",
  "position",
  "shape",
  "freehand",
  "highlighter",
]);

function storageKey(symbol: string): string {
  return `${STORAGE_PREFIX}-${symbol}`;
}

function serializeHorizontalFields(source: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {};
  const time = source.time == null ? null : Number(source.time);
  const hasTime = time !== null && Number.isFinite(time);
  if (hasTime) out.time = time;

  const sourceOrdinal = hasTime ? safeSourceOrdinal(source.sourceOrdinal) : null;
  const sourceProjection = hasTime ? safeSourceProjection(source.sourceProjection) : null;
  const sourceProjectionConfig = hasTime
    ? safeProjectionConfig(source.sourceProjectionConfig)
    : null;
  if (sourceOrdinal !== null) out.sourceOrdinal = sourceOrdinal;
  if (sourceProjection !== null) out.sourceProjection = sourceProjection;
  if (sourceProjectionConfig !== null) out.sourceProjectionConfig = sourceProjectionConfig;

  // Logical positions are projection-local. Keep the legacy time-axis fallback,
  // but never persist it alongside a canonical ordinal source anchor.
  if (sourceOrdinal === null
    && sourceProjection === null
    && sourceProjectionConfig === null
    && typeof source.logical === "number"
    && Number.isFinite(source.logical)) {
    out.logical = source.logical;
  }
  return out;
}

export function serializeDataPoint(dataPoint: unknown): UnknownRecord {
  const source = isRecord(dataPoint) ? dataPoint : {};
  const out = serializeHorizontalFields(source);
  if (source.price != null && Number.isFinite(Number(source.price))) out.price = Number(source.price);
  return out;
}

function serializeDataPoints(points: readonly unknown[] | null | undefined): UnknownRecord[] {
  return (points || []).map(serializeDataPoint);
}

function optionalString(item: UnknownRecord, key: string, maxLength: number): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function optionalFiniteNumber(
  item: UnknownRecord,
  key: string,
  minimum = -Infinity,
  maximum = Infinity,
): number | undefined {
  const value = finiteNumber(item[key]);
  return value !== null && value >= minimum && value <= maximum ? value : undefined;
}

function optionalBoolean(item: UnknownRecord, key: string): boolean | undefined {
  return typeof item[key] === "boolean" ? item[key] : undefined;
}

function savedBase(item: UnknownRecord): { id?: string } {
  const id = optionalString(item, "id", 256);
  return id === undefined ? {} : { id };
}

function savedStyle(item: UnknownRecord): { color?: string; lineWidth?: number } {
  const color = optionalString(item, "color", 128);
  const lineWidth = optionalFiniteNumber(item, "lineWidth", Number.MIN_VALUE, 100);
  return {
    ...(color === undefined ? {} : { color }),
    ...(lineWidth === undefined ? {} : { lineWidth }),
  };
}

const BASIC_LINE_TYPES = new Set<BasicLineToolId>([
  "line-segment",
  "line-ray",
  "line-infinite",
]);
const AXIS_LINE_TYPES = new Set<AxisLineType>(["horizontal", "vertical", "cross"]);
const TEXT_ALIGNS = new Set<TextAlign>(["left", "center", "right"]);
const POSITION_DIRECTIONS = new Set<PositionDirection>(["long", "short"]);
const SHAPE_TYPES = new Set<ShapeType>(["rectangle", "ellipse"]);
const SHAPE_LINE_STYLES = new Set<ShapeLineStyle>(["solid", "dashed", "dotted"]);
const COMPOSITE_OPERATIONS = new Set<GlobalCompositeOperation>([
  "color",
  "color-burn",
  "color-dodge",
  "copy",
  "darken",
  "destination-atop",
  "destination-in",
  "destination-out",
  "destination-over",
  "difference",
  "exclusion",
  "hard-light",
  "hue",
  "lighten",
  "lighter",
  "luminosity",
  "multiply",
  "overlay",
  "saturation",
  "screen",
  "soft-light",
  "source-atop",
  "source-in",
  "source-out",
  "source-over",
  "xor",
]);

function normalizeFibonacciLevels(value: unknown): FibonacciLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: FibonacciLevel[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const level = finiteNumber(candidate.level);
    if (level === null || typeof candidate.color !== "string" || candidate.color.length > 128) {
      return null;
    }
    if (typeof candidate.enabled !== "boolean") return null;
    levels.push({ level, color: candidate.color, enabled: candidate.enabled });
  }
  return levels;
}

function normalizeSavedFreehandItem(
  item: UnknownRecord & { type: "freehand" | "highlighter" },
): SavedFreehandDrawing | SavedHighlighterDrawing | null {
  const payload = normalizeSavedFreehandPayload(item);
  if (!payload) return null;

  const common = { ...savedBase(item), ...savedStyle(item) };
  if (item.type === "freehand") return { type: "freehand", ...payload, ...common };

  const normalized: SavedHighlighterDrawing = { type: "highlighter", ...payload, ...common };
  if (item.type === "highlighter") {
    const opacity = optionalFiniteNumber(item, "opacity", 0, 1);
    if (opacity !== undefined) normalized.opacity = opacity;
    if (COMPOSITE_OPERATIONS.has(item.compositeOperation as GlobalCompositeOperation)) {
      normalized.compositeOperation = item.compositeOperation as GlobalCompositeOperation;
    }
    if (item.brushShape === "round" || item.brushShape === "square") {
      normalized.brushShape = item.brushShape;
    }
  }
  return normalized;
}

export function normalizeSavedDrawingItem(item: unknown): SavedDrawing | null {
  if (!isRecord(item) || typeof item.type !== "string") return null;
  if (!SAVED_DRAWING_TYPES.has(item.type as DrawingKind)) return null;
  if (item.type === "freehand" || item.type === "highlighter") {
    return normalizeSavedFreehandItem({ ...item, type: item.type });
  }
  if (hasOwn(item, "stroke")) return null;

  const base = savedBase(item);
  const style = savedStyle(item);
  switch (item.type) {
    case "line": {
      const dataPoints = hasOwn(item, "dataPoints")
        ? parseDrawingDataPoints(item.dataPoints)
        : undefined;
      if (dataPoints === null) return null;
      const lineType = BASIC_LINE_TYPES.has(item.lineType as BasicLineToolId)
        ? item.lineType as BasicLineToolId
        : undefined;
      return {
        type: "line",
        ...base,
        ...style,
        ...(lineType === undefined ? {} : { lineType }),
        ...(dataPoints === undefined ? {} : { dataPoints }),
      };
    }
    case "axis-line": {
      const dataPoint = hasOwn(item, "dataPoint")
        ? parseDrawingDataPoint(item.dataPoint)
        : undefined;
      if (dataPoint === null) return null;
      const axisLineType = AXIS_LINE_TYPES.has(item.axisLineType as AxisLineType)
        ? item.axisLineType as AxisLineType
        : undefined;
      return {
        type: "axis-line",
        ...base,
        ...style,
        ...(axisLineType === undefined ? {} : { axisLineType }),
        ...(dataPoint === undefined ? {} : { dataPoint }),
      };
    }
    case "angle-measure": {
      const dataPoints = hasOwn(item, "dataPoints")
        ? parseDrawingDataPoints(item.dataPoints)
        : undefined;
      if (dataPoints === null) return null;
      return {
        type: "angle-measure",
        ...base,
        ...style,
        ...(dataPoints === undefined ? {} : { dataPoints }),
      };
    }
    case "text": {
      const dataPoint = hasOwn(item, "dataPoint")
        ? parseDrawingDataPoint(item.dataPoint)
        : undefined;
      if (dataPoint === null) return null;
      const align = TEXT_ALIGNS.has(item.align as TextAlign) ? item.align as TextAlign : undefined;
      const bgColor = item.bgColor === null ? null : optionalString(item, "bgColor", 128);
      const borderColor = item.borderColor === null
        ? null
        : optionalString(item, "borderColor", 128);
      const widthPx = item.widthPx === null
        ? null
        : optionalFiniteNumber(item, "widthPx", 0);
      const text = optionalString(item, "text", MAX_DRAWING_STORAGE_CHARS);
      const fontSize = optionalFiniteNumber(item, "fontSize", 1, 512);
      const fontFamily = optionalString(item, "fontFamily", 512);
      const bold = optionalBoolean(item, "bold");
      const italic = optionalBoolean(item, "italic");
      const underline = optionalBoolean(item, "underline");
      const borderWidth = optionalFiniteNumber(item, "borderWidth", 0, 100);
      const padding = optionalFiniteNumber(item, "padding", 0, 512);
      return {
        type: "text",
        ...base,
        ...style,
        ...(dataPoint === undefined ? {} : { dataPoint }),
        ...(text === undefined ? {} : { text }),
        ...(fontSize === undefined ? {} : { fontSize }),
        ...(fontFamily === undefined ? {} : { fontFamily }),
        ...(bold === undefined ? {} : { bold }),
        ...(italic === undefined ? {} : { italic }),
        ...(underline === undefined ? {} : { underline }),
        ...(align === undefined ? {} : { align }),
        ...(bgColor === undefined ? {} : { bgColor }),
        ...(borderColor === undefined ? {} : { borderColor }),
        ...(borderWidth === undefined ? {} : { borderWidth }),
        ...(widthPx === undefined ? {} : { widthPx }),
        ...(padding === undefined ? {} : { padding }),
      };
    }
    case "fibonacci": {
      const dataPoints = hasOwn(item, "dataPoints")
        ? parseDrawingDataPoints(item.dataPoints)
        : undefined;
      if (dataPoints === null) return null;
      const levels = hasOwn(item, "levels") ? normalizeFibonacciLevels(item.levels) : undefined;
      if (levels === null) return null;
      const inverted = optionalBoolean(item, "inverted");
      return {
        type: "fibonacci",
        ...base,
        ...style,
        ...(dataPoints === undefined ? {} : { dataPoints }),
        ...(levels === undefined ? {} : { levels }),
        ...(inverted === undefined ? {} : { inverted }),
      };
    }
    case "position": {
      const timeRange = item.timeRange === undefined
        ? undefined
        : hasOwn(item, "timeRange")
        ? parsePositionTimeRange(item.timeRange)
        : undefined;
      if (timeRange === null) return null;
      const infoPanelOffset = item.infoPanelOffset === undefined
        ? undefined
        : hasOwn(item, "infoPanelOffset")
        ? parsePositionInfoPanelOffset(item.infoPanelOffset)
        : undefined;
      if (infoPanelOffset === null) return null;
      const direction = POSITION_DIRECTIONS.has(item.direction as PositionDirection)
        ? item.direction as PositionDirection
        : undefined;
      const entryPrice = optionalFiniteNumber(item, "entryPrice");
      const tpPrice = item.tpPrice === null ? null : optionalFiniteNumber(item, "tpPrice");
      const slPrice = item.slPrice === null ? null : optionalFiniteNumber(item, "slPrice");
      const positionSize = optionalFiniteNumber(item, "positionSize", 0);
      return {
        type: "position",
        ...base,
        ...(direction === undefined ? {} : { direction }),
        ...(entryPrice === undefined ? {} : { entryPrice }),
        ...(tpPrice === undefined ? {} : { tpPrice }),
        ...(slPrice === undefined ? {} : { slPrice }),
        ...(timeRange === undefined ? {} : { timeRange }),
        ...(positionSize === undefined ? {} : { positionSize }),
        ...(infoPanelOffset === undefined ? {} : { infoPanelOffset }),
      };
    }
    case "shape": {
      const dataPoints = hasOwn(item, "dataPoints")
        ? parseDrawingDataPoints(item.dataPoints)
        : undefined;
      if (dataPoints === null) return null;
      const shapeType = SHAPE_TYPES.has(item.shapeType as ShapeType)
        ? item.shapeType as ShapeType
        : undefined;
      const lineStyle = SHAPE_LINE_STYLES.has(item.lineStyle as ShapeLineStyle)
        ? item.lineStyle as ShapeLineStyle
        : undefined;
      const fillColor = optionalString(item, "fillColor", 128);
      const fillOpacity = optionalFiniteNumber(item, "fillOpacity", 0, 1);
      return {
        type: "shape",
        ...base,
        ...style,
        ...(shapeType === undefined ? {} : { shapeType }),
        ...(dataPoints === undefined ? {} : { dataPoints }),
        ...(fillColor === undefined ? {} : { fillColor }),
        ...(fillOpacity === undefined ? {} : { fillOpacity }),
        ...(lineStyle === undefined ? {} : { lineStyle }),
      };
    }
    default:
      return null;
  }
}

function freehandPayloadCounts(item: SavedDrawing): { points: number; spans: number } {
  if (item.type !== "freehand" && item.type !== "highlighter") {
    return { points: 0, spans: 0 };
  }
  if (item.stroke !== undefined) {
    return {
      points: item.stroke.points.length,
      spans: item.stroke.spans.length,
    };
  }
  return { points: item.dataPoints?.length ?? 0, spans: 0 };
}

function declaredFreehandPayloadCounts(item: unknown): { points: number; spans: number } {
  if (!isRecord(item)
    || (item.type !== "freehand" && item.type !== "highlighter")) {
    return { points: 0, spans: 0 };
  }
  const legacyPoints = Array.isArray(item.dataPoints) ? item.dataPoints.length : 0;
  const stroke = isRecord(item.stroke) ? item.stroke : null;
  const strokePoints = Array.isArray(stroke?.points) ? stroke.points.length : 0;
  const strokeSpans = Array.isArray(stroke?.spans) ? stroke.spans.length : 0;
  return {
    points: legacyPoints + strokePoints,
    spans: strokeSpans,
  };
}

function normalizeSavedDrawingArray(value: unknown): SavedDrawing[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED_DRAWINGS) return [];

  let totalPoints = 0;
  let totalSpans = 0;
  for (const item of value) {
    const counts = declaredFreehandPayloadCounts(item);
    totalPoints += counts.points;
    totalSpans += counts.spans;
    if (totalPoints > MAX_SAVED_FREEHAND_POINTS
      || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
      return [];
    }
  }

  const drawings: SavedDrawing[] = [];
  for (const item of value) {
    const normalized = normalizeSavedDrawingItem(item);
    if (!normalized) continue;
    drawings.push(normalized);
  }
  return drawings;
}

function readSavedDrawingArray(symbol: string, warnOnError = false): SavedDrawing[] {
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return [];
    if (raw.length > MAX_DRAWING_STORAGE_CHARS) {
      if (warnOnError) console.warn("Failed to load drawings: stored payload is too large");
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return normalizeSavedDrawingArray(parsed);
  } catch (err) {
    if (warnOnError) console.warn("Failed to load drawings:", err);
    return [];
  }
}

function serializeFreehandPayload(prim: PersistableFreehandPrimitive): SavedFreehandPayload | null {
  if (prim._stroke != null) {
    const stroke = normalizeFreehandStroke(prim._stroke);
    return stroke ? { stroke } : null;
  }
  const dataPoints = normalizeLegacyFreehandDataPoints(prim._dataPoints);
  return dataPoints ? { dataPoints } : null;
}

export function serializeHorizontalAnchor(
  anchor: unknown,
): HorizontalDrawingAnchor | UnknownRecord | null {
  if (anchor == null) return null;
  if (typeof anchor === "number" && Number.isFinite(anchor)) return anchor;
  if (!isRecord(anchor)) return null;
  const out = serializeHorizontalFields(anchor);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Serialize a primitive instance to a plain JSON-safe object.
 */
function serializePrimitiveFields(prim: PersistableDrawingPrimitive): UnknownRecord | null {
  // Detect type by checking unique properties
  if ("_lineType" in prim) {
    // LineDrawingPrimitive
    return {
      type: "line",
      id: prim._id,
      lineType: prim._lineType,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  if ("_type" in prim && prim._type === "axis-line") {
    return {
      type: "axis-line",
      id: prim._id,
      axisLineType: prim._axisLineType,
      dataPoint: serializeDataPoint(prim._dataPoint),
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  if ("_type" in prim && prim._type === "angle-measure") {
    return {
      type: "angle-measure",
      id: prim._id,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  if ("_text" in prim) {
    // TextDrawingPrimitive
    return {
      type: "text",
      id: prim._id,
      dataPoint: serializeDataPoint(prim._dataPoint),
      text: prim._text,
      color: prim._color,
      fontSize: prim._fontSize,
      fontFamily: prim._fontFamily,
      bold: prim._bold,
      italic: prim._italic,
      // ── Extended fields (PPT-style text box) ──
      underline: prim._underline,
      align: prim._align,
      bgColor: prim._bgColor,
      borderColor: prim._borderColor,
      borderWidth: prim._borderWidth,
      widthPx: prim._widthPx,
      padding: prim._padding,
    };
  }

  if ("_type" in prim && prim._type === "fibonacci") {
    return {
      type: "fibonacci",
      id: prim._id,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
      levels: prim._levels,
      inverted: prim._inverted || false,
    };
  }

  if ("_type" in prim && prim._type === "position") {
    return {
      type: "position",
      id: prim._id,
      direction: prim._direction,
      entryPrice: prim._entryPrice,
      tpPrice: prim._tpPrice,
      slPrice: prim._slPrice,
      timeRange: {
        start: serializeHorizontalAnchor(prim._timeRange?.start),
        end: serializeHorizontalAnchor(prim._timeRange?.end),
      },
      positionSize: prim._positionSize,
      infoPanelOffset: prim._infoPanelOffset ? { ...prim._infoPanelOffset } : undefined,
    };
  }

  if ("_type" in prim && prim._type === "shape") {
    return {
      type: "shape",
      id: prim._id,
      shapeType: prim._shapeType,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
      fillColor: prim._fillColor,
      fillOpacity: prim._fillOpacity,
      lineStyle: prim._lineStyle,
    };
  }

  if ("_type" in prim && prim._type === "highlighter") {
    const payload = serializeFreehandPayload(prim);
    if (!payload) return null;
    return {
      type: "highlighter",
      id: prim._id,
      ...payload,
      color: prim._color,
      lineWidth: prim._lineWidth,
      opacity: prim._opacity,
      compositeOperation: prim._compositeOperation,
      brushShape: prim._brushShape,
    };
  }

  if ("_type" in prim && prim._type === "freehand") {
    const payload = serializeFreehandPayload(prim);
    if (!payload) return null;
    return {
      type: "freehand",
      id: prim._id,
      ...payload,
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  return null;
}

const STRICT_SAVED_FIELDS: Readonly<Record<DrawingKind, readonly string[]>> = Object.freeze({
  line: Object.freeze(["id", "lineType", "dataPoints", "color", "lineWidth"]),
  "axis-line": Object.freeze(["id", "axisLineType", "dataPoint", "color", "lineWidth"]),
  "angle-measure": Object.freeze(["id", "dataPoints", "color", "lineWidth"]),
  text: Object.freeze([
    "id", "dataPoint", "text", "color", "fontSize", "fontFamily", "bold", "italic",
    "underline", "align", "bgColor", "borderColor", "borderWidth", "widthPx", "padding",
  ]),
  fibonacci: Object.freeze(["id", "dataPoints", "levels", "inverted", "color", "lineWidth"]),
  position: Object.freeze([
    "id", "direction", "entryPrice", "tpPrice", "slPrice", "timeRange", "positionSize",
    "infoPanelOffset",
  ]),
  shape: Object.freeze([
    "id", "shapeType", "dataPoints", "color", "lineWidth", "fillColor", "fillOpacity",
    "lineStyle",
  ]),
  freehand: Object.freeze(["id", "dataPoints", "stroke", "color", "lineWidth"]),
  highlighter: Object.freeze([
    "id", "dataPoints", "stroke", "color", "lineWidth", "opacity", "compositeOperation",
    "brushShape",
  ]),
});

/**
 * Strict document/command boundary. The compatibility normalizer above may
 * omit an invalid optional legacy field so old tolerant reads can continue;
 * document authority must reject that same payload instead of silently
 * replacing explicit user data with a default.
 */
export function normalizeSavedDrawingItemStrict(item: unknown): SavedDrawing | null {
  const normalized = normalizeSavedDrawingItem(item);
  if (!normalized || !isRecord(item)) return null;
  if (hasOwn(item, "id") && item.id !== undefined
    && (typeof item.id !== "string" || item.id.length === 0)) return null;
  const normalizedRecord = normalized as unknown as UnknownRecord;
  for (const key of STRICT_SAVED_FIELDS[normalized.type]) {
    if (hasOwn(item, key) && item[key] !== undefined && !hasOwn(normalizedRecord, key)) {
      return null;
    }
  }
  return normalized;
}

/**
 * Convert one legacy primitive into the validated SavedDrawing contract.
 * The document codec and rollback renderer may use this compatibility edge
 * without taking a dependency on localStorage.
 */
export function serializeDrawingPrimitive(
  prim: PersistableDrawingPrimitive,
): SavedDrawing | null {
  const serialized = serializePrimitiveFields(prim);
  return serialized ? normalizeSavedDrawingItemStrict(serialized) : null;
}

function validatedSavedDrawingsForWrite(
  drawings: readonly unknown[],
): SavedDrawing[] | null {
  if (!Array.isArray(drawings) || drawings.length > MAX_SAVED_DRAWINGS) return null;

  const data: SavedDrawing[] = [];
  let totalPoints = 0;
  let totalSpans = 0;
  for (const drawing of drawings) {
    const item = normalizeSavedDrawingItemStrict(drawing);
    if (!item) return null;
    const counts = freehandPayloadCounts(item);
    totalPoints += counts.points;
    totalSpans += counts.spans;
    if (totalPoints > MAX_SAVED_FREEHAND_POINTS
      || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
      return null;
    }
    data.push(item);
  }
  return data;
}

/**
 * Read one complete legacy payload for the document-authoritative runtime.
 * Unlike the compatibility reader, this never skips an invalid entry: one
 * malformed, unknown, or over-budget item rejects the whole snapshot.
 */
export function loadSavedDrawingsFailClosed(symbol: string): SavedDrawing[] | null {
  if (!symbol) return [];
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return [];
    if (raw.length > MAX_DRAWING_STORAGE_CHARS) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_SAVED_DRAWINGS) return null;

    let totalDeclaredPoints = 0;
    let totalDeclaredSpans = 0;
    for (const item of parsed) {
      const counts = declaredFreehandPayloadCounts(item);
      totalDeclaredPoints += counts.points;
      totalDeclaredSpans += counts.spans;
      if (totalDeclaredPoints > MAX_SAVED_FREEHAND_POINTS
        || totalDeclaredSpans > MAX_SAVED_FREEHAND_SPANS) return null;
    }
    return validatedSavedDrawingsForWrite(parsed);
  } catch {
    return null;
  }
}

/**
 * Persist an already-decoded legacy-compatible SavedDrawing array.
 * This is the document codec's storage boundary; it deliberately retains the
 * existing key and top-level JSON-array format so the last legacy build can
 * read every successful write.
 */
export function saveSavedDrawings(
  symbol: string,
  drawings: readonly SavedDrawing[],
): boolean {
  if (!symbol) return false;
  try {
    const data = validatedSavedDrawingsForWrite(drawings);
    if (!data) {
      console.warn("Failed to save drawings: saved drawing payload is invalid or over budget");
      return false;
    }
    const raw = JSON.stringify(data);
    if (raw.length > MAX_DRAWING_STORAGE_CHARS) {
      console.warn("Failed to save drawings: serialized payload is too large");
      return false;
    }
    localStorage.setItem(storageKey(symbol), raw);
    return true;
  } catch (err) {
    console.warn("Failed to save drawings:", err);
    return false;
  }
}

/**
 * Save all current drawing primitives for a symbol.
 * @param {string} symbol - e.g. "BTCUSDT"
 * @param {Array} primitives - array of primitive instances
 */
export function saveDrawings(
  symbol: string,
  primitives: readonly PersistableDrawingPrimitive[],
): void {
  if (!symbol) return;
  try {
    // Filter out preview primitives
    const candidates = primitives
      .filter((p) => p._id !== "__preview__" && !p._isPreview);
    if (candidates.length > MAX_SAVED_DRAWINGS) {
      console.warn("Failed to save drawings: drawing count exceeds the storage limit");
      return;
    }

    const data: SavedDrawing[] = [];
    for (const prim of candidates) {
      const item = serializeDrawingPrimitive(prim);
      if (!item) {
        console.warn("Failed to save drawings: a drawing could not be serialized");
        return;
      }
      data.push(item);
    }
    saveSavedDrawings(symbol, data);
  } catch (err) {
    console.warn("Failed to save drawings:", err);
  }
}

/**
 * Load saved drawing data for a symbol.
 * Returns an array of plain objects (not primitive instances).
 * The caller (useDrawing) is responsible for re-creating primitive instances.
 *
 * @param {string} symbol - e.g. "BTCUSDT"
 * @returns {Array} serialized drawing objects
 */
export function loadDrawings(symbol: string): SavedDrawing[] {
  if (!symbol) return [];
  return readSavedDrawingArray(symbol, true);
}

/**
 * Return true when a symbol/pane key has persisted drawings.
 * This intentionally avoids importing primitive classes so callers can use it
 * before the real drawing engine is loaded.
 *
 * @param {string} symbol
 * @returns {boolean}
 */
export function hasSavedDrawings(symbol: string): boolean {
  if (!symbol) return false;
  return readSavedDrawingArray(symbol).length > 0;
}

/**
 * Clear all saved drawings for a symbol.
 * @param {string} symbol
 */
export function clearSavedDrawings(symbol: string): void {
  if (!symbol) return;
  try {
    localStorage.removeItem(storageKey(symbol));
  } catch {
    // ignore
  }
}
